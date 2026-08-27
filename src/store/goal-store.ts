// GoalRecord CRUD backed by atomic JSON file persistence.
// Uses stdlib fs — no external deps. Atomic write via tmp+rename.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GoalRecord, GoalId, GoalEvent, GoalState } from "../domain/types.js";
import { validateTransition } from "../domain/goal-record.js";

export type GoalReducer = (event: GoalEvent, record: GoalRecord) => GoalRecord;

/** Default reducer: applies event to record, returns updated record. */
export function goalReducer(event: GoalEvent, record: GoalRecord): GoalRecord {
  const now = new Date().toISOString() as GoalRecord["updatedAt"];
  const base = { ...record, updatedAt: now };

  const result = applyGoalEvent(event, record, base, now);

  // Defense in depth: reject invalid transitions (store also validates)
  if (result.state !== record.state) {
    const validation = validateTransition(record.state, result.state);
    if (!validation.valid) {
      return base;
    }
  }

  return result;
}

function applyGoalEvent(event: GoalEvent, record: GoalRecord, base: GoalRecord, now: GoalRecord["updatedAt"]): GoalRecord {
  switch (event.type) {
    case "GoalStarted":
      return { ...base, state: "PREPARING" as GoalState };
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
      return { ...base, state: "READY" as GoalState, contractVersion: event.contractVersion, activeContractRef: event.contractRef };
    case "ExecutionStarted":
      return { ...base, state: "EXECUTING" as GoalState, driverFenceCounter: event.driverFence };
    case "AssignmentCompleted":
      return { ...base, state: "VERIFYING" as GoalState };
    case "VerificationCompleted":
      return { ...base, state: (event.accepted ? "REVIEWING" : "EXECUTING") as GoalState };
    case "ReviewCompleted":
      return { ...base, state: "ADJUDICATING" as GoalState };
    case "AdjudicationCompleted":
      return { ...base, state: "FINAL_AUDIT" as GoalState };
    case "RepairCompleted":
      return { ...base, state: "VERIFYING" as GoalState };
    case "FinalAuditCompleted":
      return { ...base, state: (event.accepted ? "COMPLETION_GATE" : "ADJUDICATING") as GoalState };
    case "CompletionEvaluated":
      return {
        ...base,
        state: (event.accepted ? "DONE" : "REPAIRING") as GoalState,
        terminalReportRef: event.accepted ? event.reportRef : base.terminalReportRef,
      };
    case "PauseRequested":
      return { ...base, state: "PAUSED" as GoalState, resumeState: record.state as GoalRecord["resumeState"], pauseReason: event.reason, pausedAt: now };
    case "ResumeRequested": {
      // PAUSED only allows → RECONCILING, CANCELLING, FAILED
      const { resumeState: _, pauseReason: _p, pausedAt: _a, ...rest } = base;
      return { ...rest, state: "RECONCILING" as GoalState };
    }
    case "CancelRequested":
      return { ...base, state: "CANCELLING" as GoalState, cancellationRequestedAt: now, cancellationReason: event.reason };
    case "CancellationSettled":
      return { ...base, state: "CANCELLED" as GoalState };
    case "FatalError":
      return { ...base, state: "FAILED" as GoalState, terminalReportRef: event.errorRef };
    case "BlockDeclared":
      return { ...base, state: "BLOCKED" as GoalState };
    case "ConvergenceLimitReached":
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
    const filePath = this.filePath(goalId);
    atomicWrite(filePath, JSON.stringify(record, null, 2));
  }

  get(goalId: GoalId): GoalRecord | undefined {
    try {
      const raw = readFileSync(this.filePath(goalId), "utf-8");
      return JSON.parse(raw) as GoalRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * Apply a reducer to a goal record. Validates the resulting state transition.
   * Same-state updates (data-only, no transition) skip transition validation.
   * Returns the updated record, or throws on invalid transition.
   */
  update(goalId: GoalId, event: GoalEvent, reducer: GoalReducer = goalReducer): GoalRecord {
    const existing = this.get(goalId);
    if (!existing) throw new Error(`Goal ${goalId} not found`);

    const updated = reducer(event, existing);

    // Only validate transition when state actually changes
    if (existing.state !== updated.state) {
      const validation = validateTransition(existing.state, updated.state);
      if (!validation.valid) {
        throw new Error(`Invalid transition: ${validation.reason}`);
      }
    }

    updated.recordVersion = existing.recordVersion + 1;
    updated.lastTransitionId = `${event.type}-${randomUUID()}`;
    const filePath = this.filePath(goalId);
    atomicWrite(filePath, JSON.stringify(updated, null, 2));
    return updated;
  }

  list(): GoalRecord[] {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const raw = readFileSync(join(this.dir, f), "utf-8");
      return JSON.parse(raw) as GoalRecord;
    });
  }

  delete(goalId: GoalId): boolean {
    try {
      unlinkSync(this.filePath(goalId));
      return true;
    } catch {
      return false;
    }
  }

  private filePath(goalId: GoalId): string {
    return join(this.dir, `${goalId}.json`);
  }
}
