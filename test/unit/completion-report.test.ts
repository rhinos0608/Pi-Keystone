import { describe, it, expect } from "vitest";
import type { GoalRecord, GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { formatCompletion } from "../../src/ui/completion-report.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test",
  canonicalRoot: "/tmp/test",
  projectKey: "abc",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-1" as any,
  observedAt: new Date().toISOString() as any,
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

describe("formatCompletion", () => {
  it("throws for non-terminal state", () => {
    const goal = makeGoal({ state: "EXECUTING" });
    expect(() => formatCompletion(goal)).toThrow("not terminal");
  });

  it("DONE: includes task name, contract version, review/repair counts", () => {
    const goal = makeGoal({
      state: "DONE",
      userTask: "add login",
      contractVersion: 2,
      reviewCycles: 1,
      repairCycles: 0,
      terminalReportRef: "report-1" as any,
    });
    const report = formatCompletion(goal);
    expect(report.status).toBe("DONE");
    expect(report.summary).toContain("add login");
    expect(report.summary).toContain("completed successfully");
    expect(report.summary).toContain("v2");
    expect(report.summary).toContain("1 review cycle");
    expect(report.evidenceRefs).toContain("report-1");
  });

  it("BLOCKED: actionable explanation", () => {
    const goal = makeGoal({ state: "BLOCKED", userTask: "fix bug", planEpoch: 3 });
    const report = formatCompletion(goal);
    expect(report.status).toBe("BLOCKED");
    expect(report.summary).toContain("blocked");
    expect(report.summary).toContain("plan epoch 3");
    expect(report.summary).toContain("Manual intervention");
  });

  it("FAILED: includes error report ref when present", () => {
    const goal = makeGoal({
      state: "FAILED",
      userTask: "deploy",
      terminalReportRef: "err-report" as any,
    });
    const report = formatCompletion(goal);
    expect(report.status).toBe("FAILED");
    expect(report.summary).toContain("deploy");
    expect(report.summary).toContain("Error report: err-report");
    expect(report.evidenceRefs).toContain("err-report");
  });

  it("FAILED: no error ref when absent", () => {
    const goal = makeGoal({ state: "FAILED", userTask: "deploy" });
    const report = formatCompletion(goal);
    expect(report.summary).not.toContain("Error report");
  });

  it("NON_CONVERGENT: includes cycle counts and finding ledger", () => {
    const goal = makeGoal({
      state: "NON_CONVERGENT",
      userTask: "optimize",
      reviewCycles: 4,
      repairCycles: 3,
      contractVersion: 1,
      findingLedgerRef: "ledger-1" as any,
    });
    const report = formatCompletion(goal);
    expect(report.status).toBe("NON_CONVERGENT");
    expect(report.summary).toContain("did not converge");
    expect(report.summary).toContain("4 review cycle");
    expect(report.summary).toContain("3 repair cycle");
    expect(report.evidenceRefs).toContain("ledger-1");
  });

  it("CANCELLED: includes reason when present", () => {
    const goal = makeGoal({
      state: "CANCELLED",
      userTask: "build feature",
      cancellationReason: "no longer needed",
    });
    const report = formatCompletion(goal);
    expect(report.status).toBe("CANCELLED");
    expect(report.summary).toContain("cancelled");
    expect(report.summary).toContain("no longer needed");
  });

  it("CANCELLED: no reason when absent", () => {
    const goal = makeGoal({ state: "CANCELLED", userTask: "build feature" });
    const report = formatCompletion(goal);
    expect(report.summary).toContain("cancelled");
    expect(report.summary).not.toContain("Reason:");
  });

  it("goalId is preserved", () => {
    const goal = makeGoal({ state: "DONE", goalId: "g-x" as GoalId });
    expect(formatCompletion(goal).goalId).toBe("g-x");
  });

  it("state is preserved in report", () => {
    const goal = makeGoal({ state: "BLOCKED" });
    expect(formatCompletion(goal).state).toBe("BLOCKED");
  });

  it("collects all evidence refs when present", () => {
    const goal = makeGoal({
      state: "DONE",
      terminalReportRef: "t1" as any,
      findingLedgerRef: "fl" as any,
      evidenceIndexRef: "ei" as any,
    });
    const refs = formatCompletion(goal).evidenceRefs;
    expect(refs).toEqual(["t1", "fl", "ei"]);
  });

  it("DONE with null contract version shows N/A", () => {
    const goal = makeGoal({ state: "DONE", contractVersion: null });
    expect(formatCompletion(goal).summary).toContain("vN/A");
  });
});
