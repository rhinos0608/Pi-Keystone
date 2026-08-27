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

  it("VerificationCompleted: rejected → EXECUTING", () => {
    const record = makeRecord("VERIFYING");
    const result = goalReducer(
      event("VerificationCompleted", {
        runRef: aref("vr1"),
        accepted: false,
        driverFence: 1,
      }),
      record,
    );
    expect(result.state).toBe("EXECUTING");
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
  it("DONE → GoalStarted returns unchanged state (default case)", () => {
    const record = makeRecord("DONE");
    const result = goalReducer(event("GoalStarted"), record);
    expect(result.state).toBe("DONE");
  });

  it("CANCELLED → ExecutionStarted returns unchanged state (default case)", () => {
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
  });

  it("BLOCKED → ReviewCompleted returns unchanged state (default case)", () => {
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

  it("FAILED → AdjudicationCompleted returns unchanged state (default case)", () => {
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
});
