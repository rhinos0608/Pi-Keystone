// GoalRecord CRUD backed by atomic JSON file persistence.
// Uses stdlib fs — no external deps. Atomic write via tmp+rename.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GoalRecord, GoalId, GoalEvent, GoalState, AssignmentId, AssignmentState, RunStatus, ArtifactRef } from "../domain/types.js";
import { validateTransition, isExecutionFrontierTerminal, isTerminalState } from "../domain/goal-record.js";
import { withLock } from "./directory-lock.js";

export type GoalReducer = (event: GoalEvent, record: GoalRecord) => GoalRecord;

/** Compare-and-swap options for writes. */
export type UpdateOptions = {
  /** Reject the write unless the stored recordVersion matches. */
  expectedVersion?: number;
};

/** True when the reducer changed nothing but volatile write metadata. */
function isNoOp(existing: GoalRecord, updated: GoalRecord): boolean {
  const strip = (r: GoalRecord): string => {
    const { updatedAt: _u, recordVersion: _v, lastTransitionId: _t, ...rest } = r;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(rest).sort()) ordered[key] = (rest as Record<string, unknown>)[key];
    return JSON.stringify(ordered);
  };
  return strip(existing) === strip(updated);
}

// ─── Typed store errors (Task 1) ────────────────────────────────────────────

/** Stale compare-and-swap: expected recordVersion does not match stored. */
export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT" as const;
  readonly goalId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(goalId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Version conflict for goal ${goalId}: expected ${expectedVersion}, stored ${actualVersion}`,
    );
    this.name = "VersionConflictError";
    this.goalId = goalId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Stored JSON is unreadable: parse failure, schema mismatch, or IO error. */
export class StoreCorruptionError extends Error {
  readonly code = "STORE_CORRUPTION" as const;
  readonly goalId: string;
  constructor(goalId: string, reason: string) {
    super(`Stored goal ${goalId} is corrupt: ${reason}`);
    this.name = "StoreCorruptionError";
    this.goalId = goalId;
  }
}

/** Event applied cleanly but changed nothing: no transition, no data change. */
export class IgnoredEventError extends Error {
  readonly code = "IGNORED_EVENT" as const;
  readonly eventType: string;
  constructor(eventType: string, reason: string) {
    super(`Event ${eventType} ignored: ${reason}`);
    this.name = "IgnoredEventError";
    this.eventType = eventType;
  }
}

/** Reducer produced a state change the transition table forbids. */
export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION" as const;
  constructor(reason: string) {
    super(`Invalid transition: ${reason}`);
    this.name = "InvalidTransitionError";
  }
}

/** create() refused: a goal file already exists for this id (no clobber). */
export class GoalExistsError extends Error {
  readonly code = "GOAL_EXISTS" as const;
  readonly goalId: string;
  constructor(goalId: string) {
    super(`Goal ${goalId} already exists`);
    this.name = "GoalExistsError";
    this.goalId = goalId;
  }
}

/** Default reducer: applies event to record, returns updated record. */
export function goalReducer(event: GoalEvent, record: GoalRecord): GoalRecord {
  const now = new Date().toISOString() as GoalRecord["updatedAt"];
  const base = { ...record, updatedAt: now };

  const result = applyGoalEvent(event, record, base, now);

  // Defense in depth: invalid state changes are loud. Throwing here (rather
  // than silently returning the input) lets GoalStore.update surface a typed
  // InvalidTransitionError, distinct from IgnoredEventError for true no-ops.
  if (result.state !== record.state) {
    const validation = validateTransition(record.state, result.state);
    if (!validation.valid) {
      throw new InvalidTransitionError(validation.reason ?? "unknown reason");
    }
  }

  return result;
}

/**
 * Close the RUNNING run for an assignment as SUCCEEDED with its report ref.
 * Assignments with no tracked RUNNING run are left untouched (runs are
 * opened by the execution path, never fabricated by the reducer).
 */
function closeRun(
  record: GoalRecord,
  assignmentId: AssignmentId,
  status: RunStatus,
  resultRef: ArtifactRef | undefined,
  now: GoalRecord["updatedAt"],
): GoalRecord["activeRuns"] {
  const activeRuns = { ...record.activeRuns };
  const run = activeRuns[assignmentId];
  if (run && run.status === "RUNNING") {
    activeRuns[assignmentId] = {
      ...run,
      status,
      endedAt: now,
      ...(resultRef !== undefined ? { resultRef } : {}),
    };
  }
  return activeRuns;
}

function applyGoalEvent(event: GoalEvent, record: GoalRecord, base: GoalRecord, now: GoalRecord["updatedAt"]): GoalRecord {
  switch (event.type) {
    case "GoalStarted":
      if (record.state !== "CREATED") return base;
      return { ...base, state: "PREPARING" as GoalState };
    case "PreparedFlowStored":
      if (record.state !== "PREPARING" && record.state !== "PAUSED") return base;
      return {
        ...base,
        preparedFlowRef: event.flowRef,
        baselineRef: event.baselineRef,
        // A replaced prepared bundle may contain a different plan/contract.
        // Never carry user approval across that identity change.
        lifecycleDepth: null,
        depthProposalRef: null,
        depthApprovedAt: undefined,
        // Re-preparing a paused goal creates a new execution epoch and throws
        // away stale frontier/contract bookkeeping. The new prepared bundle is
        // walked through baseline + reconciliation again before execution.
        planEpoch: record.state === "PAUSED" ? record.planEpoch + 1 : record.planEpoch,
        contractVersion: record.state === "PAUSED" ? null : record.contractVersion,
        activeContractRef: record.state === "PAUSED" ? null : record.activeContractRef,
        executionPlan: record.state === "PAUSED" ? null : record.executionPlan,
        assignmentStates: record.state === "PAUSED" ? {} : record.assignmentStates,
        activeRuns: record.state === "PAUSED" ? {} : record.activeRuns,
        preparation: {
          baselineJob: {
            ...record.preparation.baselineJob,
            planEpoch: record.state === "PAUSED" ? record.planEpoch + 1 : record.planEpoch,
            attemptId: "",
            status: "PENDING",
            ref: undefined,
            errorRef: undefined,
          },
          provisionalPlanJob: {
            ...record.preparation.provisionalPlanJob,
            planEpoch: record.state === "PAUSED" ? record.planEpoch + 1 : record.planEpoch,
            attemptId: "",
            status: "PENDING",
            ref: undefined,
            errorRef: undefined,
          },
        },
      };
    case "LifecycleDepthApproved":
      if (record.state !== "PREPARING" && record.state !== "PAUSED") return base;
      return {
        ...base,
        lifecycleDepth: event.depth,
        depthProposalRef: event.proposalRef,
        depthApprovedAt: now,
      };
    case "ReconciliationCompleted": {
      if (record.state === "RECONCILING") {
        return {
          ...base,
          state: (event.decision === "BLOCK" ? "BLOCKED" : "CONTRACT_REVIEW") as GoalState,
          currentRevision: event.basedOnRevision,
        };
      }
      return base;
    }
    case "ContractFrozen":
      if (record.state !== "CONTRACT_REVIEW") return base;
      return { ...base, state: "READY" as GoalState, contractVersion: event.contractVersion, activeContractRef: event.contractRef };
    case "ExecutionStarted": {
      if (record.state !== "READY" && record.state !== "VERIFYING") return base;
      // Fresh execution attempt: reset per-assignment tracking. The DAG
      // payload (when present) becomes the required frontier: completions
      // during this execution repopulate assignmentStates, and the goal
      // advances to VERIFYING only via frontier-gated AssignmentCompleted.
      // Without a payload the frontier falls back to tracked assignments.
      // Dispatch boundary: every DAG assignment opens ACQUIRED +
      // a RUNNING RunRecord placeholder (runId pending-<id>: dispatched, no
      // live run bound yet) so closeRun on completion transitions a real
      // RUNNING entry instead of a vacuous no-op.
      const dag =
        event.assignments && event.assignments.length > 0
          ? event.assignments.map((a) => ({
              id: a.id,
              dependsOn: [...a.dependsOn],
            }))
          : null;
      const assignmentStates: GoalRecord["assignmentStates"] = {};
      const activeRuns: GoalRecord["activeRuns"] = {};
      if (dag) {
        for (const a of dag) {
          assignmentStates[a.id] = "ACQUIRED";
          activeRuns[a.id] = {
            runId: `pending-${String(a.id)}`,
            sessionId: "",
            status: "RUNNING",
            startedAt: now,
          };
        }
      }
      return {
        ...base,
        state: "EXECUTING" as GoalState,
        driverFenceCounter: event.driverFence,
        assignmentStates,
        activeRuns,
        repairVerificationPending: false,
        executionPlan:
          dag !== null
            ? {
                planEpoch: record.planEpoch,
                assignments: dag,
              }
            : null,
      };
    }
    case "AssignmentRunBound": {
      if (record.state !== "EXECUTING" && record.state !== "REPAIRING") return base;
      // Repair cycles may re-open an implementation assignment that is no
      // longer present in the last verifier-only execution frontier.
      if (record.state === "EXECUTING" && !record.assignmentStates[event.assignmentId]) return base;
      return {
        ...base,
        driverFenceCounter: event.driverFence,
        assignmentStates: {
          ...record.assignmentStates,
          [event.assignmentId]: "EXECUTING" as AssignmentState,
        },
        ...(record.state === "REPAIRING"
          ? { executionPlan: { planEpoch: record.planEpoch, assignments: [{ id: event.assignmentId, dependsOn: [] }] } }
          : {}),
        activeRuns: {
          ...record.activeRuns,
          [event.assignmentId]: {
            runId: event.runId,
            sessionId: event.sessionId,
            status: "RUNNING" as RunStatus,
            startedAt: now,
          },
        },
      };
    }
    case "AssignmentCompleted": {
      if (record.state !== "EXECUTING") return base;
      // Transitions only the named assignment. The goal leaves EXECUTING
      // only when every assignment in the current plan epoch's required
      // DAG frontier is terminal (COMPLETED/FAILED/CANCELLED).
      const assignmentStates = {
        ...record.assignmentStates,
        [event.assignmentId]: "COMPLETED" as AssignmentState,
      };
      const activeRuns = closeRun(record, event.assignmentId, "SUCCEEDED", event.reportRef, now);
      const next = { ...base, driverFenceCounter: event.driverFence, assignmentStates, activeRuns };
      const frontierDone = isExecutionFrontierTerminal({ ...record, assignmentStates });
      return { ...next, state: (frontierDone ? "VERIFYING" : "EXECUTING") as GoalState };
    }
    case "AssignmentFailed": {
      if (record.state !== "EXECUTING") return base;
      // Marks the named assignment FAILED (terminal for its slot) and
      // closes its RUNNING run. Same frontier gate as AssignmentCompleted:
      // a fully-terminal frontier still advances to VERIFYING, where
      // verification adjudicates the failure.
      const assignmentStates = {
        ...record.assignmentStates,
        [event.assignmentId]: "FAILED" as AssignmentState,
      };
      const activeRuns = closeRun(record, event.assignmentId, "FAILED", event.errorRef, now);
      const next = { ...base, driverFenceCounter: event.driverFence, assignmentStates, activeRuns };
      const frontierDone = isExecutionFrontierTerminal({ ...record, assignmentStates });
      return { ...next, state: (frontierDone ? "VERIFYING" : "EXECUTING") as GoalState };
    }
    case "VerificationCompleted":
      if (record.state !== "VERIFYING") return base;
      return {
        ...base,
        state: (event.accepted ? "REVIEWING" : "REPAIRING") as GoalState,
        repairReasonRef: event.accepted ? undefined : event.runRef,
        repairVerificationPending: false,
      };
    case "CompletionRecoveryRestarted":
      if (!["REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"].includes(record.state)) return base;
      return { ...base, state: "VERIFYING" as GoalState };
    case "ReviewCompleted":
      if (record.state !== "REVIEWING") return base;
      return { ...base, state: "ADJUDICATING" as GoalState, reviewCycles: record.reviewCycles + 1 };
    case "AdjudicationCompleted":
      if (record.state !== "ADJUDICATING") return base;
      return { ...base, state: "FINAL_AUDIT" as GoalState };
    case "RepairRequested":
      if (record.state !== "ADJUDICATING") return base;
      return { ...base, state: "REPAIRING" as GoalState, repairReasonRef: event.reasonRef, repairVerificationPending: false };
    case "LifecycleRerouted":
      if (event.to !== "COMPLETION_GATE") return base;
      if (record.state !== "REVIEWING" && record.state !== "ADJUDICATING") return base;
      return { ...base, state: "COMPLETION_GATE" as GoalState, lifecycleDepth: event.depth };
    case "RepairCompleted": {
      if (record.state !== "REPAIRING") return base;
      const assignmentStates = {
        ...record.assignmentStates,
        [event.assignmentId]: "COMPLETED" as AssignmentState,
      };
      const activeRuns = closeRun(record, event.assignmentId, "SUCCEEDED", event.reportRef, now);
      const next = {
        ...base,
        driverFenceCounter: event.driverFence,
        assignmentStates,
        activeRuns,
        repairCycles: record.repairCycles + 1,
        repairReasonRef: undefined,
        repairVerificationPending: true,
      };
      // Frontier gate: stay REPAIRING until every frontier assignment is
      // terminal; only then re-enter VERIFYING.
      const frontierDone = isExecutionFrontierTerminal({ ...record, assignmentStates });
      return { ...next, state: (frontierDone ? "VERIFYING" : "REPAIRING") as GoalState };
    }
    case "MutationLeaseAttached":
      // New write authority is only meaningful while an implementation or
      // repair is actively allowed to run. In particular, never attach a
      // lease after a concurrent PauseRequested/CancelRequested moved the
      // durable goal out of an execution state.
      if (record.state !== "EXECUTING" && record.state !== "REPAIRING") return base;
      return {
        ...base,
        activeMutationLease: { ...event.lease },
        mutationFenceCounter: Math.max(record.mutationFenceCounter, event.lease.fencingToken),
      };
    case "MutationLeaseReleased":
      if (!record.activeMutationLease || record.activeMutationLease.leaseId !== event.leaseId) return base;
      return { ...base, activeMutationLease: undefined };
    case "DriverLeaseAcquired":
      // Persist the driver lease + fence counter. No GoalState change: this
      // is infrastructure bookkeeping so validateFencedEvent sees the lease.
      return {
        ...base,
        activeDriverLease: { ...event.lease },
        driverFenceCounter: event.fenceCounter,
      };
    case "DriverLeaseReleased":
      return { ...base, activeDriverLease: undefined };
    case "FinalAuditCompleted":
      if (record.state !== "FINAL_AUDIT") return base;
      return {
        ...base,
        state: (event.accepted ? "COMPLETION_GATE" : "ADJUDICATING") as GoalState,
        finalAuditAttempts: record.finalAuditAttempts + 1,
      };
    case "CompletionEvaluated":
      if (record.state !== "COMPLETION_GATE") return base;
      return {
        ...base,
        state: (event.accepted ? "DONE" : "REPAIRING") as GoalState,
        terminalReportRef: event.accepted ? event.reportRef : base.terminalReportRef,
        repairReasonRef: event.accepted ? undefined : event.reportRef,
        repairVerificationPending: false,
      };
    case "PauseRequested":
      if (isTerminalState(record.state) || record.state === "CANCELLING") return base;
      return { ...base, state: "PAUSED" as GoalState, resumeState: record.state as GoalRecord["resumeState"], pauseReason: event.reason, pausedAt: now };
    case "ResumeRequested": {
      if (record.state !== "PAUSED") return base;
      // PAUSED only allows → RECONCILING, CANCELLING, FAILED
      const { resumeState: _, pauseReason: _p, pausedAt: _a, ...rest } = base;
      return { ...rest, state: "RECONCILING" as GoalState };
    }
    case "CancelRequested":
      if (isTerminalState(record.state) || record.state === "CANCELLING") return base;
      return { ...base, state: "CANCELLING" as GoalState, cancellationRequestedAt: now, cancellationReason: event.reason };
    case "CancellationSettled":
      if (record.state !== "CANCELLING") return base;
      // INDETERMINATE is explicitly not proof of settlement or rollback.
      // Keep the goal quarantined in CANCELLING and mark recovery required;
      // only evidenced SETTLED/ROLLED_BACK outcomes may terminalize it.
      if (event.mutationOutcome === "INDETERMINATE") {
        return { ...base, recoveryRequired: true, terminalReportRef: event.cleanupRef };
      }
      return {
        ...base,
        state: "CANCELLED" as GoalState,
        recoveryRequired: false,
        terminalReportRef: event.cleanupRef,
      };
    case "FatalError":
      if (isTerminalState(record.state)) return base;
      return { ...base, state: "FAILED" as GoalState, terminalReportRef: event.errorRef };
    case "BlockDeclared":
      if (isTerminalState(record.state) || record.state === "CANCELLING") return base;
      return { ...base, state: "BLOCKED" as GoalState };
    case "ConvergenceLimitReached":
      if (isTerminalState(record.state) || record.state === "CANCELLING") return base;
      return { ...base, state: "NON_CONVERGENT" as GoalState };
    case "PreparationProgress": {
      const jobKey = event.job === "baseline" ? "baselineJob" : "provisionalPlanJob";
      const updatedPrep = {
        ...record.preparation,
        [jobKey]: {
          ...record.preparation[jobKey],
          status: event.status,
          attemptId: event.attemptId,
          basedOnRevision: event.basedOnRevision,
          ref: event.artifactRef,
          errorRef: event.errorRef,
        },
      };
      const bothSucceeded =
        updatedPrep.baselineJob.status === "SUCCEEDED" &&
        updatedPrep.provisionalPlanJob.status === "SUCCEEDED";
      return {
        ...base,
        state: (bothSucceeded && record.state === "PREPARING" ? "RECONCILING" : record.state) as GoalState,
        preparation: updatedPrep,
      };
    }
    default:
      return base;
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, filePath);
}

export class GoalStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "goals");
    mkdirSync(this.dir, { recursive: true });
  }

  create(goalId: GoalId, record: GoalRecord): void {
    // Same directory-lock as update()/repair(): closes the exists-check-then-
    // write TOCTOU against concurrent creators keyed on this goal file path.
    return withLock(this.filePath(goalId), () => {
      const filePath = this.filePath(goalId);
      if (existsSync(filePath)) throw new GoalExistsError(String(goalId));
      atomicWrite(filePath, JSON.stringify(record, null, 2));
    });
  }

  get(goalId: GoalId): GoalRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(goalId), "utf-8");
    } catch (err: unknown) {
      // Missing file = missing goal. Anything else (permission, IO) is corruption.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new StoreCorruptionError(String(goalId), `read failed: ${(err as Error)?.message ?? String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      throw new StoreCorruptionError(String(goalId), `unparseable JSON: ${(err as Error)?.message ?? String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as GoalRecord).schemaVersion !== 1) {
      throw new StoreCorruptionError(String(goalId), "schema mismatch: expected object with schemaVersion 1");
    }
    return parsed as GoalRecord;
  }

  /** Options for compare-and-swap writes. */
  /**
   * Apply a reducer to a goal record. Validates the resulting state transition.
   * Same-state updates (data-only, no transition) skip transition validation.
   *
   * Compare-and-swap: pass `opts.expectedVersion` to reject stale writes with
   * a typed VersionConflictError (no write, no version increment).
   * Reducer no-ops (nothing changed) throw a typed IgnoredEventError and
   * never create fake transitions or bump recordVersion.
   * Returns the updated record, or throws on invalid transition.
   */
  update(
    goalId: GoalId,
    event: GoalEvent,
    reducer: GoalReducer,
    opts?: UpdateOptions,
  ): GoalRecord;
  update(
    goalId: GoalId,
    event: GoalEvent,
    opts?: UpdateOptions,
  ): GoalRecord;
  update(
    goalId: GoalId,
    event: GoalEvent,
    reducer?: GoalReducer | UpdateOptions,
    opts?: UpdateOptions,
  ): GoalRecord {
    // Cross-process CAS: the whole read-check-write runs under a
    // directory-lock keyed on the goal file path, so two processes cannot
    // interleave get-then-write. dispatchEvent's double-read is closed by
    // this lock: it re-reads via update with expectedVersion, and a
    // concurrent writer between its read and this locked section fails CAS.
    return withLock(this.filePath(goalId), () => {
    const resolvedReducer: GoalReducer =
      typeof reducer === "function" ? reducer : goalReducer;
    const resolvedOpts: UpdateOptions =
      typeof reducer === "function" ? (opts ?? {}) : ((reducer as UpdateOptions | undefined) ?? (opts ?? {}));
    const existing = this.get(goalId);
    if (!existing) throw new Error(`Goal ${goalId} not found`);

    if (
      resolvedOpts.expectedVersion !== undefined &&
      existing.recordVersion !== resolvedOpts.expectedVersion
    ) {
      throw new VersionConflictError(
        String(goalId),
        resolvedOpts.expectedVersion,
        existing.recordVersion,
      );
    }

    const updated = resolvedReducer(event, existing);

    // Only validate transition when state actually changes
    if (existing.state !== updated.state) {
      const validation = validateTransition(existing.state, updated.state);
      if (!validation.valid) {
        throw new InvalidTransitionError(validation.reason ?? "unknown reason");
      }
    } else if (isNoOp(existing, updated)) {
      // Reducer changed nothing (not even data): ignore loudly instead of
      // persisting a fake transition with a bumped recordVersion.
      throw new IgnoredEventError(event.type, "reducer produced no state or data change");
    }

    updated.recordVersion = existing.recordVersion + 1;
    updated.lastTransitionId = `${event.type}-${randomUUID()}`;
    const filePath = this.filePath(goalId);
    atomicWrite(filePath, JSON.stringify(updated, null, 2));
    return updated;
    });
  }

  /**
   * Audited repair write for stale-lease recovery (used by recovery.ts).
   * Clears the named lease, flags recoveryRequired, CAS-guards on
   * expectedVersion, bumps recordVersion, and persists. Throws
   * IgnoredEventError when there is nothing to repair.
   */
  repair(
    goalId: GoalId,
    kind: "driver-lease" | "mutation-lease" | "clear-recovery",
    opts?: UpdateOptions,
  ): GoalRecord {
    // Same cross-process lock as update(): read-check-write is atomic
    // against concurrent workers keyed on this goal file path.
    return withLock(this.filePath(goalId), () => {
    const existing = this.get(goalId);
    if (!existing) throw new Error(`Goal ${goalId} not found`);
    if (
      opts?.expectedVersion !== undefined &&
      existing.recordVersion !== opts.expectedVersion
    ) {
      throw new VersionConflictError(
        String(goalId),
        opts.expectedVersion,
        existing.recordVersion,
      );
    }
    if (kind === "clear-recovery") {
      // Clearing path for recoveryRequired (set by lease repairs): after
      // successful lease repair the flag must clear so continuation
      // canContinue works again. Throws when there is nothing to clear.
      if (!existing.recoveryRequired) {
        throw new IgnoredEventError("Recovery:clear-recovery", "recoveryRequired already false");
      }
      const cleared: GoalRecord = {
        ...existing,
        updatedAt: new Date().toISOString() as GoalRecord["updatedAt"],
        recoveryRequired: false,
        recordVersion: existing.recordVersion + 1,
        lastTransitionId: `Recovery:clear-recovery-${randomUUID()}`,
      };
      atomicWrite(this.filePath(goalId), JSON.stringify(cleared, null, 2));
      return cleared;
    }
    const hasLease =
      kind === "driver-lease" ? existing.activeDriverLease !== undefined : existing.activeMutationLease !== undefined;
    if (!hasLease) {
      throw new IgnoredEventError(`Recovery:${kind}`, "no such lease to repair");
    }
    const updated: GoalRecord = {
      ...existing,
      updatedAt: new Date().toISOString() as GoalRecord["updatedAt"],
      recoveryRequired: true,
      recordVersion: existing.recordVersion + 1,
      lastTransitionId: `Recovery:${kind}-${randomUUID()}`,
    };
    if (kind === "driver-lease") {
      updated.activeDriverLease = undefined;
    } else {
      updated.activeMutationLease = undefined;
    }
    atomicWrite(this.filePath(goalId), JSON.stringify(updated, null, 2));
    return updated;
    });
  }

  /**
   * List all goals with per-file corruption isolation: unreadable or
   * unparseable files are skipped and reported as typed errors — never a
   * raw SyntaxError crash. Use listDetailed() when the caller needs the
   * collected errors.
   */
  list(): GoalRecord[] {
    return this.listDetailed().records;
  }

  /** list() plus the typed per-file errors for skipped files. */
  listDetailed(): { records: GoalRecord[]; errors: StoreCorruptionError[] } {
    const records: GoalRecord[] = [];
    const errors: StoreCorruptionError[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (err: unknown) {
      throw new StoreCorruptionError(
        this.dir,
        `cannot list goals directory: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    for (const f of files) {
      const goalId = f.slice(0, -5);
      try {
        const raw = readFileSync(join(this.dir, f), "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || (parsed as GoalRecord).schemaVersion !== 1) {
          throw new StoreCorruptionError(goalId, "schema mismatch: expected object with schemaVersion 1");
        }
        records.push(parsed as GoalRecord);
      } catch (err: unknown) {
        if (err instanceof StoreCorruptionError) {
          errors.push(err);
        } else {
          errors.push(
            new StoreCorruptionError(goalId, `${(err as Error)?.message ?? String(err)}`),
          );
        }
      }
    }
    return { records, errors };
  }

  delete(goalId: GoalId): boolean {
    return withLock(this.filePath(goalId), () => {
      try {
        unlinkSync(this.filePath(goalId));
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw err;
      }
    });
  }

  private filePath(goalId: GoalId): string {
    return join(this.dir, `${goalId}.json`);
  }
}
