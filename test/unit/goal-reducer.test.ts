import { describe, it, expect } from "vitest";
import type { GoalId, GoalState, GoalRecord, GoalEvent, RevisionRef, ArtifactRef } from "../../src/domain/types.js";
import { goalReducer } from "../../src/store/goal-store.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function gid(s: string): GoalId { return s as GoalId; }
function aref(s: string): ArtifactRef { return s as ArtifactRef; }

const workspace: GoalRecord["workspace"] = {
  requestedRoot: "/tmp/test",
  canonicalRoot: "/tmp/test",
  projectKey: "key",
  vcs: "git",
};

const startRevision: RevisionRef = {
  snapshotId: "snap-0" as GoalRecord["startRevision"]["snapshotId"],
  observedAt: "2025-01-01T00:00:00Z",
  graphRevision: 0,
  dirtySignature: "",
  capabilityDigest: "",
};

function makeRecord(state: GoalState, overrides?: Partial<GoalRecord>): GoalRecord {
  const base = createGoalRecord(gid("test-goal"), "test task", workspace, startRevision);
  base.state = state;
  if (overrides) Object.assign(base, overrides);
  return base;
}

function event<T extends GoalEvent["type"]>(
  type: T,
  extra?: Omit<Extract<GoalEvent, { type: T }>, "type">,
): GoalEvent {
  return { type, ...extra } as GoalEvent;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("goalReducer", () => {
  // --- GoalStarted ---
  it("GoalStarted: CREATED → PREPARING", () => {
    const record = makeRecord("CREATED");
    const result = goalReducer(event("GoalStarted"), record);
    expect(result.state).toBe("PREPARING");
  });

  it("GoalStarted: updates updatedAt", () => {
    const record = makeRecord("CREATED");
    record.updatedAt = "2000-01-01T00:00:00Z";
    const result = goalReducer(event("GoalStarted"), record);
    expect(result.updatedAt).not.toBe("2000-01-01T00:00:00Z");
  });

  it("PreparedFlowStored durably pins the prepared bundle and baseline", () => {
    const record = makeRecord("PREPARING");
    const result = goalReducer(
      event("PreparedFlowStored", { flowRef: aref("flow-1"), baselineRef: aref("base-1") }),
      record,
    );
    expect(result.state).toBe("PREPARING");
    expect(result.preparedFlowRef).toBe(aref("flow-1"));
    expect(result.baselineRef).toBe(aref("base-1"));
  });

  // --- ReconciliationCompleted ---
  it("ReconciliationCompleted: RECONCILING → CONTRACT_REVIEW when ACCEPT_PLAN_BASIS", () => {
    const record = makeRecord("RECONCILING");
    const result = goalReducer(
      event("ReconciliationCompleted", {
        reportRef: aref("r1"),
        planEpoch: 0,
        provisionalPlanRef: aref("p1"),
        basedOnRevision: startRevision,
        decision: "ACCEPT_PLAN_BASIS",
      }),
      record,
    );
    expect(result.state).toBe("CONTRACT_REVIEW");
    expect(result.currentRevision).toBe(startRevision);
  });

  it("ReconciliationCompleted: RECONCILING → BLOCKED when BLOCK", () => {
    const record = makeRecord("RECONCILING");
    const result = goalReducer(
      event("ReconciliationCompleted", {
        reportRef: aref("r1"),
        planEpoch: 0,
        provisionalPlanRef: aref("p1"),
        basedOnRevision: startRevision,
        decision: "BLOCK",
      }),
      record,
    );
    expect(result.state).toBe("BLOCKED");
  });

  it("ReconciliationCompleted: non-RECONCILING state returns unchanged", () => {
    const record = makeRecord("PREPARING");
    const result = goalReducer(
      event("ReconciliationCompleted", {
        reportRef: aref("r1"),
        planEpoch: 0,
        provisionalPlanRef: aref("p1"),
        basedOnRevision: startRevision,
        decision: "ACCEPT_PLAN_BASIS",
      }),
      record,
    );
    expect(result.state).toBe("PREPARING");
  });

  // --- ContractFrozen ---
  it("ContractFrozen: sets READY with contractVersion and ref", () => {
    const record = makeRecord("CONTRACT_REVIEW");
    const result = goalReducer(
      event("ContractFrozen", { contractVersion: 1, contractRef: aref("c1") }),
      record,
    );
    expect(result.state).toBe("READY");
    expect(result.contractVersion).toBe(1);
    expect(result.activeContractRef).toBe(aref("c1"));
  });

  // --- ExecutionStarted ---
  it("ExecutionStarted: sets EXECUTING", () => {
    const record = makeRecord("READY");
    const result = goalReducer(
      event("ExecutionStarted", {
        contractVersion: 1,
        executionPlanRef: aref("ep1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("EXECUTING");
    expect(result.driverFenceCounter).toBe(1);
  });

  // --- AssignmentCompleted ---
  it("AssignmentCompleted: sets VERIFYING", () => {
    const record = makeRecord("EXECUTING");
    const result = goalReducer(
      event("AssignmentCompleted", {
        assignmentId: "a1" as GoalRecord["activeMutationLease"] extends undefined ? never : never,
        reportRef: aref("rpt1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("VERIFYING");
  });

  // --- VerificationCompleted ---
  it("VerificationCompleted: accepted → REVIEWING", () => {
    const record = makeRecord("VERIFYING");
    const result = goalReducer(
      event("VerificationCompleted", {
        runRef: aref("vr1"),
        accepted: true,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("REVIEWING");
  });

  it("VerificationCompleted: rejected → REPAIRING with durable reason", () => {
    const record = makeRecord("VERIFYING");
    const result = goalReducer(
      event("VerificationCompleted", {
        runRef: aref("vr1"),
        accepted: false,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("REPAIRING");
    expect(result.repairReasonRef).toBe(aref("vr1"));
  });

  it("CompletionRecoveryRestarted reroutes read-only post-frontier states to VERIFYING", () => {
    for (const state of ["REVIEWING", "ADJUDICATING", "FINAL_AUDIT", "COMPLETION_GATE"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("CompletionRecoveryRestarted", { reasonRef: aref("recovery-1"), driverFence: 2 }),
        record,
      );
      expect(result.state).toBe("VERIFYING");
    }
  });

  // --- ReviewCompleted ---
  it("ReviewCompleted: sets ADJUDICATING", () => {
    const record = makeRecord("REVIEWING");
    const result = goalReducer(
      event("ReviewCompleted", {
        reviewRef: aref("rev1"),
        candidateIds: [],
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("ADJUDICATING");
  });

  it("ReviewCompleted increments the durable review counter", () => {
    const record = makeRecord("REVIEWING", { reviewCycles: 2 });
    const result = goalReducer(
      event("ReviewCompleted", { reviewRef: aref("rev2"), candidateIds: [], driverFence: 1 }),
      record,
    );
    expect(result.reviewCycles).toBe(3);
  });

  // --- AdjudicationCompleted ---
  it("AdjudicationCompleted: sets FINAL_AUDIT", () => {
    const record = makeRecord("ADJUDICATING");
    const result = goalReducer(
      event("AdjudicationCompleted", {
        decisionRefs: [aref("d1")],
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("FINAL_AUDIT");
  });

  it("RepairRequested: ADJUDICATING → REPAIRING with durable reason", () => {
    const record = makeRecord("ADJUDICATING");
    const result = goalReducer(
      event("RepairRequested", { reasonRef: aref("repair-why"), driverFence: 1 }),
      record,
    );
    expect(result.state).toBe("REPAIRING");
    expect(result.repairReasonRef).toBe(aref("repair-why"));
  });

  // --- RepairCompleted ---
  it("RepairCompleted: sets VERIFYING", () => {
    const record = makeRecord("REPAIRING");
    const result = goalReducer(
      event("RepairCompleted", {
        assignmentId: "a1" as any,
        reportRef: aref("rpt1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("VERIFYING");
    expect(result.repairCycles).toBe(1);
    expect(result.repairReasonRef).toBeUndefined();
    expect(result.repairVerificationPending).toBe(true);
  });

  it("AssignmentRunBound can reopen an implementation run while REPAIRING", () => {
    const record = makeRecord("REPAIRING", { repairReasonRef: aref("why") });
    const result = goalReducer(
      event("AssignmentRunBound", { assignmentId: "a-repair" as any, runId: "repair-run", sessionId: "repair-session", driverFence: 2 }),
      record,
    );
    expect(result.state).toBe("REPAIRING");
    expect(result.assignmentStates["a-repair" as any]).toBe("EXECUTING");
    expect(result.activeRuns["a-repair" as any]?.runId).toBe("repair-run");
  });

  // --- FinalAuditCompleted ---
  it("FinalAuditCompleted: accepted → COMPLETION_GATE", () => {
    const record = makeRecord("FINAL_AUDIT");
    const result = goalReducer(
      event("FinalAuditCompleted", {
        auditRefs: [aref("a1"), aref("a2")],
        accepted: true,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("COMPLETION_GATE");
  });

  it("FinalAuditCompleted: rejected → ADJUDICATING", () => {
    const record = makeRecord("FINAL_AUDIT");
    const result = goalReducer(
      event("FinalAuditCompleted", {
        auditRefs: [aref("a1"), aref("a2")],
        accepted: false,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("ADJUDICATING");
    expect(result.finalAuditAttempts).toBe(1);
  });

  // --- CompletionEvaluated ---
  it("CompletionEvaluated: accepted → DONE (terminal)", () => {
    const record = makeRecord("COMPLETION_GATE");
    const result = goalReducer(
      event("CompletionEvaluated", {
        reportRef: aref("cr1"),
        accepted: true,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("DONE");
    expect(result.terminalReportRef).toBe(aref("cr1"));
  });

  it("CompletionEvaluated: rejected → REPAIRING", () => {
    const record = makeRecord("COMPLETION_GATE");
    const result = goalReducer(
      event("CompletionEvaluated", {
        reportRef: aref("cr1"),
        accepted: false,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("REPAIRING");
    expect(result.repairReasonRef).toBe(aref("cr1"));
  });

  // --- PauseRequested ---
  it("PauseRequested: sets PAUSED with resumeState", () => {
    const record = makeRecord("EXECUTING");
    const result = goalReducer(event("PauseRequested", { reason: "user pause" }), record);
    expect(result.state).toBe("PAUSED");
    expect(result.resumeState).toBe("EXECUTING");
    expect(result.pauseReason).toBe("user pause");
    expect(result.pausedAt).toBeDefined();
  });

  // --- ResumeRequested ---
  it("ResumeRequested: PAUSED → RECONCILING", () => {
    const record = makeRecord("PAUSED", { resumeState: "EXECUTING" } as any);
    const result = goalReducer(event("ResumeRequested"), record);
    expect(result.state).toBe("RECONCILING");
    expect(result.resumeState).toBeUndefined();
    expect(result.pauseReason).toBeUndefined();
    expect(result.pausedAt).toBeUndefined();
  });

  // --- CancelRequested ---
  it("CancelRequested: sets CANCELLING", () => {
    const record = makeRecord("EXECUTING");
    const result = goalReducer(event("CancelRequested", { reason: "abort" }), record);
    expect(result.state).toBe("CANCELLING");
    expect(result.cancellationReason).toBe("abort");
    expect(result.cancellationRequestedAt).toBeDefined();
  });

  // --- CancellationSettled ---
  it("CancellationSettled: CANCELLING → CANCELLED", () => {
    const record = makeRecord("CANCELLING");
    const result = goalReducer(
      event("CancellationSettled", {
        cleanupRef: aref("cl1"),
        mutationOutcome: "SETTLED",
      }),
      record,
    );
    expect(result.state).toBe("CANCELLED");
  });

  it("CancellationSettled: INDETERMINATE stays quarantined in CANCELLING", () => {
    const record = makeRecord("CANCELLING");
    const result = goalReducer(
      event("CancellationSettled", {
        cleanupRef: aref("cl-indeterminate"),
        mutationOutcome: "INDETERMINATE",
      }),
      record,
    );
    expect(result.state).toBe("CANCELLING");
    expect(result.recoveryRequired).toBe(true);
    expect(result.terminalReportRef).toBe(aref("cl-indeterminate"));
  });

  // --- FatalError ---
  it("FatalError: sets FAILED", () => {
    const record = makeRecord("EXECUTING");
    const result = goalReducer(event("FatalError", { errorRef: aref("err1") }), record);
    expect(result.state).toBe("FAILED");
    expect(result.terminalReportRef).toBe(aref("err1"));
  });

  // --- BlockDeclared ---
  it("BlockDeclared: sets BLOCKED", () => {
    const record = makeRecord("PREPARING");
    const result = goalReducer(event("BlockDeclared", { blockerRefs: [aref("b1")] }), record);
    expect(result.state).toBe("BLOCKED");
  });

  // --- ConvergenceLimitReached ---
  it("ConvergenceLimitReached: sets NON_CONVERGENT", () => {
    const record = makeRecord("ADJUDICATING");
    const result = goalReducer(
      event("ConvergenceLimitReached", { evidenceRef: aref("ev1") }),
      record,
    );
    expect(result.state).toBe("NON_CONVERGENT");
  });

  // --- PreparationProgress ---
  it("PreparationProgress: both succeeded in PREPARING → RECONCILING", () => {
    const record = makeRecord("PREPARING");
    const baseRevision = { ...startRevision };
    // First: baseline succeeds
    const r1 = goalReducer(
      event("PreparationProgress", {
        job: "baseline",
        planEpoch: 0,
        attemptId: "att-1",
        basedOnRevision: baseRevision,
        status: "SUCCEEDED",
        driverFence: 0,
      }),
      record,
    );
    expect(r1.state).toBe("PREPARING");
    expect(r1.preparation.baselineJob.status).toBe("SUCCEEDED");

    // Second: plan succeeds → both succeeded → RECONCILING
    const r2 = goalReducer(
      event("PreparationProgress", {
        job: "plan",
        planEpoch: 0,
        attemptId: "att-2",
        basedOnRevision: baseRevision,
        status: "SUCCEEDED",
        driverFence: 0,
      }),
      r1,
    );
    expect(r2.state).toBe("RECONCILING");
  });

  it("PreparationProgress: baseline failed in PREPARING → stays PREPARING", () => {
    const record = makeRecord("PREPARING");
    const result = goalReducer(
      event("PreparationProgress", {
        job: "baseline",
        planEpoch: 0,
        attemptId: "att-1",
        basedOnRevision: startRevision,
        status: "FAILED",
        driverFence: 0,
      }),
      record,
    );
    expect(result.state).toBe("PREPARING");
    expect(result.preparation.baselineJob.status).toBe("FAILED");
  });

  it("PreparationProgress: both succeeded but not in PREPARING → stays in current state", () => {
    const record = makeRecord("RECONCILING");
    // Simulate: baseline already succeeded, now plan succeeds
    record.preparation.baselineJob.status = "SUCCEEDED";
    const result = goalReducer(
      event("PreparationProgress", {
        job: "plan",
        planEpoch: 0,
        attemptId: "att-1",
        basedOnRevision: startRevision,
        status: "SUCCEEDED",
        driverFence: 0,
      }),
      record,
    );
    expect(result.state).toBe("RECONCILING");
  });

  // --- Non-legal transitions ---
  // Wrong-source events are no-ops: the reducer returns base unchanged
  // (surfaced as IgnoredEventError at the dispatch boundary), never a
  // state change that validateTransition would reject.
  it("DONE → GoalStarted returns base unchanged", () => {
    const record = makeRecord("DONE");
    const result = goalReducer(event("GoalStarted"), record);
    expect(result.state).toBe("DONE");
  });

  it("CANCELLED → ExecutionStarted returns base unchanged", () => {
    const record = makeRecord("CANCELLED");
    const result = goalReducer(
      event("ExecutionStarted", {
        contractVersion: 1,
        executionPlanRef: aref("ep1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("CANCELLED");
    expect(result.executionPlan).toBeNull();
  });

  it("BLOCKED → ReviewCompleted returns base unchanged", () => {
    const record = makeRecord("BLOCKED");
    const result = goalReducer(
      event("ReviewCompleted", {
        reviewRef: aref("rev1"),
        candidateIds: [],
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("BLOCKED");
  });

  it("FAILED → AdjudicationCompleted returns base unchanged", () => {
    const record = makeRecord("FAILED");
    const result = goalReducer(
      event("AdjudicationCompleted", {
        decisionRefs: [aref("d1")],
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("FAILED");
  });

  // --- Task 1: frontier-gated VERIFYING ---
  it("AssignmentCompleted marks only its assignment when frontier is non-terminal", () => {
    const record = makeRecord("EXECUTING");
    record.executionPlan = {
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    };
    const result = goalReducer(
      event("AssignmentCompleted", {
        assignmentId: aid("a1"),
        reportRef: aref("rpt1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.assignmentStates[aid("a1")]).toBe("COMPLETED");
    expect(result.assignmentStates[aid("a2")]).toBeUndefined();
    expect(result.state).toBe("EXECUTING");
  });

  it("AssignmentCompleted reaches VERIFYING when the last frontier assignment completes", () => {
    const record = makeRecord("EXECUTING");
    record.executionPlan = {
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    };
    record.assignmentStates = { [aid("a1")]: "COMPLETED" };
    const result = goalReducer(
      event("AssignmentCompleted", {
        assignmentId: aid("a2"),
        reportRef: aref("rpt2"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.assignmentStates[aid("a2")]).toBe("COMPLETED");
    expect(result.state).toBe("VERIFYING");
  });

  it("AssignmentCompleted closes a RUNNING run record with the report ref", () => {
    const record = makeRecord("EXECUTING");
    record.activeRuns = {
      [aid("a1")]: {
        runId: "run-1",
        sessionId: "sess-1",
        status: "RUNNING",
        startedAt: "2025-01-01T00:00:00.000Z" as never,
      },
    };
    const result = goalReducer(
      event("AssignmentCompleted", {
        assignmentId: aid("a1"),
        reportRef: aref("rpt1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.activeRuns[aid("a1")]?.status).toBe("SUCCEEDED");
    expect(result.activeRuns[aid("a1")]?.resultRef).toBe(aref("rpt1"));
    expect(result.activeRuns[aid("a1")]?.endedAt).toBeDefined();
  });
});

function aid(s: string): GoalRecord["assignmentStates"] extends Partial<Record<infer K, unknown>> ? K : never {
  return s as never;
}

describe("goalReducer — execution plan payload + AssignmentFailed + repair gate + lease events", () => {
  it("ExecutionStarted with assignments sets executionPlan from the DAG payload", () => {
    const record = makeRecord("READY");
    const result = goalReducer(
      event("ExecutionStarted", {
        contractVersion: 1,
        executionPlanRef: aref("ep1"),
        driverFence: 1,
        assignments: [
          { id: aid("a1"), dependsOn: [] },
          { id: aid("a2"), dependsOn: [aid("a1")] },
        ],
      }),
      record,
    );
    expect(result.state).toBe("EXECUTING");
    expect(result.executionPlan).toEqual({
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    });
  });

  it("ExecutionStarted without assignments leaves executionPlan null", () => {
    const record = makeRecord("READY");
    const result = goalReducer(
      event("ExecutionStarted", {
        contractVersion: 1,
        executionPlanRef: aref("ep1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("EXECUTING");
    expect(result.executionPlan).toBeNull();
  });

  it("AssignmentRunBound replaces the pending handle with the durable RPC identity", () => {
    const record = makeRecord("EXECUTING");
    record.assignmentStates = { [aid("a1")]: "CREATED" };
    record.activeRuns = {
      [aid("a1")]: {
        runId: "pending-a1",
        sessionId: "sess-old",
        status: "RUNNING",
        startedAt: "2025-01-01T00:00:00.000Z" as never,
      },
    };
    const result = goalReducer(
      event("AssignmentRunBound", {
        assignmentId: aid("a1"),
        runId: "run-real-1",
        sessionId: "sess-live",
        driverFence: 2,
      }),
      record,
    );
    expect(result.assignmentStates[aid("a1")]).toBe("EXECUTING");
    expect(result.activeRuns[aid("a1")]?.runId).toBe("run-real-1");
    expect(result.activeRuns[aid("a1")]?.sessionId).toBe("sess-live");
  });

  it("AssignmentFailed marks FAILED and stays EXECUTING while frontier non-terminal", () => {
    const record = makeRecord("EXECUTING");
    record.executionPlan = {
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    };
    const result = goalReducer(
      event("AssignmentFailed", {
        assignmentId: aid("a1"),
        errorRef: aref("err1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.assignmentStates[aid("a1")]).toBe("FAILED");
    expect(result.state).toBe("EXECUTING");
  });

  it("AssignmentFailed advances to VERIFYING when the frontier is fully terminal", () => {
    const record = makeRecord("EXECUTING");
    record.executionPlan = {
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    };
    record.assignmentStates = { [aid("a1")]: "COMPLETED" };
    const result = goalReducer(
      event("AssignmentFailed", { assignmentId: aid("a2"), driverFence: 1 }),
      record,
    );
    expect(result.assignmentStates[aid("a2")]).toBe("FAILED");
    expect(result.state).toBe("VERIFYING");
  });

  it("AssignmentFailed closes a RUNNING run record with FAILED status", () => {
    const record = makeRecord("EXECUTING");
    record.activeRuns = {
      [aid("a1")]: {
        runId: "run-1",
        sessionId: "sess-1",
        status: "RUNNING",
        startedAt: "2025-01-01T00:00:00.000Z" as never,
      },
    };
    const result = goalReducer(
      event("AssignmentFailed", {
        assignmentId: aid("a1"),
        errorRef: aref("err1"),
        driverFence: 1,
      }),
      record,
    );
    expect(result.activeRuns[aid("a1")]?.status).toBe("FAILED");
    expect(result.activeRuns[aid("a1")]?.resultRef).toBe(aref("err1"));
  });

  it("RepairCompleted stays REPAIRING until the frontier is terminal", () => {
    const record = makeRecord("REPAIRING");
    record.executionPlan = {
      planEpoch: 0,
      assignments: [
        { id: aid("a1"), dependsOn: [] },
        { id: aid("a2"), dependsOn: [aid("a1")] },
      ],
    };
    const partial = goalReducer(
      event("RepairCompleted", {
        assignmentId: aid("a2"),
        reportRef: aref("rpt1"),
        driverFence: 1,
      }),
      record,
    );
    expect(partial.assignmentStates[aid("a2")]).toBe("COMPLETED");
    expect(partial.state).toBe("REPAIRING");

    const done = goalReducer(
      event("RepairCompleted", {
        assignmentId: aid("a1"),
        reportRef: aref("rpt2"),
        driverFence: 1,
      }),
      partial,
    );
    expect(done.state).toBe("VERIFYING");
  });

  it("MutationLeaseAttached mirrors live writer authority and release clears only the matching lease", () => {
    const record = makeRecord("EXECUTING");
    const lease = {
      leaseId: "mlease-1",
      fencingToken: 7,
      assignmentId: aid("a1"),
      sessionId: "sess-live",
      workerProcessIdentity: "pid:1",
      canonicalWorkspaceRoot: "/tmp/test",
      allowedCanonicalPaths: ["/tmp/test/src/a.ts"],
      baseDirtySignature: "dirty-0",
      phase: "MUTATING",
      acquiredAt: "2025-01-01T00:00:00.000Z",
      heartbeatAt: "2025-01-01T00:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as never;
    const attached = goalReducer(
      event("MutationLeaseAttached", { lease, driverFence: 3 }),
      record,
    );
    expect(attached.activeMutationLease).toEqual(lease);
    expect(attached.mutationFenceCounter).toBe(7);

    const wrongRelease = goalReducer(
      event("MutationLeaseReleased", { leaseId: "other", driverFence: 3 }),
      attached,
    );
    expect(wrongRelease.activeMutationLease).toEqual(lease);

    const released = goalReducer(
      event("MutationLeaseReleased", { leaseId: "mlease-1", driverFence: 3 }),
      attached,
    );
    expect(released.activeMutationLease).toBeUndefined();
  });

  it("MutationLeaseAttached cannot grant new write authority after pause/cancel/terminalization", () => {
    const lease = {
      leaseId: "mlease-late",
      fencingToken: 9,
      assignmentId: aid("a1"),
      sessionId: "sess-live",
      workerProcessIdentity: "pid:1",
      canonicalWorkspaceRoot: "/tmp/test",
      allowedCanonicalPaths: ["/tmp/test/src/a.ts"],
      baseDirtySignature: "dirty-0",
      phase: "ACQUIRED",
      acquiredAt: "2025-01-01T00:00:00.000Z",
      heartbeatAt: "2025-01-01T00:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as never;
    for (const state of ["PAUSED", "CANCELLING", "DONE"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("MutationLeaseAttached", { lease, driverFence: 3 }),
        record,
      );
      expect(result.activeMutationLease).toBeUndefined();
      expect(result.mutationFenceCounter).toBe(record.mutationFenceCounter);
    }
    const repairing = goalReducer(
      event("MutationLeaseAttached", { lease, driverFence: 3 }),
      makeRecord("REPAIRING"),
    );
    expect(repairing.activeMutationLease).toEqual(lease);
  });

  it("DriverLeaseAcquired persists lease + counter without changing state", () => {
    const record = makeRecord("EXECUTING");
    const lease = {
      leaseId: "lease-1",
      sessionId: "sess-A",
      fencingToken: 3,
      acquiredAt: "2025-01-01T00:00:00.000Z",
      heartbeatAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as never;
    const result = goalReducer(
      { type: "DriverLeaseAcquired", lease, fenceCounter: 3 } as never,
      record,
    );
    expect(result.state).toBe("EXECUTING");
    expect(result.activeDriverLease).toEqual(lease);
    expect(result.driverFenceCounter).toBe(3);
  });

  it("DriverLeaseReleased clears the lease without changing state", () => {
    const record = makeRecord("EXECUTING");
    record.activeDriverLease = {
      leaseId: "lease-1",
      sessionId: "sess-A",
      fencingToken: 1,
      acquiredAt: "2025-01-01T00:00:00.000Z",
      heartbeatAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as never;
    const result = goalReducer({ type: "DriverLeaseReleased" } as never, record);
    expect(result.state).toBe("EXECUTING");
    expect(result.activeDriverLease).toBeUndefined();
  });
});

// ─── Wrong-source guards (Round-6 P1) ───────────────────────────────────────
// Each phase event applies only in its expected source state; from any
// other state the reducer returns base unchanged (no state change, no
// assignmentStates write, no fence update). Dispatch maps that no-op to
// IgnoredEventError.

describe("wrong-source guards", () => {
  it("ContractFrozen outside CONTRACT_REVIEW returns base unchanged", () => {
    for (const state of ["READY", "EXECUTING", "RECONCILING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("ContractFrozen", { contractVersion: 1, contractRef: aref("c1") }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.contractVersion).toBe(record.contractVersion);
    }
  });

  it("ContractFrozen in CONTRACT_REVIEW freezes", () => {
    const record = makeRecord("CONTRACT_REVIEW");
    const result = goalReducer(
      event("ContractFrozen", { contractVersion: 2, contractRef: aref("c2") }),
      record,
    );
    expect(result.state).toBe("READY");
    expect(result.contractVersion).toBe(2);
  });

  it("VerificationCompleted outside VERIFYING returns base unchanged", () => {
    for (const state of ["EXECUTING", "REVIEWING", "READY"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("VerificationCompleted", { runRef: aref("r1"), accepted: true, driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
    }
  });

  it("ReviewCompleted outside REVIEWING returns base unchanged", () => {
    for (const state of ["VERIFYING", "ADJUDICATING", "EXECUTING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("ReviewCompleted", { reviewRef: aref("r1"), candidateIds: [], driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
    }
  });

  it("AdjudicationCompleted outside ADJUDICATING returns base unchanged", () => {
    for (const state of ["REVIEWING", "FINAL_AUDIT", "VERIFYING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("AdjudicationCompleted", { decisionRefs: [aref("d1")], driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
    }
  });

  it("FinalAuditCompleted outside FINAL_AUDIT returns base unchanged", () => {
    for (const state of ["ADJUDICATING", "COMPLETION_GATE", "REVIEWING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("FinalAuditCompleted", { auditRefs: [aref("a1"), aref("a2")], accepted: true, driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
    }
  });

  it("CompletionEvaluated outside COMPLETION_GATE returns base unchanged", () => {
    for (const state of ["FINAL_AUDIT", "REPAIRING", "EXECUTING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("CompletionEvaluated", { reportRef: aref("r1"), accepted: true, driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.terminalReportRef).toBe(record.terminalReportRef);
    }
  });

  it("ExecutionStarted outside READY/VERIFYING returns base unchanged", () => {
    for (const state of ["EXECUTING", "CONTRACT_REVIEW", "REVIEWING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("ExecutionStarted", { contractVersion: 1, executionPlanRef: aref("ep1"), driverFence: 0 }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.executionPlan).toBe(record.executionPlan);
    }
  });

  it("ExecutionStarted from VERIFYING re-enters EXECUTING and clears repair verification pending", () => {
    const record = makeRecord("VERIFYING", { repairVerificationPending: true });
    const result = goalReducer(
      event("ExecutionStarted", { contractVersion: 1, executionPlanRef: aref("ep1"), driverFence: 0 }),
      record,
    );
    expect(result.state).toBe("EXECUTING");
    expect(result.repairVerificationPending).toBe(false);
  });

  it("GoalStarted outside CREATED returns base unchanged", () => {
    for (const state of ["PREPARING", "READY", "DONE"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(event("GoalStarted"), record);
      expect(result.state).toBe(state);
    }
  });

  it("ResumeRequested outside PAUSED returns base unchanged", () => {
    for (const state of ["EXECUTING", "READY", "CANCELLING"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(event("ResumeRequested"), record);
      expect(result.state).toBe(state);
    }
  });

  it("CancellationSettled outside CANCELLING returns base unchanged", () => {
    for (const state of ["EXECUTING", "CANCELLED", "FAILED"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(
        event("CancellationSettled", { cleanupRef: aref("c1"), mutationOutcome: "SETTLED" }),
        record,
      );
      expect(result.state).toBe(state);
    }
  });

  it("CancelRequested on terminal/CANCELLING returns base unchanged", () => {
    for (const state of ["DONE", "CANCELLED", "CANCELLING", "FAILED"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(event("CancelRequested", { reason: "x" }), record);
      expect(result.state).toBe(state);
    }
  });

  it("PauseRequested on terminal/CANCELLING returns base unchanged", () => {
    for (const state of ["DONE", "CANCELLING", "BLOCKED"] as GoalState[]) {
      const record = makeRecord(state);
      const result = goalReducer(event("PauseRequested", { reason: "x" }), record);
      expect(result.state).toBe(state);
    }
  });

  it("FatalError/BlockDeclared/ConvergenceLimitReached on terminal return base unchanged", () => {
    const record = makeRecord("DONE");
    expect(goalReducer(event("FatalError", { errorRef: aref("e") }), record).state).toBe("DONE");
    expect(goalReducer(event("BlockDeclared", { blockerRefs: [aref("b")] }), record).state).toBe("DONE");
    expect(goalReducer(event("ConvergenceLimitReached", { evidenceRef: aref("e") }), record).state).toBe("DONE");
  });

  it("BlockDeclared/ConvergenceLimitReached from CANCELLING return base unchanged", () => {
    const record = makeRecord("CANCELLING");
    expect(goalReducer(event("BlockDeclared", { blockerRefs: [aref("b")] }), record).state).toBe("CANCELLING");
    expect(goalReducer(event("ConvergenceLimitReached", { evidenceRef: aref("e") }), record).state).toBe("CANCELLING");
  });
});

describe("out-of-state assignment pollution", () => {
  it("AssignmentCompleted outside EXECUTING writes nothing", () => {
    for (const state of ["VERIFYING", "REVIEWING", "READY", "REPAIRING"] as GoalState[]) {
      const record = makeRecord(state);
      const fenceBefore = record.driverFenceCounter;
      const result = goalReducer(
        event("AssignmentCompleted", { assignmentId: "a-1" as never, reportRef: aref("r1"), driverFence: 9 }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.assignmentStates).toEqual(record.assignmentStates);
      expect(result.driverFenceCounter).toBe(fenceBefore);
      expect(result.activeRuns).toEqual(record.activeRuns);
    }
  });

  it("AssignmentFailed outside EXECUTING writes nothing", () => {
    for (const state of ["VERIFYING", "REVIEWING", "READY", "REPAIRING"] as GoalState[]) {
      const record = makeRecord(state);
      const fenceBefore = record.driverFenceCounter;
      const result = goalReducer(
        event("AssignmentFailed", { assignmentId: "a-1" as never, errorRef: aref("e1"), driverFence: 9 }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.assignmentStates).toEqual(record.assignmentStates);
      expect(result.driverFenceCounter).toBe(fenceBefore);
      expect(result.activeRuns).toEqual(record.activeRuns);
    }
  });

  it("RepairCompleted outside REPAIRING writes nothing", () => {
    for (const state of ["EXECUTING", "VERIFYING", "ADJUDICATING", "COMPLETION_GATE"] as GoalState[]) {
      const record = makeRecord(state);
      const fenceBefore = record.driverFenceCounter;
      const result = goalReducer(
        event("RepairCompleted", { assignmentId: "a-1" as never, reportRef: aref("r1"), driverFence: 9 }),
        record,
      );
      expect(result.state).toBe(state);
      expect(result.assignmentStates).toEqual(record.assignmentStates);
      expect(result.driverFenceCounter).toBe(fenceBefore);
      expect(result.activeRuns).toEqual(record.activeRuns);
    }
  });
});
