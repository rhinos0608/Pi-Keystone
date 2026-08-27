import { describe, it } from "vitest";
import type { GoalRecord, GoalId, ArtifactRef, ISO8601 } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import {
  projectGoalStoreView,
  type ProjectionRole,
} from "../../src/context/projections.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeWorkspace() {
  return {
    requestedRoot: "/tmp/test",
    canonicalRoot: "/tmp/test",
    projectKey: "abc123" as any,
    vcs: "git" as const,
  };
}

function fakeRevision() {
  return {
    snapshotId: "snap1" as any,
    observedAt: new Date().toISOString() as ISO8601,
    gitHead: "abc",
    branch: "main",
    graphRevision: 1,
    dirtySignature: "sig",
    capabilityDigest: "cap",
  };
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const base = createGoalRecord(
    "goal-1" as GoalId,
    "implement auth module",
    fakeWorkspace(),
    fakeRevision(),
  );
  return { ...base, ...overrides };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("projectGoalStoreView", () => {
  const goal = makeGoal({
    state: "EXECUTING",
    planEpoch: 2,
    contractVersion: 3,
    activeContractRef: "contract-ref-1" as ArtifactRef,
    baselineRef: "baseline-ref-1" as ArtifactRef,
    findingLedgerRef: "finding-ledger" as ArtifactRef,
    evidenceIndexRef: "evidence-idx" as ArtifactRef,
    verificationIndexRef: "verification-idx" as ArtifactRef,
    reviewCycles: 1,
    repairCycles: 0,
    finalAuditAttempts: 0,
    terminalReportRef: "terminal-report" as ArtifactRef,
  });

  it("user projection includes goalId, userTask, state, timestamps, recoveryRequired", () => {
    const view = projectGoalStoreView(goal, "user");

    expect(view.kind).toEqual("user");
    expect(view.goalId).toEqual("goal-1");
    expect(view.userTask).toEqual("implement auth module");
    expect(view.state).toEqual("EXECUTING");
    expect(view.createdAt).toBeDefined();
    expect(view.updatedAt).toBeDefined();
    expect(view.recoveryRequired).toEqual(false);
    expect(view.terminalReportRef).toEqual("terminal-report");
  });

  it("user projection excludes internal fields", () => {
    const view = projectGoalStoreView(goal, "user");
    const keys = Object.keys(view);

    expect(keys).not.toContain("preparation");
    expect(keys).not.toContain("driverFenceCounter");
    expect(keys).not.toContain("mutationFenceCounter");
    expect(keys).not.toContain("reviewCycles");
    expect(keys).not.toContain("findingLedgerRef");
    expect(keys).not.toContain("snapshotRefs");
    expect(keys).not.toContain("workspace");
  });

  it("executor projection includes execution-relevant fields", () => {
    const view = projectGoalStoreView(goal, "executor");

    expect(view.kind).toEqual("executor");
    expect(view.goalId).toEqual("goal-1");
    expect(view.state).toEqual("EXECUTING");
    expect(view.planEpoch).toEqual(2);
    expect(view.contractVersion).toEqual(3);
    expect(view.activeContractRef).toEqual("contract-ref-1");
    expect(view.baselineRef).toEqual("baseline-ref-1");
    expect(view.preparation).toBeDefined();
    expect(view.driverFenceCounter).toBeDefined();
    expect(view.mutationFenceCounter).toBeDefined();
    expect(view.recoveryRequired).toEqual(false);
    expect(view.currentRevision).toBeDefined();
  });

  it("executor projection excludes reviewer/user fields", () => {
    const view = projectGoalStoreView(goal, "executor");
    const keys = Object.keys(view);

    expect(keys).not.toContain("userTask");
    expect(keys).not.toContain("reviewCycles");
    expect(keys).not.toContain("repairCycles");
    expect(keys).not.toContain("findingLedgerRef");
    expect(keys).not.toContain("evidenceIndexRef");
    expect(keys).not.toContain("terminalReportRef");
  });

  it("reviewer projection includes audit and review fields", () => {
    const view = projectGoalStoreView(goal, "reviewer");

    expect(view.kind).toEqual("reviewer");
    expect(view.goalId).toEqual("goal-1");
    expect(view.state).toEqual("EXECUTING");
    expect(view.planEpoch).toEqual(2);
    expect(view.reviewCycles).toEqual(1);
    expect(view.repairCycles).toEqual(0);
    expect(view.finalAuditAttempts).toEqual(0);
    expect(view.findingLedgerRef).toEqual("finding-ledger");
    expect(view.evidenceIndexRef).toEqual("evidence-idx");
    expect(view.verificationIndexRef).toEqual("verification-idx");
    expect(view.activeContractRef).toEqual("contract-ref-1");
  });

  it("reviewer projection excludes executor and user fields", () => {
    const view = projectGoalStoreView(goal, "reviewer");
    const keys = Object.keys(view);

    expect(keys).not.toContain("userTask");
    expect(keys).not.toContain("preparation");
    expect(keys).not.toContain("driverFenceCounter");
    expect(keys).not.toContain("mutationFenceCounter");
    expect(keys).not.toContain("currentRevision");
    expect(keys).not.toContain("terminalReportRef");
  });

  it("auditor projection returns full GoalRecord", () => {
    const view = projectGoalStoreView(goal, "auditor");

    expect(view.kind).toEqual("auditor");
    // AuditorProjection extends GoalRecord — all original fields present
    expect((view as any).goalId).toEqual("goal-1");
    expect((view as any).userTask).toEqual("implement auth module");
    expect((view as any).preparation).toBeDefined();
    expect((view as any).workspace).toBeDefined();
    expect((view as any).snapshotRefs).toBeDefined();
    expect((view as any).reviewCycles).toEqual(1);
  });

  it("all projections have kind discriminator", () => {
    const roles: ProjectionRole[] = ["user", "executor", "reviewer", "auditor"];
    for (const role of roles) {
      const view = projectGoalStoreView(goal, role);
      expect(view.kind).toEqual(role);
    }
  });

  it("user projection omits terminalReportRef when undefined", () => {
    const freshGoal = makeGoal();
    const view = projectGoalStoreView(freshGoal, "user");
    expect("terminalReportRef" in view).toEqual(false);
  });
});
