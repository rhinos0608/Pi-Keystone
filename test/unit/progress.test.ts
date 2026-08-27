import { describe, it, expect } from "vitest";
import type { GoalRecord, GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { formatProgress } from "../../src/ui/progress.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test",
  canonicalRoot: "/tmp/test",
  projectKey: "abc",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-1" as any,
  observedAt: iso() as any,
  gitHead: "abc",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "sig",
  capabilityDigest: "cap",
};

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const base = createGoalRecord("goal-1" as GoalId, "test task", WORKSPACE, REVISION);
  return { ...base, ...overrides };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("formatProgress", () => {
  it("returns correct shape", () => {
    const goal = makeGoal();
    const result = formatProgress(goal);
    expect(result).toHaveProperty("phase");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("timestamp");
  });

  it("CREATED → 'Goal created'", () => {
    const goal = makeGoal({ state: "CREATED" });
    expect(formatProgress(goal).message).toBe("Goal created");
  });

  it("PREPARING → shows preparation status", () => {
    const goal = makeGoal({ state: "PREPARING" });
    expect(formatProgress(goal).message).toBe("Preparing baseline and plan");
  });

  it("PREPARING with both succeeded → 'Preparation complete'", () => {
    const goal = makeGoal({
      state: "PREPARING",
      preparation: {
        baselineJob: { kind: "baseline", planEpoch: 0, attemptId: "a", basedOnRevision: REVISION, status: "SUCCEEDED" },
        provisionalPlanJob: { kind: "plan", planEpoch: 0, attemptId: "b", basedOnRevision: REVISION, status: "SUCCEEDED" },
      },
    });
    expect(formatProgress(goal).message).toBe("Preparation complete");
  });

  it("PREPARING with failure → 'Preparation failed'", () => {
    const goal = makeGoal({
      state: "PREPARING",
      preparation: {
        baselineJob: { kind: "baseline", planEpoch: 0, attemptId: "a", basedOnRevision: REVISION, status: "FAILED" },
        provisionalPlanJob: { kind: "plan", planEpoch: 0, attemptId: "b", basedOnRevision: REVISION, status: "PENDING" },
      },
    });
    expect(formatProgress(goal).message).toBe("Preparation failed");
  });

  it("RECONCILING → 'Baseline reconciled'", () => {
    expect(formatProgress(makeGoal({ state: "RECONCILING" })).message).toBe("Baseline reconciled");
  });

  it("CONTRACT_REVIEW → 'Contract under review'", () => {
    expect(formatProgress(makeGoal({ state: "CONTRACT_REVIEW" })).message).toBe("Contract under review");
  });

  it("READY → 'Contract frozen'", () => {
    expect(formatProgress(makeGoal({ state: "READY" })).message).toBe("Contract frozen");
  });

  it("EXECUTING → includes contract version", () => {
    const goal = makeGoal({ state: "EXECUTING", contractVersion: 3 });
    expect(formatProgress(goal).message).toBe("Execution phase · contract v3");
  });

  it("EXECUTING with null contract version → defaults to 1", () => {
    const goal = makeGoal({ state: "EXECUTING", contractVersion: null });
    expect(formatProgress(goal).message).toBe("Execution phase · contract v1");
  });

  it("VERIFYING → 'Verifying changes'", () => {
    expect(formatProgress(makeGoal({ state: "VERIFYING" })).message).toBe("Verifying changes");
  });

  it("REVIEWING → 'Reviewing results'", () => {
    expect(formatProgress(makeGoal({ state: "REVIEWING" })).message).toBe("Reviewing results");
  });

  it("ADJUDICATING → 'Adjudicating findings'", () => {
    expect(formatProgress(makeGoal({ state: "ADJUDICATING" })).message).toBe("Adjudicating findings");
  });

  it("REPAIRING → includes attempt count", () => {
    const goal = makeGoal({ state: "REPAIRING", repairCycles: 2 });
    expect(formatProgress(goal).message).toBe("Repairing · attempt 2");
  });

  it("FINAL_AUDIT → 'Final audit in progress'", () => {
    expect(formatProgress(makeGoal({ state: "FINAL_AUDIT" })).message).toBe("Final audit in progress");
  });

  it("COMPLETION_GATE → 'Evaluating completion'", () => {
    expect(formatProgress(makeGoal({ state: "COMPLETION_GATE" })).message).toBe("Evaluating completion");
  });

  it("PAUSED with reason", () => {
    const goal = makeGoal({ state: "PAUSED", pauseReason: "user break" });
    expect(formatProgress(goal).message).toBe("Paused — user break");
  });

  it("PAUSED without reason", () => {
    expect(formatProgress(makeGoal({ state: "PAUSED" })).message).toBe("Paused");
  });

  it("CANCELLING → 'Cancelling…'", () => {
    expect(formatProgress(makeGoal({ state: "CANCELLING" })).message).toBe("Cancelling…");
  });

  it("DONE → 'Goal completed'", () => {
    expect(formatProgress(makeGoal({ state: "DONE" })).message).toBe("Goal completed");
  });

  it("BLOCKED → 'Goal blocked'", () => {
    expect(formatProgress(makeGoal({ state: "BLOCKED" })).message).toBe("Goal blocked");
  });

  it("FAILED → 'Goal failed'", () => {
    expect(formatProgress(makeGoal({ state: "FAILED" })).message).toBe("Goal failed");
  });

  it("NON_CONVERGENT → includes review cycle count", () => {
    const goal = makeGoal({ state: "NON_CONVERGENT", reviewCycles: 5 });
    expect(formatProgress(goal).message).toBe("Non-convergent after 5 review cycles");
  });

  it("CANCELLED → 'Goal cancelled'", () => {
    expect(formatProgress(makeGoal({ state: "CANCELLED" })).message).toBe("Goal cancelled");
  });

  it("timestamp matches updatedAt", () => {
    const ts = "2025-01-15T10:30:00.000Z";
    const goal = makeGoal({ updatedAt: ts as any });
    expect(formatProgress(goal).timestamp).toBe(ts);
  });
});
