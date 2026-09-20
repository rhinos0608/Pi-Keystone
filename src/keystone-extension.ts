// Extension entrypoint — wired by P4-INT, Phase 6 integration.
// Registers /goal command, lifecycle hooks, context compiler,
// execution schedulers, worker guard, exports public API.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GoalRecord, GoalId, GoalEvent, GoalState, RevisionRef } from "./domain/types.js";
import { createGoalRecord, validateTransition, isAssignmentTerminal } from "./domain/goal-record.js";
import { GoalStore } from "./store/goal-store.js";
import { createArtifactStore } from "./store/artifact-store.js";
import { handleGoalCommand } from "./runtime/commands.js";
import { parseModelDepth, type DepthProposal, type DepthProposalInput } from "./runtime/depth.js";
import { openGoalConfirmation } from "./tui/goal-confirm.js";
import { openMutationConflictConfirmation, type MutationConflictConfirmationInput } from "./tui/mutation-confirm.js";
import { SubagentRpcClient } from "./rpc/subagent-rpc-client.js";
import { ensureKeystoneSessionBridges, resetSessionBridges } from "./rpc/subagents-bridge.js";
import type { RpcEventBus, RpcResult } from "./rpc/types.js";
import {
  dispatchEvent,
  startGoal,
  getGoalState,
  isTerminal,
  type ReceiptLog,
  type ReceiptEntry,
} from "./runtime/lifecycle.js";
import {
  detectRecoveryIssues,
  repairOrphanedDriverLease,
  repairStaleMutationLease,
  clearRecoveryRequired,
} from "./runtime/recovery.js";
import { acquireDriverLeasePersisted, releaseDriverLeasePersisted } from "./runtime/driver.js";
import { FINAL_AUDITOR_SCHEMA, runCompletionFlow } from "./runtime/completion-flow.js";
import {
  buildContinuationContext,
  resumeAfterCompaction,
  type ContinuationContext,
} from "./continuation.js";

// ─── Phase 6 imports ───────────────────────────────────────────────────────

import { compileContext, issueAuthority } from "./context/compiler.js";
import { projectGoalStoreView } from "./context/projections.js";
import type { ProjectionRole, GoalProjection } from "./context/projections.js";
import { registerWorkerGuard } from "./execution/worker-guard.js";
import type { WorkerGuard, GuardResult } from "./execution/worker-guard.js";
import { dispatchReadOnly, executeReadOnly, completionStatusOf, type ContextView } from "./execution/read-only-launcher.js";
import type { ReadOnlyLaunchResult } from "./execution/read-only-launcher.js";
import {
  dispatchMutation,
  dispatchMutationAcquisition,
  acquisitionWriteSet,
  MUTATION_ACQUISITION_SCHEMA,
  acquireAuthority,
  executeMutation,
} from "./execution/mutation-launcher.js";
import { createApproval } from "./execution/approval.js";
import type { MutationLaunchResult } from "./execution/mutation-launcher.js";
import { acquireLease, releaseLease, checkLease, heartbeatLease, advanceLeasePhase } from "./execution/mutation-lease.js";
import { captureSnapshot, conflictMatrix, diffSnapshots } from "./baseline/snapshot.js";
import { captureEcosystemBaseline } from "./baseline/orchestrator.js";
import { compareEcosystemBaselines } from "./baseline/compare.js";
import type { WorkspaceSnapshot } from "./baseline/snapshot.js";
import type { EcosystemBaseline } from "./baseline/types.js";
import type { ProvisionalPlan } from "./planning/provisional-plan.js";
import type { GoalContract as CanonicalGoalContract } from "./contract/goal-contract.js";
import type { GoalFlowRefs } from "./runtime/goal-flow.js";
import { createReportEnvelope } from "./execution/report-envelope.js";
import type { AsyncCompletePayload } from "./rpc/types.js";
import { enforceToolPolicy } from "./execution/tool-policy.js";
import type { ToolPolicy, ToolPolicyKind } from "./execution/tool-policy.js";
import type { ContextRole, GoalContextView, CompilerConfig } from "./context/types.js";
import type { AssignmentId, ArtifactRef } from "./domain/types.js";
import { runExecutionFrontier } from "./execution/read-only-launcher.js";
import { setSpawnCeiling, restoreReaderCeiling } from "./rpc/subagents-bridge.js";
import type { DispatchResult, ScheduledAssignment } from "./execution/scheduler.js";
import type { Assignment } from "./execution/assignment.js";
import type { ReportEnvelope } from "./execution/report-envelope.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type KeystoneConfig = {
  dataDir: string;
};

export type GoalCommandHandler = {
  create(opts: {
    goalId: GoalId;
    userTask: string;
    workspace: GoalRecord["workspace"];
    startRevision: GoalRecord["startRevision"];
  }): GoalRecord;
  get(goalId: GoalId): GoalRecord | null;
  list(): GoalRecord[];
  delete(goalId: GoalId): boolean;
};

export type LifecycleHooks = {
  session_start(): void;
  session_before_compact(goalId: GoalId): ContinuationContext | null;
};

export type FlowPlanEntry = {
  plan: ProvisionalPlan;
  contract: CanonicalGoalContract;
  revision: RevisionRef;
  refs: GoalFlowRefs;
  baseline: EcosystemBaseline;
  snapshot: WorkspaceSnapshot;
};

export type SessionBinding = {
  rpc: SubagentRpcClient | null;
  sessionId: string;
  live: boolean;
  cwd: string;
  /** Interactive collision gate. Absent means dirty write collisions fail closed. */
  approveMutationConflict?: (input: MutationConflictConfirmationInput) => Promise<boolean>;
};

/** Operator-registered wiring that lets runExecution drive a stored plan. */
export type FrontierWiring = {
  /** Real child-spawning executor; resolves full assignment context by id. */
  executor: (assignment: Assignment) => Promise<ReportEnvelope>;
  /** Fresh read-only child runner for review/final-audit roles after the frontier. */
  postExecutor?: (assignment: Assignment, context: { goalId: GoalId; root: string }) => Promise<ReportEnvelope>;
  executionPlanRef: ArtifactRef;
  reportRefFor: (assignmentId: AssignmentId, report: ReportEnvelope) => ArtifactRef;
  errorRefFor?: (assignmentId: AssignmentId, error: unknown) => ArtifactRef | undefined;
};

export type RunExecutionOutcome = { ok: boolean; reason?: string };

/**
 * Map an async-complete child payload to a frontier ReportEnvelope.
 * Fail-closed: non-success statuses throw, so the frontier records
 * AssignmentFailed instead of a vacuous completion.
 */
function toCompletionEnvelope(
  assignmentId: Assignment["id"],
  runId: string,
  sessionId: string,
  payload: AsyncCompletePayload,
): ReportEnvelope {
  const summary =
    (payload.results ?? []).map((r) => r.summary).join("\n") || `(no child results for ${runId})`;
  if (completionStatusOf(payload) === "FAILED") {
    throw new Error(`child-failed:${summary.slice(0, 500)}`);
  }
  const reportedChildSession = (payload.results ?? []).find(
    (r) => typeof r.sessionPath === "string" && r.sessionPath.length > 0,
  )?.sessionPath;
  const structuredOutput = (payload.results ?? []).find(
    (r) => r.structuredOutput !== undefined,
  )?.structuredOutput;
  const childSessionId = reportedChildSession ?? `${sessionId}:run:${runId}`;
  const built = createReportEnvelope({
    assignmentId,
    runId,
    sessionId: childSessionId,
    findings: [
      {
        id: `${runId}-0`,
        severity: "info",
        message: summary.slice(0, 2000) || "child completed",
        source: "subagent",
      },
    ],
    evidenceRefs: [],
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  });
  if (!built.ok) {
    throw new Error(`envelope-invalid:${built.errors.map((e) => e.kind).join(",")}`);
  }
  return built.envelope;
}

const FRONTIER_VERIFIER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string", minLength: 1 },
    evidence: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1 },
    },
  },
};

type FrontierVerifierOutput = {
  verdict: "pass" | "fail";
  summary: string;
  evidence: string[];
};

function parseVerifierOutput(value: unknown): FrontierVerifierOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.verdict !== "pass" && row.verdict !== "fail") return null;
  if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
  const evidence = Array.isArray(row.evidence)
    ? row.evidence.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return { verdict: row.verdict, summary: row.summary.trim(), evidence };
}

function toVerifierEnvelope(
  assignmentId: Assignment["id"],
  runId: string,
  sessionId: string,
  payload: AsyncCompletePayload,
): ReportEnvelope {
  if (completionStatusOf(payload) === "FAILED") {
    throw new Error(`verification-child-failed:${runId}`);
  }
  const structured = (payload.results ?? [])
    .map((row) => parseVerifierOutput(row.structuredOutput))
    .find((row): row is FrontierVerifierOutput => row !== null);
  if (!structured) throw new Error("verification-missing-structured-verdict");
  if (structured.verdict !== "pass") {
    throw new Error(`verification-failed:${structured.summary.slice(0, 500)}`);
  }
  const reportedChildSession = (payload.results ?? []).find(
    (r) => typeof r.sessionPath === "string" && r.sessionPath.length > 0,
  )?.sessionPath;
  const built = createReportEnvelope({
    assignmentId,
    runId,
    sessionId: reportedChildSession ?? `${sessionId}:run:${runId}`,
    findings: [{
      id: `${runId}-verified`,
      severity: "info",
      message: structured.summary.slice(0, 4000),
      source: "subagent-verifier",
    }],
    evidenceRefs: structured.evidence,
    structuredOutput: structured,
  });
  if (!built.ok) throw new Error(`verifier-envelope-invalid:${built.errors.map((e) => e.kind).join(",")}`);
  return built.envelope;
}

function verifierEnvelopeFromRecoveredOutput(
  assignmentId: AssignmentId,
  runId: string,
  sessionId: string,
  output: string,
): ReportEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  const structured = parseVerifierOutput(parsed);
  if (!structured || structured.verdict !== "pass") return null;
  const built = createReportEnvelope({
    assignmentId,
    runId,
    sessionId,
    findings: [{
      id: `${runId}-verified-recovered`,
      severity: "info",
      message: structured.summary.slice(0, 4000),
      source: "subagent-verifier-recovery",
    }],
    evidenceRefs: structured.evidence,
  });
  return built.ok ? built.envelope : null;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createKeystone(config: KeystoneConfig) {
  const store = new GoalStore(config.dataDir);
  const receiptLog: ReceiptLog = [];
  const artifacts = createArtifactStore({ root: join(config.dataDir, "artifacts") });
  const flowPlans = new Map<string, FlowPlanEntry>();
  let sessionBinding: SessionBinding | null = null;
  let frontierCell: { goalId: GoalId; plan: ProvisionalPlan; revision: RevisionRef } | null = null;
  // One host-generated evidence bundle per concrete frontier object. A WeakMap
  // avoids stale reuse across repair/recovery frontiers for the same goal.
  const verifierEvidenceByFrontier = new WeakMap<object, Promise<string>>();
  // Exact paths actually admitted by mutation acquisition + child guard.
  const guardedMutationScopes = new Map<string, Map<string, string[]>>();

  // Typed receipt for a failed startup-repair attempt. Kept alongside
  // console.error (not instead of it): the receipt is operator-queryable via
  // receiptLog, the console line is immediately visible in session logs.
  function pushRepairFailureReceipt(goalId: GoalId, kind: string, err: unknown): void {
    let fromState: GoalRecord["state"] = "PREPARING";
    let recordVersion = -1;
    try {
      const current = store.get(goalId);
      if (current) {
        fromState = current.state;
        recordVersion = current.recordVersion;
      }
    } catch {
      // Store unreadable: receipt carries the fallback state/version above.
    }
    receiptLog.push({
      goalId,
      eventType: `Recovery:${kind}-failed`,
      fromState,
      toState: fromState,
      recordVersion,
      timestamp: new Date().toISOString(),
      transitionId: `Recovery:${kind}-failed-${Date.now()}`,
      // Redacted failure detail lives only in console.error, never here. Note:
      // this receipt is a no-transition marker (fromState === toState).
    });
  }

  // /goal command handler
  const goal: GoalCommandHandler = {
    create({ goalId, userTask, workspace, startRevision }) {
      const record = createGoalRecord(goalId, userTask, workspace, startRevision);
      return startGoal(store, goalId, record, receiptLog);
    },
    get(goalId) {
      return getGoalState(store, goalId);
    },
    list() {
      return store.list();
    },
    delete(goalId) {
      return store.delete(goalId);
    },
  };

  // Lifecycle hooks
  const hooks: LifecycleHooks = {
    session_start() {
      // Reconcile goals left in non-terminal states from prior sessions.
      // Corrupt store files log + continue; the loop never crashes.
      let goals: GoalRecord[];
      try {
        goals = store.list();
      } catch (err) {
        console.error(
          `Keystone: session_start store.list failed; skipping recovery (${(err as Error)?.message ?? String(err)})`,
        );
        return;
      }
      const now = new Date().toISOString() as GoalRecord["updatedAt"];
      let issues: ReturnType<typeof detectRecoveryIssues> = [];
      try {
        issues = detectRecoveryIssues(goals, now);
      } catch (err) {
        console.error(
          `Keystone: session_start detectRecoveryIssues failed; continuing with resume-only (${(err as Error)?.message ?? String(err)})`,
        );
      }
      const issuesByGoal = new Map<string, typeof issues>();
      for (const issue of issues) {
        const list = issuesByGoal.get(issue.goalId) ?? [];
        list.push(issue);
        issuesByGoal.set(issue.goalId, list);
      }
      for (const g of goals) {
        try {
          if (isTerminal(g)) continue;
          // Lease repairs run BEFORE any resume: a PAUSED goal with a stale
          // lease resumes against a repaired record, never a dead lease.
          let repaired = false;
          for (const issue of issuesByGoal.get(g.goalId as string) ?? []) {
            try {
              if (issue.kind === "orphaned_driver_lease") {
                repairOrphanedDriverLease(store, g.goalId, receiptLog);
                repaired = true;
              } else if (issue.kind === "stale_mutation_lease") {
                // Pre-mutation authority is safe to discard after expiry. Once
                // a child entered MUTATING/SETTLING, however, the durable
                // mirror is evidence that partial writes may exist. Preserve
                // it for the live RPC recovery pass instead of converting an
                // unknown mutation outcome into a clean restart.
                if (issue.phase === "ACQUIRED" || issue.phase === "AUTHORITY_READY") {
                  repairStaleMutationLease(store, g.goalId, receiptLog);
                  repaired = true;
                }
              }
            } catch (err) {
              console.error(
                `Keystone: session_start repair ${issue.kind} for goal ${g.goalId} failed; continuing (${(err as Error)?.message ?? String(err)})`,
              );
              pushRepairFailureReceipt(g.goalId, issue.kind, err);
            }
          }
          // Clearing path: lease repairs set recoveryRequired, so re-read
          // AFTER repairs and clear when the flag is still set (covers both
          // the just-repaired case and a leftover stale_recovery_required
          // with no live lease issue). continuation canContinue works after.
          try {
            const afterRepairs = store.get(g.goalId);
            // CANCELLING + recoveryRequired means mutation outcome is still
            // indeterminate. The same is true for a preserved post-write
            // mutation mirror: only live RPC reconciliation may resolve it.
            const unsafeMutationPhase = afterRepairs?.activeMutationLease?.phase;
            const unresolvedMutation =
              unsafeMutationPhase === "MUTATING" || unsafeMutationPhase === "SETTLING";
            if (
              afterRepairs?.recoveryRequired
              && afterRepairs.state !== "CANCELLING"
              && !unresolvedMutation
            ) {
              clearRecoveryRequired(store, g.goalId, receiptLog);
              repaired = true;
            }
          } catch (err) {
            console.error(
              `Keystone: session_start clear recoveryRequired for goal ${g.goalId} failed; continuing (${(err as Error)?.message ?? String(err)})`,
            );
            pushRepairFailureReceipt(g.goalId, "clear-recovery", err);
          }
          void repaired;
          // PAUSED is deliberately stable across restart. Startup may repair
          // stale infrastructure leases, but it never converts "paused" into
          // execution authority. The next /goal release performs workspace
          // freshness checks, re-confirms depth if the prepared bundle changed,
          // then resumes under the live session's driver fence.
          if (store.get(g.goalId)?.state === "PAUSED") continue;
        } catch (err) {
          console.error(
            `Keystone: session_start recovery for goal ${g.goalId} failed; continuing (${(err as Error)?.message ?? String(err)})`,
          );
        }
      }
    },
    session_before_compact(goalId) {
      return resumeAfterCompaction(store, goalId);
    },
  };

  // Frontier wiring: live executor + artifact minters. session_start
  // registers it via registerFrontierWiring(buildFrontierWiring());
  // runExecution auto-ensures it when absent (same builder), so goals reach
  // EXECUTING even on hosts that never fired session_start — the executor
  // then fails per-assignment with a typed no-live-runtime reason.
  let frontierWiring: FrontierWiring | undefined;

  function writeArtifact(content: string): ArtifactRef {
    return artifacts.writeArtifact(content);
  }

  /** Rehydrate the prepared execution bundle from durable CAS on cache miss. */
  function loadFlowPlan(goalId: GoalId): FlowPlanEntry | undefined {
    const cached = flowPlans.get(goalId as string);
    if (cached) return cached;
    const record = store.get(goalId);
    const ref = record?.preparedFlowRef ?? null;
    if (!ref || !artifacts.hasArtifact(ref)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifacts.readArtifact(ref).toString("utf-8"));
    } catch (err) {
      throw new Error(`prepared-flow-corrupt:${(err as Error)?.message ?? String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("prepared-flow-corrupt: expected object");
    }
    const candidate = parsed as Partial<FlowPlanEntry>;
    if (
      !candidate.plan || candidate.plan.goalId !== String(goalId) || !Array.isArray(candidate.plan.assignments) ||
      !candidate.contract || candidate.contract.goalId !== String(goalId) ||
      !candidate.revision || !candidate.refs || !candidate.baseline || !candidate.snapshot
    ) {
      throw new Error("prepared-flow-corrupt: identity or required fields mismatch");
    }
    const entry = candidate as FlowPlanEntry;
    flowPlans.set(goalId as string, entry);
    return entry;
  }

  function buildFrontierWiring(): FrontierWiring {
    return {
      executor: sessionExecutor,
      postExecutor: sessionReadOnlyRoleExecutor,
      // Placeholder: runExecution always overrides executionPlanRef per-run
      // with the flow plan ref. The wiring carries executor + minters only.
      executionPlanRef: "0".repeat(64) as ArtifactRef,
      reportRefFor: (_assignmentId, report) => writeArtifact(JSON.stringify(report)),
      errorRefFor: (_assignmentId, error) =>
        writeArtifact(String((error as Error)?.message ?? String(error)).slice(0, 4000)),
    };
  }

  function frontierVerifierEvidence(
    cell: { goalId: GoalId; plan: ProvisionalPlan; revision: RevisionRef },
    root: string,
  ): Promise<string> {
    const existing = verifierEvidenceByFrontier.get(cell);
    if (existing) return existing;
    const pending = (async () => {
      const entry = flowPlans.get(String(cell.goalId));
      if (!entry) throw new Error(`verifier-evidence-missing-flow:${String(cell.goalId)}`);
      const [currentSnapshot, currentBaseline] = await Promise.all([
        captureSnapshot(root),
        captureEcosystemBaseline(root),
      ]);
      const workspaceDelta = diffSnapshots(entry.snapshot, currentSnapshot);
      const ecosystemDelta = compareEcosystemBaselines(entry.baseline, currentBaseline);
      const scopes = guardedMutationScopes.get(String(cell.goalId));
      const exactMutationScopes = scopes
        ? [...scopes.entries()].map(([assignmentId, paths]) => ({ assignmentId, paths: [...paths] }))
        : [];
      return JSON.stringify({
        provenance: "keystone-controller",
        authority: "machine-generated",
        note: "guardedMutationScopes are the exact paths mutation children were authorized to write; workspaceDelta may also include ambient tooling files.",
        exactMutationScopes,
        workspaceDelta,
        baselineChecks: Object.fromEntries(
          Object.entries(entry.baseline.checks).map(([id, check]) => [id, check?.status ?? "UNAVAILABLE"]),
        ),
        currentChecks: Object.fromEntries(
          Object.entries(currentBaseline.checks).map(([id, check]) => [id, check?.status ?? "UNAVAILABLE"]),
        ),
        checkTransitions: ecosystemDelta.transitions,
        newFailureFingerprints: ecosystemDelta.fingerprints.ownedByGoal,
      });
    })();
    verifierEvidenceByFrontier.set(cell, pending);
    return pending;
  }

  /** Spawn one fresh read-only child for review/audit work outside the plan DAG. */
  async function sessionReadOnlyRoleExecutor(
    assignment: Assignment,
    context: { goalId: GoalId; root: string },
  ): Promise<ReportEnvelope> {
    const rpc = sessionBinding?.rpc ?? null;
    const live = sessionBinding?.live ?? false;
    const sessionId = sessionBinding?.sessionId;
    if (!rpc || !live || !sessionId) {
      throw new Error("no-live-runtime: read-only post-frontier child spawn refused");
    }
    const delegation = dispatchReadOnly(
      { id: assignment.id, description: assignment.acceptanceCriteria.join("; ") || String(assignment.id), targetFiles: [...assignment.targetFiles] },
      {
        goalId: String(context.goalId),
        task: assignment.acceptanceCriteria.join("; ") || String(assignment.id),
        workspace: context.root,
        targetFiles: [...assignment.targetFiles],
      },
    ).delegation;
    return new Promise<ReportEnvelope>((resolve, reject) => {
      let done = false;
      const onComplete = (payload: AsyncCompletePayload): void => {
        if (done) return;
        done = true;
        try {
          resolve(toCompletionEnvelope(assignment.id, payload.runId, sessionId, payload));
        } catch (err) {
          reject(err);
        }
      };
      executeReadOnly(delegation, rpc, {
        sessionId,
        cwd: context.root,
        // Role selection is the model-routing boundary. Never pass a model
        // override here: pi-subagents applies settings.json overrides for
        // reviewer/oracle while the parent session remains the orchestrator.
        agent: assignment.role === "auditor" ? "oracle" : "reviewer",
        ...(assignment.role === "auditor" ? { structuredOutputSchema: FINAL_AUDITOR_SCHEMA } : {}),
        onComplete,
      }).catch((err: unknown) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
    });
  }

  /**
   * Session-scoped frontier executor, registered at session_start.
   * Reads its goal + plan from the frontier cell bound by runExecution.
   * Role routing (fail-closed): implementer -> mutation path
   * (acquireAuthority -> executeMutation under the mutation ceiling);
   * every other role -> read-only path (executeReadOnly).
   */
  async function sessionExecutor(assignment: Assignment): Promise<ReportEnvelope> {
    const cell = frontierCell;
    if (!cell) throw new Error("no-goal-bound: frontier executor invoked outside runExecution");
    const rpc = sessionBinding?.rpc ?? null;
    const live = sessionBinding?.live ?? false;
    const boundSessionId = sessionBinding?.sessionId;
    if (!rpc || !live || !boundSessionId) {
      throw new Error(
        "no-live-runtime: session binding absent or not live (session_start has not wired RPC with a real session id); live spawn refused",
      );
    }
    const sessionId = boundSessionId;
    const record = store.get(cell.goalId);
    if (!record) throw new Error(`goal vanished mid-frontier: ${String(cell.goalId)}`);
    if (record.activeMutationLease) {
      throw new Error(
        `mutation-authority-unresolved: active lease ${record.activeMutationLease.leaseId} remains for ${String(record.activeMutationLease.assignmentId)}`,
      );
    }
    const pa = cell.plan.assignments.find((a) => a.id === (assignment.id as string));
    if (!pa) throw new Error(`unknown-assignment:${String(assignment.id)}`);
    const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
    const contextView: ContextView = {
      goalId: String(cell.goalId),
      task: pa.description,
      workspace: root,
      targetFiles: [...pa.targetFiles],
    };
    const awaitPayload = (
      spawnFn: (onComplete: (p: AsyncCompletePayload) => void) => Promise<unknown>,
    ): Promise<AsyncCompletePayload> =>
      new Promise<AsyncCompletePayload>((resolve, reject) => {
        let done = false;
        const onComplete = (payload: AsyncCompletePayload): void => {
          if (done) return;
          done = true;
          resolve(payload);
        };
        spawnFn(onComplete).catch((err: unknown) => {
          if (!done) {
            done = true;
            reject(err);
          }
        });
      });
    const awaitSpawn = (
      spawnFn: (onComplete: (p: AsyncCompletePayload) => void) => Promise<unknown>,
    ): Promise<ReportEnvelope> =>
      awaitPayload(spawnFn).then((payload) =>
        toCompletionEnvelope(assignment.id, payload.runId, sessionId, payload),
      );
    const bindRun = (runId: string): void => {
      const current = store.get(cell.goalId);
      if (!current) throw new Error(`goal vanished while binding run: ${String(cell.goalId)}`);
      const driverFence = currentDriverFence(cell.goalId, sessionId);
      dispatchEvent(
        store,
        cell.goalId,
        { type: "AssignmentRunBound", assignmentId: assignment.id, runId, sessionId, driverFence },
        receiptLog,
      );
    };
    if (assignment.role !== "implementer") {
      const controllerEvidence = await frontierVerifierEvidence(cell, root);
      const verifierDescription = [
        pa.description,
        "",
        "Authoritative controller evidence follows. Use it for workspace-scope and regression claims instead of requiring shell access:",
        controllerEvidence,
      ].join("\n");
      const launched = dispatchReadOnly(
        { id: assignment.id, description: verifierDescription, targetFiles: [...pa.targetFiles] },
        { ...contextView, task: verifierDescription },
      );
      const payload = await awaitPayload((onComplete) =>
        executeReadOnly(launched.delegation, rpc, {
          sessionId,
          cwd: root,
          agent: "reviewer",
          structuredOutputSchema: FRONTIER_VERIFIER_SCHEMA,
          onSpawn: ({ runId }) => bindRun(runId),
          onComplete,
        }),
      );
      return toVerifierEnvelope(assignment.id, payload.runId, sessionId, payload);
    }
    // Phase 1: a fresh read-only child discovers the exact write-set. Planner
    // targetFiles are hints only and never become mutation authority directly.
    const acquisition = dispatchMutationAcquisition(
      { id: assignment.id, description: pa.description, targetFiles: [...pa.targetFiles] },
      contextView,
    );
    const acquisitionPayload = await awaitPayload((onComplete) =>
      executeReadOnly(acquisition, rpc, {
        sessionId,
        cwd: root,
        agent: "scout",
        structuredOutputSchema: MUTATION_ACQUISITION_SCHEMA,
        onComplete,
      }),
    );
    // The acquisition child is asynchronous. Re-check durable authority after
    // it returns so a concurrent pause/cancel cannot be followed by a fresh
    // write lease based on the stale record captured before the await.
    const afterAcquisition = store.get(cell.goalId);
    if (!afterAcquisition) {
      throw new Error(`goal vanished after mutation acquisition: ${String(cell.goalId)}`);
    }
    if (afterAcquisition.state !== "EXECUTING" && afterAcquisition.state !== "REPAIRING") {
      throw new Error(`mutation-acquisition-invalidated-by-state:${afterAcquisition.state}`);
    }
    if (afterAcquisition.activeMutationLease) {
      throw new Error(
        `mutation-authority-became-active:${afterAcquisition.activeMutationLease.leaseId}`,
      );
    }
    const writeSet = acquisitionWriteSet(acquisitionPayload);
    let goalScopes = guardedMutationScopes.get(String(cell.goalId));
    if (!goalScopes) {
      goalScopes = new Map<string, string[]>();
      guardedMutationScopes.set(String(cell.goalId), goalScopes);
    }
    goalScopes.set(String(assignment.id), [...writeSet]);

    const leaseRes = acquireLease({
      goalId: String(cell.goalId),
      assignmentId: assignment.id,
      sessionId,
      root,
      writeSet,
      planEpoch: record.planEpoch,
      baseRevision: cell.revision.gitHead ?? null,
      baseDirtySignature: cell.revision.dirtySignature,
      ttlMs: 120_000,
    });
    if (!leaseRes.acquired) throw new Error(`lease-acquire-failed:${leaseRes.reason}`);

    const publishLease = (lease: typeof leaseRes.lease): void => {
      const current = store.get(cell.goalId);
      if (!current) throw new Error(`goal vanished while publishing mutation lease: ${String(cell.goalId)}`);
      const driverFence = currentDriverFence(cell.goalId, sessionId);
      dispatchEvent(store, cell.goalId, { type: "MutationLeaseAttached", lease, driverFence }, receiptLog);
    };
    publishLease(leaseRes.lease);
    let released = false;
    let releaseFailure: string | undefined;
    let originalError: unknown;
    try {
      let snapshot: WorkspaceSnapshot;
      try {
        snapshot = await captureSnapshot(root);
      } catch (err) {
        throw new Error(`snapshot-failed:${(err as Error)?.message ?? String(err)}`);
      }
      const collision = conflictMatrix(snapshot, writeSet, root);
      let approval: ReturnType<typeof createApproval> | undefined;
      let approvalRef: ArtifactRef | undefined;
      if (!collision.proceeds) {
        const approve = sessionBinding?.approveMutationConflict;
        if (!approve) {
          throw new Error(
            `dirty-conflict-approval-unavailable:${collision.conflicts.map((c) => `${c.kind}:${c.path}`).join(",")}`,
          );
        }
        const approved = await approve({
          goalId: String(cell.goalId),
          assignmentId: String(assignment.id),
          description: pa.description,
          conflicts: collision.conflicts,
          writeSet: [...writeSet],
        });
        if (!approved) throw new Error("dirty-conflict-approval-declined");
        approval = createApproval({
          goalId: String(cell.goalId),
          planEpoch: record.planEpoch,
          assignmentId: String(assignment.id),
          snapshot,
          intendedWriteSet: [...writeSet],
          workspaceRoot: root,
        });
        approvalRef = writeArtifact(JSON.stringify(approval));
      }
      const auth = acquireAuthority({
        root,
        leaseId: leaseRes.lease.leaseId,
        sessionId,
        goalId: String(cell.goalId),
        assignmentId: assignment.id,
        planEpoch: record.planEpoch,
        currentSnapshot: snapshot,
        actualWriteSet: writeSet,
        workspaceRoot: root,
        ...(approval ? { approval } : {}),
        ...(approvalRef ? { approvalRef } : {}),
        receiptStore: artifacts,
      });
      if (!auth.ok) throw new Error(`authority-rejected:${auth.reason}`);
      publishLease(auth.lease);
      const launched = dispatchMutation(
        { id: assignment.id, description: pa.description, targetFiles: [...pa.targetFiles] },
        contextView,
        auth.lease,
        undefined,
        { writeSet },
      );
      setSpawnCeiling(sessionId, "mutation");
      try {
        return await awaitSpawn((onComplete) =>
          executeMutation(auth.lease, launched.turns[1].delegation, rpc, {
            sessionId,
            leaseTtlMs: 120_000,
            onSpawn: ({ runId }) => bindRun(runId),
            onLeaseUpdate: publishLease,
            onComplete,
          }),
        );
      } catch (err) {
        originalError = err;
        throw err;
      }
    } finally {
      const phaseBeforeRelease = store.get(cell.goalId)?.activeMutationLease?.phase;
      try {
        released = releaseLease(root, leaseRes.lease.leaseId);
        if (!released) {
          releaseFailure = "lease release returned false (disk authority missing, unreadable, or identity changed)";
        }
      } catch (err) {
        releaseFailure = (err as Error)?.message ?? String(err);
        console.error(
          `Keystone: releaseLease failed for ${leaseRes.lease.leaseId} (${(err as Error)?.message ?? String(err)}); lease will expire`,
        );
      }
      if (!released) {
        try {
          pauseUnresolvedMutation(
            cell.goalId,
            assignment.id,
            `normal-execution-release-failed:${releaseFailure ?? "unknown"}`,
          );
        } catch (err) {
          console.error(
            `Keystone: failed to pause unresolved mutation authority for ${String(cell.goalId)} (${(err as Error)?.message ?? String(err)})`,
          );
        }
      }
      if (released) {
        try {
          const current = store.get(cell.goalId);
          if (current) {
            const driverFence = currentDriverFence(cell.goalId, sessionId);
            if (current.activeMutationLease?.leaseId === leaseRes.lease.leaseId) {
              dispatchEvent(
                store,
                cell.goalId,
                { type: "MutationLeaseReleased", leaseId: leaseRes.lease.leaseId, driverFence },
                receiptLog,
              );
            }
            const afterRelease = store.get(cell.goalId);
            if (afterRelease?.state === "CANCELLING" && phaseBeforeRelease) {
              const mutationOutcome = phaseBeforeRelease === "MUTATING" ? "INDETERMINATE" : "SETTLED";
              const cleanupRef = writeArtifact(JSON.stringify({
                goalId: String(cell.goalId),
                leaseId: leaseRes.lease.leaseId,
                outcome: mutationOutcome,
                rollbackClaimed: false,
                at: new Date().toISOString(),
              }));
              const settleFence = currentDriverFence(cell.goalId, sessionId);
              dispatchEvent(
                store,
                cell.goalId,
                { type: "CancellationSettled", cleanupRef, mutationOutcome, driverFence: settleFence },
                receiptLog,
              );
            }
          }
        } catch (err) {
          console.error(
            `Keystone: mutation lease release bookkeeping failed for ${String(cell.goalId)} (${(err as Error)?.message ?? String(err)})`,
          );
        }
      }
      try {
        restoreReaderCeiling(sessionId);
      } catch (err) {
        console.error(
          `Keystone: restoreReaderCeiling failed for ${sessionId} (${(err as Error)?.message ?? String(err)}); ceiling may stay widened`,
        );
      }
      if (!released) {
        const originalMessage = originalError instanceof Error
          ? originalError.message
          : originalError !== undefined
            ? String(originalError)
            : null;
        throw new Error(
          `mutation-authority-unresolved:${releaseFailure ?? "lease-release-failed"}${originalMessage ? ` (original: ${originalMessage})` : ""}`,
        );
      }
    }
  }

  function ensureOwnedDriverLease(
    goalId: GoalId,
    sessionId: string,
    ttlMs = 15 * 60_000,
  ): GoalRecord {
    const leased = acquireDriverLeasePersisted(store, goalId, sessionId, { ttlMs });
    const active = leased.activeDriverLease;
    if (!active || active.sessionId !== sessionId || new Date(active.expiresAt).getTime() <= Date.now()) {
      throw new Error("driver-lease-held-by-another-session");
    }
    return leased;
  }

  function releaseOwnedDriverLease(goalId: GoalId, sessionId: string): GoalRecord {
    const current = store.get(goalId);
    if (!current) throw new Error(`Goal ${goalId} not found`);
    const active = current.activeDriverLease;
    if (!active || active.sessionId !== sessionId) return current;
    return releaseDriverLeasePersisted(store, goalId, {
      leaseId: active.leaseId,
      sessionId: active.sessionId,
      fencingToken: active.fencingToken,
    });
  }

  function releaseBoundDriverLease(goalId: GoalId): GoalRecord | null {
    const sessionId = sessionBinding?.sessionId;
    if (!sessionId) return store.get(goalId);
    return releaseOwnedDriverLease(goalId, sessionId);
  }

  function startDriverHeartbeat(
    goalId: GoalId,
    sessionId: string,
    ttlMs = 15 * 60_000,
  ): () => void {
    const timer = setInterval(() => {
      try {
        ensureOwnedDriverLease(goalId, sessionId, ttlMs);
      } catch (err) {
        console.error(
          `Keystone: driver heartbeat lost for ${String(goalId)} session ${sessionId} (${(err as Error)?.message ?? String(err)})`,
        );
      }
    }, Math.max(10_000, Math.floor(ttlMs / 3)));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function frontierHasFailedOrCancelled(record: GoalRecord): boolean {
    const ids = record.executionPlan?.assignments.map((node) => node.id)
      ?? (Object.keys(record.assignmentStates) as AssignmentId[]);
    return ids.some((id) => {
      const state = record.assignmentStates[id];
      return state === "FAILED" || state === "CANCELLED";
    });
  }

  function storedFrontierResults(goalId: GoalId): {
    results: DispatchResult[];
    reportRefs: Map<string, ArtifactRef>;
  } {
    const record = store.get(goalId);
    if (!record?.executionPlan) throw new Error("recovery-missing-execution-plan");
    const results: DispatchResult[] = [];
    const reportRefs = new Map<string, ArtifactRef>();
    for (const node of record.executionPlan.assignments) {
      if (record.assignmentStates[node.id] !== "COMPLETED") {
        throw new Error(`recovery-frontier-not-complete:${String(node.id)}`);
      }
      const run = record.activeRuns[node.id];
      if (!run?.resultRef || !artifacts.hasArtifact(run.resultRef)) {
        throw new Error(`recovery-missing-report:${String(node.id)}`);
      }
      let report: ReportEnvelope;
      try {
        report = JSON.parse(artifacts.readArtifact(run.resultRef).toString("utf-8")) as ReportEnvelope;
      } catch (err) {
        throw new Error(`recovery-report-corrupt:${String(node.id)}:${(err as Error)?.message ?? String(err)}`);
      }
      if (!report || report.assignmentId !== node.id || !report.runId || !report.sessionId) {
        throw new Error(`recovery-report-identity-mismatch:${String(node.id)}`);
      }
      results.push({ layerIndex: 0, assignmentId: node.id, report });
      reportRefs.set(String(node.id), run.resultRef);
    }
    return { results, reportRefs };
  }

  const recoveryWatchers = new Map<string, { stop: () => void; heartbeat?: NodeJS.Timeout }>();

  function currentDriverFence(goalId: GoalId, expectedSessionId = sessionBinding?.sessionId): number {
    const record = store.get(goalId);
    const active = record?.activeDriverLease;
    if (!active) throw new Error(`recovery-no-driver-lease:${String(goalId)}`);
    if (new Date(active.expiresAt).getTime() <= Date.now()) {
      throw new Error(`driver-lease-expired:${String(goalId)}`);
    }
    if (expectedSessionId && active.sessionId !== expectedSessionId) {
      throw new Error(
        `driver-lease-owner-mismatch:${String(goalId)}:expected-${expectedSessionId}:actual-${active.sessionId}`,
      );
    }
    return active.fencingToken;
  }

  function repairAssignment(entry: FlowPlanEntry, record: GoalRecord): { assignment: Assignment; plan: ProvisionalPlan } | null {
    const implementations = entry.plan.assignments.filter((a) => a.role === "implementation");
    const base = implementations[0];
    if (!base) return null;
    const targetFiles = [...new Set(implementations.flatMap((a) => a.targetFiles))];
    const criterionIds = [...new Set(implementations.flatMap((a) => a.criterionIds))];
    const acceptanceCriteria = [...new Set(implementations.flatMap((a) => a.acceptanceCriteria))];
    let repairEvidence = "No durable repair evidence was available.";
    if (record.repairReasonRef && artifacts.hasArtifact(record.repairReasonRef)) {
      try {
        repairEvidence = artifacts.readArtifact(record.repairReasonRef).toString("utf-8").slice(0, 12_000);
      } catch {
        repairEvidence = `Repair evidence ${String(record.repairReasonRef)} could not be read.`;
      }
    }
    const repairDescription = [
      `Repair cycle ${record.repairCycles + 1} for goal ${String(record.goalId)}.`,
      `Original goal: ${record.userTask}`,
      "Re-read the current workspace, preserve unrelated user changes, and fix the remaining completion/review/verification defects.",
      `Original implementation work: ${implementations.map((a) => a.description).join(" | ")}`,
      `Repair evidence/reason: ${repairEvidence}`,
    ].join("\n");
    const repaired = { ...base, description: repairDescription, targetFiles, criterionIds, acceptanceCriteria };
    const plan: ProvisionalPlan = {
      ...entry.plan,
      assignments: entry.plan.assignments.map((a) => a.id === base.id ? repaired : a),
    };
    return {
      plan,
      assignment: {
        id: base.id as AssignmentId,
        role: "implementer",
        targetFiles,
        acceptanceCriteria,
        contractRef: record.activeContractRef ?? entry.refs.contractRef,
      },
    };
  }

  async function executeRepairCycle(
    goalId: GoalId,
    entry: FlowPlanEntry,
    wiring: FrontierWiring,
    driverSessionId: string,
  ): Promise<RunExecutionOutcome> {
    const record = store.get(goalId);
    if (!record) return { ok: false, reason: "goal-vanished-before-repair" };
    if (record.state !== "REPAIRING") return { ok: false, reason: `repair-requires-REPAIRING:not-${record.state}` };
    if (record.repairCycles >= 3) {
      const evidenceRef = writeArtifact(JSON.stringify({ goalId: String(goalId), repairCycles: record.repairCycles, reason: "repair-cycle-cap", at: new Date().toISOString() }));
      dispatchEvent(store, goalId, { type: "ConvergenceLimitReached", evidenceRef, driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      return { ok: false, reason: "non-convergent:repair-cycle-cap" };
    }
    const repair = repairAssignment(entry, record);
    if (!repair) {
      const blockerRef = writeArtifact(JSON.stringify({ goalId: String(goalId), reason: "no-implementation-assignment-available-for-repair", at: new Date().toISOString() }));
      dispatchEvent(store, goalId, { type: "BlockDeclared", blockerRefs: [blockerRef], driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      return { ok: false, reason: "repair-blocked:no-implementation-assignment" };
    }
    frontierCell = { goalId, plan: repair.plan, revision: entry.revision };
    try {
      const report = await wiring.executor(repair.assignment);
      const reportRef = writeArtifact(JSON.stringify(report));
      dispatchEvent(store, goalId, { type: "RepairCompleted", assignmentId: repair.assignment.id, reportRef, driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      return { ok: true };
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      const errorRef = writeArtifact(JSON.stringify({ stage: "repair", reason, at: new Date().toISOString() }));
      if (reason.includes("mutation-authority-unresolved")) {
        pauseUnresolvedMutation(goalId, repair.assignment.id, reason);
        return { ok: false, reason: `repair-paused:${reason}` };
      }
      if (reason.includes("dirty-conflict-approval-declined") || reason.includes("dirty-conflict-approval-unavailable")) {
        dispatchEvent(store, goalId, { type: "BlockDeclared", blockerRefs: [errorRef], driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
        return { ok: false, reason: `repair-blocked:${reason}` };
      }
      dispatchEvent(store, goalId, { type: "FatalError", errorRef, driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      return { ok: false, reason: `repair-failed:${reason}` };
    } finally {
      frontierCell = null;
    }
  }

  async function executePostRepairVerification(
    goalId: GoalId,
    entry: FlowPlanEntry,
    wiring: FrontierWiring,
    driverSessionId: string,
  ): Promise<{ ok: true; results: DispatchResult[]; reportRefs: Map<string, ArtifactRef> } | { ok: false; reason: string }> {
    const record = store.get(goalId);
    if (!record) return { ok: false, reason: "goal-vanished-before-post-repair-verification" };
    if (record.state !== "VERIFYING") return { ok: false, reason: `post-repair-verification-requires-VERIFYING:not-${record.state}` };
    const contractRef = record.activeContractRef ?? entry.refs.contractRef;
    const verifiers: Assignment[] = entry.plan.assignments
      .filter((a) => a.role !== "implementation")
      .map((a) => ({
        id: a.id as AssignmentId,
        role: "verifier",
        targetFiles: [...a.targetFiles],
        acceptanceCriteria: [...a.acceptanceCriteria],
        contractRef,
      }));
    if (verifiers.length === 0) {
      const blockerRef = writeArtifact(JSON.stringify({ goalId: String(goalId), reason: "no-independent-verifier-after-repair", at: new Date().toISOString() }));
      dispatchEvent(store, goalId, { type: "BlockDeclared", blockerRefs: [blockerRef], driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      return { ok: false, reason: "post-repair-verification-blocked:no-verifier" };
    }
    const scheduled: ScheduledAssignment[] = verifiers.map((assignment) => ({ assignment, dependsOn: [] }));
    const reportRefs = new Map<string, ArtifactRef>();
    frontierCell = { goalId, plan: entry.plan, revision: entry.revision };
    try {
      const result = await runExecutionFrontier(store, goalId, scheduled, wiring.executor, {
        contractVersion: record.contractVersion ?? 1,
        executionPlanRef: entry.refs.planRef,
        reportRefFor: (assignmentId, report) => {
          const ref = wiring.reportRefFor(assignmentId, report);
          reportRefs.set(String(assignmentId), ref);
          return ref;
        },
        ...(wiring.errorRefFor !== undefined ? { errorRefFor: wiring.errorRefFor } : {}),
        receiptLog,
      });
      if (result.ok) return { ok: true, results: result.results, reportRefs };
      const failureRef = writeArtifact(JSON.stringify({
        stage: "post-repair-verification-frontier",
        failures: result.failures.map((f) => ({ assignmentId: String(f.assignmentId), reason: String((f.error as Error)?.message ?? f.error) })),
        errors: result.errors ?? [],
        at: new Date().toISOString(),
      }));
      const latest = store.get(goalId);
      if (latest?.state === "VERIFYING") {
        dispatchEvent(store, goalId, { type: "VerificationCompleted", runRef: failureRef, accepted: false, driverFence: currentDriverFence(goalId, driverSessionId) }, receiptLog);
      }
      return { ok: false, reason: "post-repair-verification-frontier-failed" };
    } finally {
      frontierCell = null;
    }
  }

  async function driveCompletionWithRepairs(
    goalId: GoalId,
    entry: FlowPlanEntry,
    wiring: FrontierWiring,
    driverSessionId: string,
    seed?: { results: readonly DispatchResult[]; reportRefs: ReadonlyMap<string, ArtifactRef> },
  ): Promise<RunExecutionOutcome> {
    let frontierResults = seed ? [...seed.results] : null;
    let reportRefs = seed ? new Map(seed.reportRefs) : null;
    for (;;) {
      let record = store.get(goalId);
      if (!record) return { ok: false, reason: "goal-vanished-during-completion" };
      if (record.state === "REPAIRING") {
        const repaired = await executeRepairCycle(goalId, entry, wiring, driverSessionId);
        if (!repaired.ok) return repaired;
        const verified = await executePostRepairVerification(goalId, entry, wiring, driverSessionId);
        if (!verified.ok) {
          if (store.get(goalId)?.state === "REPAIRING") continue;
          return verified;
        }
        frontierResults = verified.results;
        reportRefs = verified.reportRefs;
        record = store.get(goalId);
      }
      if (record?.state !== "VERIFYING") {
        return { ok: false, reason: `completion-driver-unexpected-state:${record?.state ?? "missing"}` };
      }
      if (!frontierResults || !reportRefs) {
        try {
          const durable = storedFrontierResults(goalId);
          frontierResults = durable.results;
          reportRefs = durable.reportRefs;
        } catch (err) {
          return { ok: false, reason: `completion-driver-missing-frontier:${(err as Error)?.message ?? String(err)}` };
        }
      }
      const postExecutor = wiring.postExecutor ?? (async (assignment: Assignment) => wiring.executor(assignment));
      const completed = await runCompletionFlow({
        goalId,
        store,
        receiptLog,
        entry,
        frontierResults,
        reportRefs,
        writeArtifact,
        driverSessionId,
        executeReader: postExecutor,
      });
      if (completed.ok) return { ok: true };
      const after = store.get(goalId);
      if (after?.state !== "REPAIRING") return { ok: false, reason: completed.reason };
      frontierResults = null;
      reportRefs = null;
    }
  }

  function releaseRecoveredMutation(goalId: GoalId, assignmentId: AssignmentId): boolean {
    const record = store.get(goalId);
    const mirror = record?.activeMutationLease;
    if (!record || !mirror || mirror.assignmentId !== assignmentId) return true;
    const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
    const disk = checkLease(root);
    if (disk && "conflict" in disk) return false;
    if (disk && disk.leaseId !== mirror.leaseId) return false;
    if (disk) {
      if (disk.phase === "MUTATING") {
        const settling = advanceLeasePhase(root, disk.leaseId, "SETTLING");
        if (!settling.ok) return false;
      }
      if (!releaseLease(root, disk.leaseId)) return false;
    }
    const fresh = store.get(goalId);
    if (fresh?.activeMutationLease?.leaseId === mirror.leaseId) {
      dispatchEvent(store, goalId, {
        type: "MutationLeaseReleased",
        leaseId: mirror.leaseId,
        driverFence: currentDriverFence(goalId),
      }, receiptLog);
    }
    return true;
  }

  function recoveredEnvelope(
    assignmentId: AssignmentId,
    runId: string,
    sessionId: string,
    output: string,
  ): ReportEnvelope {
    const built = createReportEnvelope({
      assignmentId,
      runId,
      sessionId,
      findings: [{
        id: `${runId}-recovered`,
        severity: "info",
        message: output.slice(0, 4000) || "Recovered successful child result",
        source: "subagent-rpc-recovery",
      }],
      evidenceRefs: [],
    });
    if (!built.ok) throw new Error(`recovery-envelope-invalid:${built.errors.map((e) => e.kind).join(",")}`);
    return built.envelope;
  }

  async function resumeCompletionFromStore(goalId: GoalId): Promise<RunExecutionOutcome> {
    let entry: FlowPlanEntry | undefined;
    try {
      entry = loadFlowPlan(goalId);
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? String(err) };
    }
    if (!entry) return { ok: false, reason: "no-execution-plan" };
    const sessionId = sessionBinding?.sessionId;
    if (!sessionId || !sessionBinding?.rpc || !sessionBinding.live) {
      return { ok: false, reason: "no-live-runtime" };
    }
    let stopDriverHeartbeat: (() => void) | undefined;
    let handoffToWatcher = false;
    try {
      ensureOwnedDriverLease(goalId, sessionId);
      stopDriverHeartbeat = startDriverHeartbeat(goalId, sessionId);
      let record = store.get(goalId);
      if (!record) return { ok: false, reason: "goal-vanished" };
      if (record.state === "VERIFYING" && !record.repairVerificationPending && frontierHasFailedOrCancelled(record)) {
        const failureRef = writeArtifact(JSON.stringify({
          stage: "completion-recovery-frontier",
          reason: "durable frontier contains failed/cancelled assignment",
          at: new Date().toISOString(),
        }));
        dispatchEvent(store, goalId, {
          type: "VerificationCompleted",
          runRef: failureRef,
          accepted: false,
          driverFence: currentDriverFence(goalId),
        }, receiptLog);
        record = store.get(goalId);
      }
      if (["REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"].includes(record?.state ?? "")) {
        const reasonRef = writeArtifact(JSON.stringify({
          goalId: String(goalId),
          from: record!.state,
          reason: "restart read-only completion pipeline from durable frontier",
          at: new Date().toISOString(),
        }));
        dispatchEvent(store, goalId, {
          type: "CompletionRecoveryRestarted",
          reasonRef,
          driverFence: currentDriverFence(goalId),
        }, receiptLog);
        record = store.get(goalId);
      }
      if (record?.state !== "VERIFYING" && record?.state !== "REPAIRING") {
        return { ok: false, reason: `completion-recovery-requires-VERIFYING-or-REPAIRING:not-${record?.state ?? "missing"}` };
      }
      const wiring = frontierWiring ?? buildFrontierWiring();
      frontierWiring = wiring;
      let seed: { results: readonly DispatchResult[]; reportRefs: ReadonlyMap<string, ArtifactRef> } | undefined;

      if (record.state === "REPAIRING") {
        const recoveredRepair = await recoverActiveRepair(goalId);
        if (recoveredRepair.kind === "watching") {
          handoffToWatcher = true;
          return { ok: false, reason: recoveredRepair.reason ?? "recovery-watching-active-repair" };
        }
        if (recoveredRepair.kind === "paused" || recoveredRepair.kind === "terminal") {
          try { releaseOwnedDriverLease(goalId, sessionId); } catch { /* startup recovery can reclaim */ }
          return { ok: false, reason: recoveredRepair.reason ?? `repair-recovery-${recoveredRepair.kind}` };
        }
        record = store.get(goalId);
        if (!record) return { ok: false, reason: "goal-vanished-after-repair-recovery" };
      }

      // A repair mutation is not completion evidence by itself. Crash recovery
      // must resume the fresh verifier frontier before any review/audit/gate.
      if (record.state === "VERIFYING" && record.repairVerificationPending) {
        const verified = await executePostRepairVerification(goalId, entry, wiring, sessionId);
        if (verified.ok) {
          seed = { results: verified.results, reportRefs: verified.reportRefs };
        } else {
          record = store.get(goalId);
          if (!record || record.state !== "REPAIRING") {
            try { releaseOwnedDriverLease(goalId, sessionId); } catch { /* startup recovery can reclaim */ }
            return verified;
          }
        }
      }

      record = store.get(goalId);
      if (!record) return { ok: false, reason: "goal-vanished-before-completion-recovery" };
      if (!seed && record.state === "VERIFYING") seed = storedFrontierResults(goalId);
      const completed = await driveCompletionWithRepairs(goalId, entry, wiring, sessionId, seed);
      try {
        releaseOwnedDriverLease(goalId, sessionId);
      } catch (err) {
        console.error(`Keystone: completion recovery lease release failed for ${String(goalId)} (${(err as Error)?.message ?? String(err)})`);
      }
      return completed;
    } catch (err) {
      return { ok: false, reason: `completion-recovery-failed:${(err as Error)?.message ?? String(err)}` };
    } finally {
      stopDriverHeartbeat?.();
      if (!handoffToWatcher) {
        try { releaseOwnedDriverLease(goalId, sessionId); } catch { /* startup recovery can reclaim */ }
      }
    }
  }

  function dispatchRecoveredFailure(goalId: GoalId, assignmentId: AssignmentId, reason: string): void {
    if (!releaseRecoveredMutation(goalId, assignmentId)) {
      throw new Error(`recovery-authority-release-unresolved:${String(assignmentId)}`);
    }
    const errorRef = writeArtifact(JSON.stringify({
      stage: "execution-recovery",
      assignmentId: String(assignmentId),
      reason,
      at: new Date().toISOString(),
    }));
    dispatchEvent(store, goalId, {
      type: "AssignmentFailed",
      assignmentId,
      errorRef,
      driverFence: currentDriverFence(goalId),
    }, receiptLog);
  }

  function dispatchRecoveredSuccess(goalId: GoalId, assignmentId: AssignmentId, report: ReportEnvelope): void {
    if (!releaseRecoveredMutation(goalId, assignmentId)) {
      throw new Error(`recovery-authority-release-unresolved:${String(assignmentId)}`);
    }
    const reportRef = writeArtifact(JSON.stringify(report));
    dispatchEvent(store, goalId, {
      type: "AssignmentCompleted",
      assignmentId,
      reportRef,
      driverFence: currentDriverFence(goalId),
    }, receiptLog);
  }

  function dispatchRecoveredRepairFailure(goalId: GoalId, assignmentId: AssignmentId, reason: string): boolean {
    if (!releaseRecoveredMutation(goalId, assignmentId)) {
      pauseUnresolvedMutation(goalId, assignmentId, `repair-failure-authority-unresolved:${reason}`);
      return false;
    }
    const errorRef = writeArtifact(JSON.stringify({
      stage: "repair-recovery",
      assignmentId: String(assignmentId),
      reason,
      at: new Date().toISOString(),
    }));
    dispatchEvent(store, goalId, { type: "FatalError", errorRef, driverFence: currentDriverFence(goalId) }, receiptLog);
    return true;
  }

  function dispatchRecoveredRepairSuccess(goalId: GoalId, assignmentId: AssignmentId, report: ReportEnvelope): boolean {
    if (!releaseRecoveredMutation(goalId, assignmentId)) {
      pauseUnresolvedMutation(goalId, assignmentId, "repair-success-authority-unresolved");
      return false;
    }
    const reportRef = writeArtifact(JSON.stringify(report));
    dispatchEvent(store, goalId, {
      type: "RepairCompleted",
      assignmentId,
      reportRef,
      driverFence: currentDriverFence(goalId),
    }, receiptLog);
    return true;
  }

  function recoveryAssignment(entry: FlowPlanEntry, assignmentId: AssignmentId, contractRef: ArtifactRef): Assignment {
    const planned = entry.plan.assignments.find((a) => a.id === String(assignmentId));
    if (!planned) throw new Error(`recovery-unknown-assignment:${String(assignmentId)}`);
    return {
      id: assignmentId,
      role: planned.role === "implementation" ? "implementer" : "verifier",
      targetFiles: [...planned.targetFiles],
      acceptanceCriteria: [...planned.acceptanceCriteria],
      contractRef,
    };
  }

  function pauseUnresolvedMutation(goalId: GoalId, assignmentId: AssignmentId, detail: string): void {
    const record = store.get(goalId);
    if (!record || isTerminal(record) || record.state === "CANCELLING" || record.state === "PAUSED") return;
    dispatchEvent(store, goalId, {
      type: "PauseRequested",
      reason: `unresolved-mutation:${String(assignmentId)}:${detail}`,
      driverFence: currentDriverFence(goalId),
    }, receiptLog);
  }

  /**
   * Reattach to an RPC run that is still active after extension/controller
   * restart. Mutation runs renew the SAME filesystem lease; if renewal fails,
   * the run is stopped best-effort and the assignment fails closed.
   */
  function watchRecoveredRun(
    goalId: GoalId,
    assignmentId: AssignmentId,
    runId: string,
    runSessionId: string,
    isImplementation: boolean,
  ): void {
    if (recoveryWatchers.has(runId)) return;
    const rpc = sessionBinding?.rpc;
    if (!rpc) return;
    let heartbeat: NodeJS.Timeout | undefined;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      off();
      recoveryWatchers.delete(runId);
    };
    const renewMutation = (): boolean => {
      const ownerSession = sessionBinding?.sessionId;
      if (!ownerSession) return false;
      try {
        ensureOwnedDriverLease(goalId, ownerSession);
      } catch {
        return false;
      }
      if (!isImplementation) return true;
      const record = store.get(goalId);
      const mirror = record?.activeMutationLease;
      if (!record || !mirror || mirror.assignmentId !== assignmentId || record.state !== "EXECUTING") return false;
      const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
      const renewed = heartbeatLease(root, mirror.leaseId, 120_000);
      if (!renewed || renewed.phase !== "MUTATING") return false;
      dispatchEvent(store, goalId, {
        type: "MutationLeaseAttached",
        lease: renewed,
        driverFence: currentDriverFence(goalId),
      }, receiptLog);
      return true;
    };
    if (!renewMutation()) {
      void rpc.stop(runId).catch(() => undefined);
      dispatchRecoveredFailure(goalId, assignmentId, "mutation-lease-not-recoverable");
      return;
    }
    if (isImplementation) {
      heartbeat = setInterval(() => {
        try {
          if (renewMutation()) return;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          void rpc.stop(runId).catch(() => undefined);
          dispatchRecoveredFailure(goalId, assignmentId, "mutation-lease-heartbeat-lost");
          stop();
          void reconcileExecutionGoal(goalId);
        } catch (err) {
          console.error(`Keystone: recovered mutation heartbeat failed for ${runId} (${(err as Error)?.message ?? String(err)})`);
        }
      }, 40_000);
      heartbeat.unref?.();
    }
    const off = rpc.onAsyncComplete((payload) => {
      if (payload.runId !== runId) return;
      stop();
      void (async () => {
        try {
          if (completionStatusOf(payload) === "SUCCEEDED") {
            let report: ReportEnvelope;
            try {
              report = isImplementation
                ? toCompletionEnvelope(assignmentId, runId, runSessionId, payload)
                : toVerifierEnvelope(assignmentId, runId, runSessionId, payload);
            } catch (err) {
              dispatchRecoveredFailure(
                goalId,
                assignmentId,
                `recovered-result-invalid:${(err as Error)?.message ?? String(err)}`,
              );
              await reconcileExecutionGoal(goalId);
              return;
            }
            dispatchRecoveredSuccess(goalId, assignmentId, report);
          } else {
            dispatchRecoveredFailure(goalId, assignmentId, "recovered-child-reported-failure");
          }
          await reconcileExecutionGoal(goalId);
        } catch (err) {
          console.error(`Keystone: recovered completion handling failed for ${runId} (${(err as Error)?.message ?? String(err)})`);
        }
      })();
    });
    recoveryWatchers.set(runId, { stop, ...(heartbeat ? { heartbeat } : {}) });
  }

  function watchRecoveredRepairRun(
    goalId: GoalId,
    assignmentId: AssignmentId,
    runId: string,
    runSessionId: string,
  ): void {
    if (recoveryWatchers.has(runId)) return;
    const rpc = sessionBinding?.rpc;
    if (!rpc) return;
    let heartbeat: NodeJS.Timeout | undefined;
    let stopped = false;
    let off: () => void = () => {};
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      off();
      recoveryWatchers.delete(runId);
    };
    const renew = (): boolean => {
      const ownerSession = sessionBinding?.sessionId;
      if (!ownerSession) return false;
      try {
        ensureOwnedDriverLease(goalId, ownerSession);
      } catch {
        return false;
      }
      const record = store.get(goalId);
      const mirror = record?.activeMutationLease;
      if (!record || record.state !== "REPAIRING" || !mirror || mirror.assignmentId !== assignmentId) return false;
      const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
      const renewed = heartbeatLease(root, mirror.leaseId, 120_000);
      if (!renewed || (renewed.phase !== "MUTATING" && renewed.phase !== "SETTLING")) return false;
      dispatchEvent(store, goalId, {
        type: "MutationLeaseAttached",
        lease: renewed,
        driverFence: currentDriverFence(goalId),
      }, receiptLog);
      return true;
    };
    if (!renew()) {
      void rpc.stop(runId).catch(() => undefined);
      dispatchRecoveredRepairFailure(goalId, assignmentId, "repair-mutation-lease-not-recoverable");
      return;
    }
    heartbeat = setInterval(() => {
      try {
        if (renew()) return;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        void rpc.stop(runId).catch(() => undefined);
        dispatchRecoveredRepairFailure(goalId, assignmentId, "repair-mutation-lease-heartbeat-lost");
        stop();
        try { releaseBoundDriverLease(goalId); } catch { /* startup recovery can reclaim */ }
      } catch (err) {
        console.error(`Keystone: recovered repair heartbeat failed for ${runId} (${(err as Error)?.message ?? String(err)})`);
      }
    }, 40_000);
    heartbeat.unref?.();
    off = rpc.onAsyncComplete((payload) => {
      if (payload.runId !== runId) return;
      stop();
      void (async () => {
        try {
          if (completionStatusOf(payload) === "SUCCEEDED") {
            let report: ReportEnvelope;
            try {
              report = toCompletionEnvelope(assignmentId, runId, runSessionId, payload);
            } catch (err) {
              const terminal = dispatchRecoveredRepairFailure(
                goalId,
                assignmentId,
                `recovered-repair-result-invalid:${(err as Error)?.message ?? String(err)}`,
              );
              if (terminal) try { releaseBoundDriverLease(goalId); } catch { /* startup recovery can reclaim */ }
              return;
            }
            if (dispatchRecoveredRepairSuccess(goalId, assignmentId, report)) {
              await resumeCompletionFromStore(goalId);
            }
          } else {
            const terminal = dispatchRecoveredRepairFailure(goalId, assignmentId, "recovered-repair-child-reported-failure");
            if (terminal) try { releaseBoundDriverLease(goalId); } catch { /* startup recovery can reclaim */ }
          }
        } catch (err) {
          console.error(`Keystone: recovered repair completion failed for ${runId} (${(err as Error)?.message ?? String(err)})`);
        }
      })();
    });
    recoveryWatchers.set(runId, { stop, ...(heartbeat ? { heartbeat } : {}) });
  }

  async function recoverActiveRepair(
    goalId: GoalId,
  ): Promise<{ kind: "fresh" | "settled" | "watching" | "paused" | "terminal"; reason?: string }> {
    const record = store.get(goalId);
    if (!record || record.state !== "REPAIRING") return { kind: "fresh" };
    const mirror = record.activeMutationLease;
    if (!mirror) return { kind: "fresh" };
    const unsafePriorMutation = mirror.phase === "MUTATING" || mirror.phase === "SETTLING";
    const rpc = sessionBinding?.rpc;
    if (!rpc) return { kind: "paused", reason: "no-live-runtime" };
    const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
    const disk = checkLease(root);
    if (disk && "conflict" in disk) {
      pauseUnresolvedMutation(goalId, mirror.assignmentId, `repair-lease-conflict:${disk.reason}`);
      return { kind: "paused", reason: "repair-recovery-lease-conflict" };
    }
    if (disk && disk.leaseId !== mirror.leaseId) {
      pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-lease-identity-changed");
      return { kind: "paused", reason: "repair-recovery-lease-identity-changed" };
    }
    const run = record.activeRuns[mirror.assignmentId];
    const realRunId = run?.runId && !run.runId.startsWith("pending-") ? run.runId : null;
    if (realRunId) {
      try {
        const result = await rpc.result(realRunId, 3_000);
        if (result.ready) {
          if (result.outcome === "success") {
            const report = recoveredEnvelope(mirror.assignmentId, realRunId, run?.sessionId || sessionBinding?.sessionId || "recovered-repair", result.output);
            if (!dispatchRecoveredRepairSuccess(goalId, mirror.assignmentId, report)) {
              return { kind: "paused", reason: "repair-recovery-authority-unresolved" };
            }
            return { kind: "settled" };
          }
          const terminal = dispatchRecoveredRepairFailure(goalId, mirror.assignmentId, `rpc-terminal-${result.state}:${result.outcome}`);
          return terminal
            ? { kind: "terminal", reason: `repair-recovery-rpc-terminal-${result.state}` }
            : { kind: "paused", reason: "repair-recovery-authority-unresolved" };
        }
        if (disk && (disk.phase === "MUTATING" || disk.phase === "SETTLING")) {
          watchRecoveredRepairRun(goalId, mirror.assignmentId, realRunId, run?.sessionId || sessionBinding?.sessionId || "recovered-repair");
          return { kind: "watching", reason: "recovery-watching-active-repair" };
        }
        void rpc.stop(realRunId, 3_000).catch(() => undefined);
        if (unsafePriorMutation) {
          const terminal = dispatchRecoveredRepairFailure(
            goalId,
            mirror.assignmentId,
            `repair-run-lost-after-${mirror.phase.toLowerCase()}`,
          );
          return terminal
            ? { kind: "terminal", reason: "repair-recovery-interrupted-mutation" }
            : { kind: "paused", reason: "repair-recovery-authority-unresolved" };
        }
        if (!releaseRecoveredMutation(goalId, mirror.assignmentId)) {
          pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-run-active-with-unreleasable-authority");
          return { kind: "paused", reason: "repair-recovery-authority-unresolved" };
        }
        return { kind: "fresh" };
      } catch {
        if (disk && (disk.phase === "MUTATING" || disk.phase === "SETTLING")) {
          pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-rpc-run-not-resolvable-with-live-authority");
          return { kind: "paused", reason: "repair-recovery-paused-unresolved-mutation" };
        }
        void rpc.stop(realRunId, 3_000).catch(() => undefined);
        if (unsafePriorMutation) {
          const terminal = dispatchRecoveredRepairFailure(
            goalId,
            mirror.assignmentId,
            `repair-rpc-unresolvable-after-${mirror.phase.toLowerCase()}`,
          );
          return terminal
            ? { kind: "terminal", reason: "repair-recovery-interrupted-mutation" }
            : { kind: "paused", reason: "repair-recovery-authority-unresolved" };
        }
        if (!releaseRecoveredMutation(goalId, mirror.assignmentId)) {
          pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-run-unresolvable-and-authority-unreleasable");
          return { kind: "paused", reason: "repair-recovery-authority-unresolved" };
        }
        return { kind: "fresh" };
      }
    }
    if (disk && (disk.phase === "MUTATING" || disk.phase === "SETTLING")) {
      pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-live-authority-without-durable-run-id");
      return { kind: "paused", reason: "repair-recovery-paused-unbound-mutation" };
    }
    if (unsafePriorMutation) {
      const terminal = dispatchRecoveredRepairFailure(
        goalId,
        mirror.assignmentId,
        `repair-missing-run-id-after-${mirror.phase.toLowerCase()}`,
      );
      return terminal
        ? { kind: "terminal", reason: "repair-recovery-interrupted-mutation" }
        : { kind: "paused", reason: "repair-recovery-authority-unresolved" };
    }
    if (!releaseRecoveredMutation(goalId, mirror.assignmentId)) {
      pauseUnresolvedMutation(goalId, mirror.assignmentId, "repair-pre-spawn-authority-unreleasable");
      return { kind: "paused", reason: "repair-recovery-authority-unresolved" };
    }
    return { kind: "fresh" };
  }

  async function reconcileExecutionGoal(goalId: GoalId): Promise<RunExecutionOutcome> {
    const rpc = sessionBinding?.rpc;
    const sessionId = sessionBinding?.sessionId;
    if (!rpc || !sessionId || !sessionBinding?.live) return { ok: false, reason: "no-live-runtime" };
    let entry: FlowPlanEntry | undefined;
    try {
      entry = loadFlowPlan(goalId);
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? String(err) };
    }
    if (!entry) return { ok: false, reason: "no-execution-plan" };
    try {
      ensureOwnedDriverLease(goalId, sessionId);
    } catch (err) {
      return { ok: false, reason: `recovery-${(err as Error)?.message ?? String(err)}` };
    }
    let record = store.get(goalId);
    if (!record) return { ok: false, reason: "goal-vanished" };
    if (record.state === "VERIFYING" || record.state === "REPAIRING" || ["REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"].includes(record.state)) {
      return resumeCompletionFromStore(goalId);
    }
    if (record.state !== "EXECUTING" || !record.executionPlan) {
      return { ok: false, reason: `recovery-unexpected-state:${record.state}` };
    }
    const contractRef = record.activeContractRef ?? entry.refs.contractRef;
    const frontierCellOnce = { goalId, plan: entry.plan, revision: entry.revision };
    for (const node of record.executionPlan.assignments) {
      record = store.get(goalId)!;
      const state = record.assignmentStates[node.id];
      if (state === "COMPLETED") continue;
      if (state === "FAILED" || state === "CANCELLED") continue;
      // Normal scheduling is structural: a dependency settling as FAILED is
      // still terminal, and later independent verification may run before the
      // lifecycle decides whether repair is required. Recovery must mirror it.
      const depsReady = node.dependsOn.every((dep) => isAssignmentTerminal(record!.assignmentStates[dep]));
      if (!depsReady) continue;
      const assignment = recoveryAssignment(entry, node.id, contractRef);
      const run = record.activeRuns[node.id];
      const realRunId = run?.runId && !run.runId.startsWith("pending-") ? run.runId : null;
      if (realRunId) {
        try {
          const result: RpcResult = await rpc.result(realRunId, 3_000);
          if (result.ready) {
            if (result.outcome === "success") {
              if (assignment.role === "implementer") {
                dispatchRecoveredSuccess(
                  goalId,
                  node.id,
                  recoveredEnvelope(node.id, realRunId, run?.sessionId || sessionId, result.output),
                );
                continue;
              }
              const verified = verifierEnvelopeFromRecoveredOutput(
                node.id,
                realRunId,
                run?.sessionId || sessionId,
                result.output,
              );
              if (verified) {
                dispatchRecoveredSuccess(goalId, node.id, verified);
                continue;
              }
              // The run ended successfully at the process level, but no
              // machine verifier verdict is recoverable. Read-only work is
              // safe to repeat, so fall through to a fresh verifier below.
            } else {
              dispatchRecoveredFailure(goalId, node.id, `rpc-terminal-${result.state}:${result.outcome}`);
              continue;
            }
          } else {
            watchRecoveredRun(goalId, node.id, realRunId, run?.sessionId || sessionId, assignment.role === "implementer");
            continue;
          }
        } catch (err) {
          // A read-only run can be safely repeated. A mutation run can only be
          // repeated once its old authority is provably gone.
          if (assignment.role === "implementer" && record.activeMutationLease?.assignmentId === node.id) {
            const mirror = record.activeMutationLease;
            const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
            const disk = checkLease(root);
            if (disk && !("conflict" in disk) && disk.leaseId === mirror.leaseId) {
              pauseUnresolvedMutation(goalId, node.id, "rpc-run-not-resolvable-with-live-authority");
              return { ok: false, reason: "recovery-paused-unresolved-mutation" };
            }
            const unsafePriorMutation = mirror.phase === "MUTATING" || mirror.phase === "SETTLING";
            if (unsafePriorMutation) {
              // The process result is unavailable and the child crossed the
              // write boundary. Do not silently rerun it as if no mutation
              // occurred; record a failed slot so verification/repair sees
              // the actual workspace left by the interrupted writer.
              dispatchRecoveredFailure(
                goalId,
                node.id,
                `rpc-run-unresolvable-after-${mirror.phase.toLowerCase()}`,
              );
              continue;
            }
            if (!releaseRecoveredMutation(goalId, node.id)) {
              pauseUnresolvedMutation(goalId, node.id, "rpc-run-unresolvable-and-authority-unreleasable");
              return { ok: false, reason: "recovery-paused-unresolved-mutation" };
            }
          }
          void err;
        }
      } else if (assignment.role === "implementer" && record.activeMutationLease?.assignmentId === node.id) {
        const mirror = record.activeMutationLease;
        const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
        const disk = checkLease(root);
        if (disk && !("conflict" in disk) && disk.leaseId === mirror.leaseId) {
          pauseUnresolvedMutation(goalId, node.id, "spawned-run-id-not-durable-with-live-authority");
          return { ok: false, reason: "recovery-paused-unbound-mutation" };
        }
        if (mirror.phase === "MUTATING" || mirror.phase === "SETTLING") {
          // No durable run id exists to prove what the writer completed. Treat
          // the interrupted mutation as an explicit failed assignment; never
          // launch a second writer over an unknown partial result.
          dispatchRecoveredFailure(
            goalId,
            node.id,
            `missing-run-id-after-${mirror.phase.toLowerCase()}`,
          );
          continue;
        }
        if (!releaseRecoveredMutation(goalId, node.id)) {
          pauseUnresolvedMutation(goalId, node.id, "unbound-mutation-authority-unreleasable");
          return { ok: false, reason: "recovery-paused-unbound-mutation" };
        }
      }

      frontierCell = frontierCellOnce;
      try {
        const report = await sessionExecutor(assignment);
        dispatchRecoveredSuccess(goalId, node.id, report);
      } catch (err) {
        dispatchRecoveredFailure(goalId, node.id, `recovery-rerun-failed:${(err as Error)?.message ?? String(err)}`);
      } finally {
        frontierCell = null;
      }
    }

    record = store.get(goalId);
    if (!record) return { ok: false, reason: "goal-vanished" };
    if (record.state === "VERIFYING") return resumeCompletionFromStore(goalId);
    // A failed slot is evidence for verification/repair, not a reason to
    // terminalize the goal during recovery. If the frontier is not yet fully
    // terminal, watchers/reruns will drive the remaining slots.
    return { ok: false, reason: "recovery-watching-active-runs" };
  }

  async function reconcileRuntimeRecovery(): Promise<void> {
    for (const goal of store.list()) {
      if (isTerminal(goal)) continue;
      if (goal.state === "EXECUTING") {
        const result = await reconcileExecutionGoal(goal.goalId);
        if (!result.ok && result.reason !== "recovery-watching-active-runs") {
          console.error(`Keystone: execution recovery for ${String(goal.goalId)} incomplete (${result.reason ?? "unknown"})`);
        }
      } else if (["VERIFYING", "REPAIRING", "REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"].includes(goal.state)) {
        const result = await resumeCompletionFromStore(goal.goalId);
        if (!result.ok && result.reason !== "recovery-watching-active-repair") {
          console.error(`Keystone: completion recovery for ${String(goal.goalId)} incomplete (${result.reason ?? "unknown"})`);
        }
      }
    }
  }

  async function cancelGoalRuntime(
    goalId: GoalId,
    reason: string,
  ): Promise<{ state: GoalState; outcome: "SETTLED" | "INDETERMINATE" }> {
    let record = store.get(goalId);
    if (!record) throw new Error(`Goal ${goalId} not found`);
    if (isTerminal(record)) return { state: record.state, outcome: "SETTLED" };

    // A user cancellation is authoritative. If no live driver exists, mint a
    // fresh fence; otherwise use the currently active fence to revoke work.
    const leaseActive = record.activeDriverLease && new Date(record.activeDriverLease.expiresAt).getTime() > Date.now();
    if (!leaseActive) {
      const cancelSession = sessionBinding?.sessionId ?? `keystone:cancel:${String(goalId)}`;
      ensureOwnedDriverLease(goalId, cancelSession);
      record = store.get(goalId)!;
    }
    const cancellationDriver = record.activeDriverLease;
    if (!cancellationDriver) throw new Error("cancellation-driver-lease-missing");
    dispatchEvent(store, goalId, {
      type: "CancelRequested",
      reason,
      driverFence: currentDriverFence(goalId, cancellationDriver.sessionId),
    }, receiptLog);
    record = store.get(goalId)!;

    const rpc = sessionBinding?.rpc;
    const activeRunIds = Object.values(record.activeRuns)
      .flatMap((run) => run && run.status === "RUNNING" && !run.runId.startsWith("pending-") ? [run.runId] : []);
    for (const runId of activeRunIds) {
      recoveryWatchers.get(runId)?.stop();
      if (rpc) void rpc.stop(runId, 3_000).catch(() => undefined);
    }

    const mutation = record.activeMutationLease;
    let outcome: "SETTLED" | "INDETERMINATE" = "SETTLED";
    if (mutation) {
      const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
      const disk = checkLease(root);
      let revocationResolved = true;
      if (disk && "conflict" in disk) {
        revocationResolved = false;
      } else if (disk && disk.leaseId !== mutation.leaseId) {
        revocationResolved = false;
      } else if (disk) {
        // Removing the file is the revocation primitive: the child guard
        // re-reads it on every mutating call, so writes stop immediately.
        revocationResolved = releaseLease(root, mutation.leaseId);
      }
      const phase = mutation.phase;
      outcome = !revocationResolved || phase === "MUTATING" ? "INDETERMINATE" : "SETTLED";
      if (revocationResolved) {
        const current = store.get(goalId);
        if (current?.activeMutationLease?.leaseId === mutation.leaseId) {
          dispatchEvent(store, goalId, {
            type: "MutationLeaseReleased",
            leaseId: mutation.leaseId,
            driverFence: currentDriverFence(goalId, cancellationDriver.sessionId),
          }, receiptLog);
        }
      }
    }

    const cleanupRef = writeArtifact(JSON.stringify({
      goalId: String(goalId),
      reason,
      outcome,
      stoppedRuns: activeRunIds,
      rollbackClaimed: false,
      at: new Date().toISOString(),
    }));
    dispatchEvent(store, goalId, {
      type: "CancellationSettled",
      cleanupRef,
      mutationOutcome: outcome,
      driverFence: currentDriverFence(goalId, cancellationDriver.sessionId),
    }, receiptLog);
    const final = store.get(goalId)!;
    if (final.state === "CANCELLED") {
      try {
        releaseDriverLeasePersisted(store, goalId, {
          leaseId: cancellationDriver.leaseId,
          sessionId: cancellationDriver.sessionId,
          fencingToken: cancellationDriver.fencingToken,
        });
      } catch { /* startup recovery can clear it */ }
    }
    return { state: final.state, outcome };
  }

  /**
   * Production runExecution: persisted driver lease -> preparation walk
   * (PREPARING -> RECONCILING -> CONTRACT_REVIEW -> READY) from the cached
   * flow plan -> runExecutionFrontier. Every failure returns ok:false with a
   * typed reason; nothing is silently suppressed.
   */
  async function runExecution(goalId: GoalId): Promise<RunExecutionOutcome> {
    const record = store.get(goalId);
    if (!record) throw new Error(`Goal ${goalId} not found`);
    if (!record.lifecycleDepth) return { ok: false, reason: "depth-not-approved" };
    // A missing/not-ready live RPC bridge is an availability condition, not a
    // goal failure. Keep PREPARING/approved state intact so /goal release can
    // retry once pi-subagents is available. Tests may inject custom frontier
    // wiring without a session binding, so that explicit seam still works.
    if (sessionBinding) {
      if (!sessionBinding.live || !sessionBinding.rpc?.ready) return { ok: false, reason: "no-live-runtime" };
    } else if (!frontierWiring) {
      return { ok: false, reason: "no-live-runtime" };
    }
    if (record.state === "EXECUTING") return reconcileExecutionGoal(goalId);
    if (record.state === "VERIFYING" || record.state === "REPAIRING" || ["REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"].includes(record.state)) {
      return resumeCompletionFromStore(goalId);
    }
    let entry: FlowPlanEntry | undefined;
    try {
      entry = loadFlowPlan(goalId);
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? String(err) };
    }
    if (!entry || entry.plan.assignments.length === 0) return { ok: false, reason: "no-execution-plan" };

    // A prepared bundle is authority-bearing input. For every pre-execution
    // state, reject it if the git revision/dirt token changed underneath us.
    // The command layer can re-prepare and re-confirm; direct callers cannot
    // bypass that freshness gate.
    if (
      ["PREPARING", "PAUSED", "RECONCILING", "CONTRACT_REVIEW", "READY"].includes(record.state)
      && entry.snapshot.revision !== null
    ) {
      let currentSnapshot: WorkspaceSnapshot;
      try {
        currentSnapshot = await captureSnapshot(record.workspace.canonicalRoot || record.workspace.requestedRoot);
      } catch (err) {
        return { ok: false, reason: `workspace-freshness-unavailable:${(err as Error)?.message ?? String(err)}` };
      }
      if (
        currentSnapshot.revision !== entry.snapshot.revision
        || currentSnapshot.dirtySignature !== entry.snapshot.dirtySignature
      ) {
        return { ok: false, reason: "workspace-drift-reprepare-required" };
      }
    }

    if (record.state === "PAUSED" && record.activeMutationLease) {
      return { ok: false, reason: "paused-unresolved-mutation-authority" };
    }

    const leaseSession = sessionBinding?.sessionId ?? `keystone:exec:${String(goalId)}`;
    try {
      // Resume always rotates the driver fence, even in the same host session,
      // so a completion from work launched before the pause cannot be accepted
      // after release.
      if (record.state === "PAUSED" && record.activeDriverLease?.sessionId === leaseSession) {
        releaseOwnedDriverLease(goalId, leaseSession);
      }
      ensureOwnedDriverLease(goalId, leaseSession);
    } catch (err) {
      return { ok: false, reason: `lease-acquire-failed:${(err as Error)?.message ?? String(err)}` };
    }
    const stopDriverHeartbeat = startDriverHeartbeat(goalId, leaseSession);
    const fenceOf = (): number => currentDriverFence(goalId, leaseSession);
    const walk = (event: GoalEvent): string | null => {
      try {
        dispatchEvent(store, goalId, event, receiptLog);
        return null;
      } catch (err) {
        return (err as Error)?.message ?? String(err);
      }
    };
    try {
      let cur = store.get(goalId);
      if (!cur) return { ok: false, reason: "goal-vanished" };
      if (cur.state === "PAUSED") {
        const fail = walk({ type: "ResumeRequested", driverFence: fenceOf() });
        if (fail) return { ok: false, reason: `walk-failed:resume:${fail}` };
        cur = store.get(goalId);
        if (!cur) return { ok: false, reason: "goal-vanished" };
      }
      if (
        (cur.state === "PREPARING" || cur.state === "RECONCILING")
        && (
          cur.preparation.baselineJob.status !== "SUCCEEDED"
          || cur.preparation.provisionalPlanJob.status !== "SUCCEEDED"
        )
      ) {
        const attemptId = randomUUID();
        let fail = walk({
          type: "PreparationProgress",
          job: "baseline",
          planEpoch: cur.planEpoch,
          attemptId,
          basedOnRevision: entry.revision,
          status: "SUCCEEDED",
          driverFence: fenceOf(),
          artifactRef: entry.refs.baselineRef,
        });
        if (fail) return { ok: false, reason: `walk-failed:baseline:${fail}` };
        cur = store.get(goalId);
        if (!cur) return { ok: false, reason: "goal-vanished" };
        fail = walk({
          type: "PreparationProgress",
          job: "plan",
          planEpoch: cur.planEpoch,
          attemptId,
          basedOnRevision: entry.revision,
          status: "SUCCEEDED",
          driverFence: fenceOf(),
          artifactRef: entry.refs.planRef,
        });
        if (fail) return { ok: false, reason: `walk-failed:plan:${fail}` };
        cur = store.get(goalId);
        if (!cur) return { ok: false, reason: "goal-vanished" };
      }
      if (cur.state === "RECONCILING") {
        const fail = walk({
          type: "ReconciliationCompleted",
          reportRef: entry.refs.planRef,
          planEpoch: cur.planEpoch,
          provisionalPlanRef: entry.refs.planRef,
          basedOnRevision: entry.revision,
          decision: "ACCEPT_PLAN_BASIS",
          driverFence: fenceOf(),
        });
        if (fail) return { ok: false, reason: `walk-failed:reconcile:${fail}` };
        cur = store.get(goalId);
        if (!cur) return { ok: false, reason: "goal-vanished" };
      }
      if (cur.state === "CONTRACT_REVIEW") {
        const fail = walk({
          type: "ContractFrozen",
          contractVersion: entry.contract.version as number,
          contractRef: entry.refs.contractRef,
          driverFence: fenceOf(),
        });
        if (fail) return { ok: false, reason: `walk-failed:contract:${fail}` };
        cur = store.get(goalId);
        if (!cur) return { ok: false, reason: "goal-vanished" };
      }
      if (cur.state !== "READY") {
        return { ok: false, reason: `unexpected-state:${cur.state} (expected READY after preparation walk)` };
      }
      const wiring = frontierWiring ?? buildFrontierWiring();
      frontierWiring = wiring;
      const contractRef = cur.activeContractRef ?? entry.refs.contractRef;
      // The workspace mutation lease is exclusive, so implementation children
      // must be serialized. Readers/verifiers run only after the last mutation;
      // this also prevents the session-wide mutation ceiling from widening a
      // concurrently spawning read-only child. Independent readers may still
      // run in parallel once mutation authority is closed.
      const assignments: Assignment[] = entry.plan.assignments.map((a) => ({
        id: a.id as Assignment["id"],
        role: a.role === "implementation" ? "implementer" : "verifier",
        targetFiles: [...a.targetFiles],
        acceptanceCriteria: [...a.acceptanceCriteria],
        contractRef,
      }));
      const implementationIds = assignments
        .filter((assignment) => assignment.role === "implementer")
        .map((assignment) => assignment.id);
      const lastImplementation = implementationIds.at(-1) ?? null;
      const scheduled: ScheduledAssignment[] = [];
      let previousImplementation: Assignment["id"] | null = null;
      for (const assignment of assignments) {
        // Mutation authority is session-wide while a writer is live. Chain all
        // writers, then place every reader/verifier behind the LAST writer so
        // no read-only child can spawn while the mutation ceiling is widened.
        // Once writers finish, independent readers may run in parallel.
        const dependsOn = assignment.role === "implementer"
          ? (previousImplementation ? [previousImplementation] : [])
          : (lastImplementation ? [lastImplementation] : []);
        scheduled.push({ assignment, dependsOn });
        if (assignment.role === "implementer") previousImplementation = assignment.id;
      }
      frontierCell = { goalId, plan: entry.plan, revision: entry.revision };
      let result: Awaited<ReturnType<typeof runExecutionFrontier>>;
      const reportRefs = new Map<string, ArtifactRef>();
      try {
        result = await runExecutionFrontier(store, goalId, scheduled, wiring.executor, {
          contractVersion: cur.contractVersion ?? 1,
          executionPlanRef: entry.refs.planRef,
          reportRefFor: (assignmentId, report) => {
            const ref = wiring.reportRefFor(assignmentId, report);
            reportRefs.set(String(assignmentId), ref);
            return ref;
          },
          ...(wiring.errorRefFor !== undefined ? { errorRefFor: wiring.errorRefFor } : {}),
          receiptLog,
        });
      } finally {
        frontierCell = null;
      }
      if (result.ok) {
        // Refresh and re-assert ownership before verification/audit/repair,
        // which may run ecosystem checks and several child sessions.
        ensureOwnedDriverLease(goalId, leaseSession);
        const completed = await driveCompletionWithRepairs(goalId, entry, wiring, leaseSession, {
          results: result.results,
          reportRefs,
        });
        try {
          releaseOwnedDriverLease(goalId, leaseSession);
        } catch (err) {
          console.error(
            `Keystone: driver lease release after completion flow failed for ${String(goalId)} (${(err as Error)?.message ?? String(err)})`,
          );
        }
        return completed;
      }
      // Non-lossy failure mapping: counts plus per-assignment messages.
      const parts = [`${result.results.length} completed`, `${result.failures.length} failed`];
      for (const f of result.failures.slice(0, 5)) {
        parts.push(`${String(f.assignmentId)}: ${String((f.error as Error)?.message ?? f.error).slice(0, 200)}`);
      }
      for (const e of (result.errors ?? []).slice(0, 3)) parts.push(`dag: ${String(e).slice(0, 200)}`);
      const reason = `frontier-incomplete: ${parts.join("; ")}`;
      const errorRef = writeArtifact(reason);
      const current = store.get(goalId);
      const authorityDeclined = reason.includes("dirty-conflict-approval-declined") || reason.includes("dirty-conflict-approval-unavailable");
      const authorityUnresolved = reason.includes("mutation-authority-unresolved");
      let outcome: RunExecutionOutcome = { ok: false, reason };
      try {
        if (authorityUnresolved && current && !isTerminal(current)) {
          if (current.state !== "PAUSED" && current.state !== "CANCELLING") {
            const unresolvedAssignment = current.activeMutationLease?.assignmentId
              ?? (entry.plan.assignments.find((a) => a.role === "implementation")?.id as AssignmentId | undefined)
              ?? ("mutation" as AssignmentId);
            pauseUnresolvedMutation(goalId, unresolvedAssignment, reason);
          }
          outcome = { ok: false, reason: `frontier-paused:${reason}` };
        } else if (authorityDeclined && current && !isTerminal(current)) {
          dispatchEvent(store, goalId, { type: "BlockDeclared", blockerRefs: [errorRef], driverFence: fenceOf() }, receiptLog);
          outcome = { ok: false, reason: `frontier-blocked:${reason}` };
        } else if (current?.state === "VERIFYING") {
          dispatchEvent(store, goalId, { type: "VerificationCompleted", runRef: errorRef, accepted: false, driverFence: fenceOf() }, receiptLog);
          outcome = await driveCompletionWithRepairs(goalId, entry, wiring, leaseSession);
        } else {
          dispatchEvent(store, goalId, { type: "FatalError", errorRef, driverFence: fenceOf() }, receiptLog);
        }
      } catch (err) {
        outcome = { ok: false, reason: `${reason}; failure-routing-error:${(err as Error)?.message ?? String(err)}` };
      }
      try {
        releaseOwnedDriverLease(goalId, leaseSession);
      } catch {
        // Recovery will clear an orphaned lease on the next session start.
      }
      return outcome;
    } catch (err) {
      frontierCell = null;
      return { ok: false, reason: `runExecution-threw:${(err as Error)?.message ?? String(err)}` };
    } finally {
      stopDriverHeartbeat();
      try {
        releaseOwnedDriverLease(goalId, leaseSession);
      } catch (err) {
        console.error(
          `Keystone: driver lease final cleanup failed for ${String(goalId)} (${(err as Error)?.message ?? String(err)})`,
        );
      }
    }
  }

  return {
    goal,
    hooks,
    registerFrontierWiring(wiring: FrontierWiring): void {
      frontierWiring = wiring;
    },
    buildFrontierWiring,
    runExecution,
    cancelGoal: cancelGoalRuntime,
    reconcileRuntimeRecovery,
    store,
    receiptLog,
    writeArtifact,
    attachFlowPlan(goalId: GoalId, entry: FlowPlanEntry): void {
      flowPlans.set(goalId as string, entry);
    },
    getFlowPlan(goalId: GoalId): FlowPlanEntry | undefined {
      return loadFlowPlan(goalId);
    },
    bindSessionRuntime(binding: SessionBinding | null): void {
      if (binding === null) {
        for (const watcher of recoveryWatchers.values()) watcher.stop();
        recoveryWatchers.clear();
      }
      sessionBinding = binding;
    },
    /**
     * agent_settled fan-in: one typed no-transition receipt per
     * non-terminal goal (replaces the dead per-goal internal hook).
     */
    noteAgentSettled(): number {
      let noted = 0;
      for (const g of store.list()) {
        if (isTerminal(g)) continue;
        receiptLog.push({
          goalId: g.goalId,
          eventType: "AgentSettled",
          fromState: g.state,
          toState: g.state,
          recordVersion: g.recordVersion,
          timestamp: new Date().toISOString(),
          transitionId: randomUUID(),
        });
        noted++;
      }
      return noted;
    },
    /**
     * session_before_compact fan-in: record continuation context per
     * active goal. Returns no compaction override — resume happens
     * post-compact via resume()/resumeAfterCompaction.
     */
    noteCompaction(): number {
      let noted = 0;
      for (const g of store.list()) {
        if (isTerminal(g)) continue;
        const continued = buildContinuationContext(store, g.goalId as GoalId);
        receiptLog.push({
          goalId: g.goalId,
          eventType: continued ? "Compaction:context-recorded" : "Compaction:no-context",
          fromState: g.state,
          toState: g.state,
          recordVersion: g.recordVersion,
          timestamp: new Date().toISOString(),
          transitionId: randomUUID(),
        });
        noted++;
      }
      return noted;
    },
    dispatchEvent(
      goalId: GoalId,
      event: GoalEvent,
      reducer?: (event: GoalEvent, record: GoalRecord) => GoalRecord,
    ) {
      return dispatchEvent(store, goalId, event, receiptLog, reducer);
    },
    resume(goalId: GoalId) {
      return resumeAfterCompaction(store, goalId);
    },
    isTerminal(goalId: GoalId): boolean {
      const record = store.get(goalId);
      return record ? isTerminal(record) : false;
    },

    // ─── Phase 6: Context compiler ──────────────────────────────────────
    compileContext,
    projectGoalStoreView,

    // ─── Phase 6: Execution schedulers ──────────────────────────────────
    dispatchReadOnly,
    dispatchMutation,
    acquireLease,
    releaseLease,
    checkLease,

    // ─── Phase 6: Worker guard ──────────────────────────────────────────
    registerWorkerGuard,

    // ─── Phase 6: Authority & tool policy ───────────────────────────────
    enforceToolPolicy,
    issueAuthority,
  };
}

// ─── Public API re-exports ──────────────────────────────────────────────────

export type {
  GoalRecord,
  GoalId,
  GoalEvent,
  GoalState,
  AssignmentId,
  AssignmentState,
  RunRecord,
  RunStatus,
  ExecutionPlanSnapshot,
} from "./domain/types.js";

export { createGoalRecord, validateTransition, isExecutionFrontierTerminal, isAssignmentTerminal, ASSIGNMENT_TERMINAL_STATES } from "./domain/goal-record.js";
export { GoalStore, goalReducer, VersionConflictError, StoreCorruptionError, IgnoredEventError, InvalidTransitionError } from "./store/goal-store.js";
export type { UpdateOptions } from "./store/goal-store.js";
export { dispatchEvent as lifecycleDispatch, startGoal as lifecycleStart, getGoalState as lifecycleGet, isTerminal as lifecycleIsTerminal, FenceError, TerminalStateError } from "./runtime/lifecycle.js";
export {
  detectRecoveryIssues,
  repairOrphanedDriverLease,
  repairStaleMutationLease,
  clearRecoveryRequired,
} from "./runtime/recovery.js";
export type { RecoveryAction } from "./runtime/recovery.js";
export { buildContinuationContext, resumeAfterCompaction } from "./continuation.js";
export { startGoalFlow, adaptEcosystemToBaselineRecord } from "./runtime/goal-flow.js";
export type { GoalFlowDeps, GoalFlowResult, GoalFlowRefs, GoalFlowErrorCode } from "./runtime/goal-flow.js";

// Phase 6 re-exports
export { compileContext, issueAuthority } from "./context/compiler.js";
export { projectGoalStoreView } from "./context/projections.js";
export type { ContextRole, GoalContextView, CompilerConfig } from "./context/types.js";
export type { ProjectionRole, GoalProjection } from "./context/projections.js";
export { registerWorkerGuard } from "./execution/worker-guard.js";
export type { WorkerGuard, GuardResult } from "./execution/worker-guard.js";
export { dispatchReadOnly } from "./execution/read-only-launcher.js";
export type { ReadOnlyLaunchResult, ContextView } from "./execution/read-only-launcher.js";
export {
  executeReadOnly,
  watchLiveCompletion,
  completionStatusOf,
  runExecutionFrontier,
  CompletionSinkError,
  DEFAULT_LIVE_SESSION_ID,
} from "./execution/read-only-launcher.js";
export type {
  CompletionSink,
  LiveExecutionOptions,
  LiveExecutionResult,
  FrontierRunnerOptions,
} from "./execution/read-only-launcher.js";
export { dispatchMutation, validateMutationLease, executeMutation } from "./execution/mutation-launcher.js";
export type { MutationLaunchResult, ExecuteMutationOptions } from "./execution/mutation-launcher.js";
export { dispatchRepair } from "./review/repair.js";
export type { RepairDispatch, RepairAssignment } from "./review/types.js";
export {
  ensureKeystoneSessionBridges,
  resetSessionBridges,
  isBridged,
  defaultChildGuardPath,
  SubagentsBridgeError,
  KEYSTONE_READER_ALLOWED_TOOLS,
  KEYSTONE_CHILD_GUARD_ID,
} from "./rpc/subagents-bridge.js";
export {
  handleGoalCommand,
  parseGoalSubcommand,
  parseGoalCommand,
  createGoalHandler,
  createGoalCommandRegistration,
  newGoalId,
} from "./runtime/commands.js";
export type { GoalCommandController, GoalCommandHost, GoalSubcommand } from "./runtime/commands.js";

// ─── Thin Pi extension entrypoint (Task 7, Wave 3a) ─────────────────────────
// Factory registers the /goal command + lifecycle hooks only. No background
// resources start here: the controller, RPC client, and pi-subagents bridges
// init at session_start (bridges AFTER the RPC bridge signals ready) and tear
// down at session_shutdown. session_before_compact records continuation
// context via the controller (noteCompaction) and returns no override:
// resume happens post-compact via resume()/resumeAfterCompaction.

type SessionRuntime = {
  controller: ReturnType<typeof createKeystone>;
  rpc: SubagentRpcClient | null;
  sessionId: string;
  live: boolean;
  cwd: string;
};

let sessionRuntime: SessionRuntime | null = null;

/**
 * Session identity fallback chain (documented):
 * 1. ctx.sessionManager.getSessionId() — exact ReadonlySessionManager
 *    accessor (verified session-manager.d.ts). Live.
 * 2. Legacy probe: a bare string `sessionId` field on ctx (older hosts). Live.
 * 3. Bootstrap `keystone:<cwd>` — NOT live: the frontier executor refuses to
 *    spawn under it (typed no-live-runtime); it only ever owns driver leases.
 */
function resolveSessionId(ctx: ExtensionContext, cwd: string): { id: string; live: boolean } {
  try {
    const id = ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id.length > 0) return { id, live: true };
  } catch {
    // Host without a session manager — fall through to legacy probes.
  }
  const legacy = (ctx as unknown as { sessionId?: unknown }).sessionId;
  if (typeof legacy === "string" && legacy.length > 0) return { id: legacy, live: true };
  return { id: `keystone:${cwd}`, live: false };
}

/**
 * Get or init the session runtime, re-keyed by cwd. GoalStore appends
 * "goals" to its dataDir, so the store root is join(cwd, ".keystone")
 * (NOT join(cwd, ".keystone", "goals") — that doubled to goals/goals).
 * When ctx.cwd changes, the old runtime's live resources (rpc, bridges,
 * binding) are torn down so a stale session never operates on the new root.
 */
function getOrInitRuntime(cwd: string): SessionRuntime {
  if (sessionRuntime && sessionRuntime.cwd !== cwd) {
    try {
      sessionRuntime.rpc?.dispose();
    } catch {
      // Dispose is best-effort during re-key.
    }
    resetSessionBridges();
    sessionRuntime.controller.bindSessionRuntime(null);
    sessionRuntime = null;
  }
  if (!sessionRuntime) {
    sessionRuntime = {
      controller: createKeystone({ dataDir: join(cwd, ".keystone") }),
      rpc: null,
      sessionId: `keystone:${cwd}`,
      live: false,
      cwd,
    };
  }
  return sessionRuntime;
}

function adaptEvents(pi: ExtensionAPI): RpcEventBus {
  const events = (pi as unknown as { events?: RpcEventBus }).events;
  if (events && typeof events.on === "function" && typeof events.emit === "function") return events;
  return { on() {}, emit() {} };
}

async function proposeDepthWithSessionModel(
  ctx: ExtensionContext,
  input: DepthProposalInput,
  fallback: DepthProposal,
): Promise<DepthProposal> {
  if (!ctx.model) return fallback;
  const plan = input.plan.assignments.map((a) => ({
    id: a.id,
    role: a.role,
    description: a.description,
    targetFiles: a.targetFiles,
    criteria: a.criterionIds,
  }));
  const checks = Object.values(input.baseline.checks)
    .filter((check): check is NonNullable<typeof check> => Boolean(check))
    .map((check) => ({ id: check.checkId, status: check.status, command: check.command }));
  const userMessage: UserMessage = {
    role: "user",
    content: [{
      type: "text",
      text: JSON.stringify({ task: input.task, plan, criteria: input.contract.completionCriteria, checks }),
    }],
    timestamp: Date.now(),
  };
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt: [
        "Choose lifecycle depth for a coding goal.",
        "quick = deterministic execution+verification only for small bounded low-risk changes.",
        "standard = add one independent review for moderate changes.",
        "full = independent review plus two fresh final auditors for broad, sensitive, destructive, concurrent, security, migration, persistence, or protocol work.",
        "Return JSON only: {\"depth\":\"quick|standard|full\",\"rationale\":\"...\",\"signals\":[\"...\"]}.",
      ].join("\n"),
      messages: [userMessage],
    },
  );
  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return parseModelDepth(raw, fallback);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("goal", {
    description: "Keystone goal lifecycle: create <task> | release <goalId> | status [goalId] | cancel <goalId> | list",
    handler: async (args: string, ctx): Promise<void> => {
      const runtime = getOrInitRuntime(ctx.cwd);
      runtime.controller.bindSessionRuntime(
        runtime.rpc
          ? {
              rpc: runtime.rpc,
              sessionId: runtime.sessionId,
              live: runtime.live,
              cwd: runtime.cwd,
              approveMutationConflict: (input) => openMutationConflictConfirmation(ctx, input),
            }
          : null,
      );
      await handleGoalCommand(
        runtime.controller,
        {
          cwd: ctx.cwd,
          notify: (message, level) => ctx.ui.notify(message, level),
          proposeDepth: (input, fallback) => proposeDepthWithSessionModel(ctx, input, fallback),
          confirmPreparedGoal: async (input) => {
            let fleetSummary: string | undefined;
            if (runtime.rpc?.ready) {
              try {
                const status = await runtime.rpc.statusOverview(1500);
                const fleet = status.fleet && typeof status.fleet === "object" && !Array.isArray(status.fleet)
                  ? status.fleet as Record<string, unknown>
                  : {};
                const active = typeof fleet.totalActive === "number" ? fleet.totalActive : 0;
                const omitted = typeof fleet.omitted === "number" ? fleet.omitted : 0;
                const capacity = fleet.topLevelAsyncCapacity && typeof fleet.topLevelAsyncCapacity === "object" && !Array.isArray(fleet.topLevelAsyncCapacity)
                  ? fleet.topLevelAsyncCapacity as Record<string, unknown>
                  : {};
                const used = typeof capacity.used === "number" ? capacity.used : 0;
                const limit = typeof capacity.limit === "number" ? capacity.limit : 0;
                fleetSummary = `pi-subagents fleet · ${active} active · async ${used}/${limit}${omitted > 0 ? ` · +${omitted} omitted` : ""}`;
              } catch {
                fleetSummary = "pi-subagents connected · fleet status unavailable";
              }
            } else {
              fleetSummary = "pi-subagents not ready · execution will fail closed until the bridge is live";
            }
            return openGoalConfirmation(ctx, { ...input, fleetSummary });
          },
        },
        args,
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const runtime = getOrInitRuntime(ctx.cwd);
    runtime.controller.hooks.session_start();
    runtime.rpc?.dispose();
    const rpc = new SubagentRpcClient(adaptEvents(pi), { sourceExtension: "keystone" });
    const { id, live } = resolveSessionId(ctx, ctx.cwd);
    runtime.rpc = rpc;
    runtime.sessionId = id;
    runtime.live = live;
    runtime.controller.bindSessionRuntime({
      rpc,
      sessionId: id,
      live,
      cwd: ctx.cwd,
      approveMutationConflict: (input) => openMutationConflictConfirmation(ctx, input),
    });
    // Load signal: proves the extension initialized even when pi-subagents is
    // absent (waitReady/bridge notifies below cover only the failure paths).
    ctx.ui.notify("Keystone: extension loaded, session ready", "info");
    try {
      await rpc.waitReady(5000);
    } catch (err) {
      ctx.ui.notify(
        `Keystone: pi-subagents RPC not ready; live spawn disabled (${(err as Error)?.message ?? String(err)})`,
        "error",
      );
      return;
    }
    try {
      ensureKeystoneSessionBridges(runtime.sessionId);
    } catch (err) {
      ctx.ui.notify(
        `Keystone: bridge registration failed; live spawn disabled (${(err as Error)?.message ?? String(err)})`,
        "error",
      );
      return;
    }
    runtime.controller.registerFrontierWiring(runtime.controller.buildFrontierWiring());
    if (runtime.live) {
      try {
        await runtime.controller.reconcileRuntimeRecovery();
      } catch (err) {
        ctx.ui.notify(
          `Keystone: runtime recovery incomplete (${(err as Error)?.message ?? String(err)})`,
          "error",
        );
      }
    }
  });

  pi.on("session_shutdown", async () => {
    // Reset ALL bridged session ids: the bridge tracks every session it
    // registered (runtime session + lease.sessionId + default live id).
    resetSessionBridges();
    if (sessionRuntime) {
      sessionRuntime.controller.bindSessionRuntime(null);
      try {
        sessionRuntime.rpc?.dispose();
      } catch {
        // Dispose is best-effort during shutdown.
      }
      sessionRuntime = null;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const runtime = sessionRuntime;
    if (!runtime || runtime.cwd !== ctx.cwd) return;
    runtime.controller.noteAgentSettled();
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const runtime = sessionRuntime;
    if (!runtime || runtime.cwd !== ctx.cwd) return undefined;
    runtime.controller.noteCompaction();
    // No compaction override: Keystone resumes post-compact via
    // resume()/resumeAfterCompaction; summaries stay host-owned.
    return undefined;
  });
}
export { acquireLease, releaseLease, checkLease } from "./execution/mutation-lease.js";
export { enforceToolPolicy } from "./execution/tool-policy.js";
export type { ToolPolicy, ToolPolicyKind } from "./execution/tool-policy.js";

// Task 2 (Wave 2a): pi-subagents RPC client + run registry
export { SubagentRpcClient } from "./rpc/subagent-rpc-client.js";
export type { SteerMode, SubagentRpcClientOptions } from "./rpc/subagent-rpc-client.js";
export { RunRegistry } from "./rpc/run-registry.js";
export type { RunRegistration } from "./rpc/run-registry.js";
export {
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REPLY_EVENT_PREFIX,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_METHODS,
  subagentRpcReplyEvent,
  RpcTimeoutError,
  RpcReplyError,
  RpcNotReadyError,
} from "./rpc/types.js";
export type {
  RpcEventBus,
  SubagentRpcMethod,
  SubagentRpcErrorCode,
  SubagentRpcRequestEnvelope,
  SubagentRpcReplyEnvelope,
  PingInfo,
  SpawnParams,
  SpawnDetails,
  SpawnResult,
  TextDetailsResult,
  StatusResult,
  StopResult,
  ResumeResult,
  SteerResult,
  RpcTerminalState,
  RpcResult,
  AsyncCompleteChildResult,
  AsyncCompletePayload,
  AsyncCompleteHandler,
} from "./rpc/types.js";

// Task 3 (Wave 2b): userTask-driven planning with exact coverage validation
export {
  buildPlanFromUserTask,
  createProvisionalPlan,
  validatePlan,
  assertPlanCoverage,
  uncoveredCriteria,
  reviseProvisionalPlan,
  incrementEpoch,
  isStale,
  needsCodeChanges,
  isVerificationShaped,
  PlanCoverageError,
} from "./planning/provisional-plan.js";
export type {
  PlanInput,
  CriterionId,
  ContractCriterion,
  GoalContract as PlanningContract,
  PlanAssignment,
  ProvisionalPlan as PlanningProvisionalPlan,
  CreatePlanInput,
  ValidationResult as PlanValidationResult,
} from "./planning/provisional-plan.js";
export { reconcile, nextEpochAfterReconcile } from "./planning/reconciliation.js";
export type {
  BaselineResults as PlanningBaselineResults,
  ReconcileResult,
} from "./planning/reconciliation.js";
export { runPlanning, deriveCriteriaFromUserTask } from "./planning/orchestrator.js";
export type { PlanningResult, PlanningOptions } from "./planning/orchestrator.js";
