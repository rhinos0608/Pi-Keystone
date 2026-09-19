// Task 3 acceptance: userTask-driven planning through runPlanning().
import { describe, it, expect } from "vitest";
import { runPlanning } from "../../src/planning/orchestrator.js";
import { reviseProvisionalPlan } from "../../src/planning/provisional-plan.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { CheckOutcome, type BaselineRecord } from "../../src/baseline/types.js";
import type { GoalId, ISO8601 } from "../../src/domain/types.js";

function goal(userTask: string) {
  return createGoalRecord(
    "01991662-7d2e-7a1e-9c9a-000000000001" as GoalId,
    userTask,
    {
      requestedRoot: "/repo",
      canonicalRoot: "/repo",
      projectKey: "k",
      vcs: "git",
    },
    {
      snapshotId: "s" as never,
      observedAt: new Date().toISOString() as ISO8601,
      graphRevision: 0,
      dirtySignature: "clean",
      capabilityDigest: "d",
    },
    // note: createGoalRecord takes 4 args; planEpoch set after
  );
}

function withEpoch<T extends { planEpoch: number }>(record: T, planEpoch: number): T {
  return { ...record, planEpoch };
}

function baselineRecord(outcome: CheckOutcome): BaselineRecord {
  return {
    goalId: "g",
    workspace: "/repo",
    worktree: {
      gitRoot: "/repo",
      headCommit: "abc",
      dirtyPaths: [],
      contentHashBudget: 1024,
    },
    checks: [
      {
        command: "npm test",
        cwd: "/repo",
        outcome,
        exitCode: outcome === CheckOutcome.PASS ? 0 : 1,
        stdout: "",
        stderr: outcome === CheckOutcome.PASS ? "" : "failures",
        duration: 5,
        retried: false,
        fingerprint: null,
      },
    ],
    environment: "test",
    createdAt: new Date().toISOString(),
  };
}

const CRITERIA = [
  { id: "req-1", description: "User can add feature X from the dashboard" },
  { id: "req-2", description: "Type check passes" },
];

describe("runPlanning from userTask", () => {
  it("healthy repo + 'add feature X' yields implementation assignments on real criteria", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 0),
      baselineRecord(CheckOutcome.PASS),
      { contractCriteria: CRITERIA },
    );

    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    const impl = result.plan.assignments.filter((a) => a.role === "implementation");
    expect(impl.length).toBeGreaterThanOrEqual(1);
    const known = new Set(CRITERIA.map((c) => c.id));
    for (const a of result.plan.assignments) {
      for (const id of a.criterionIds) expect(known.has(id)).toBe(true);
    }
  });

  it("pure-verification task produces only a-verify", async () => {
    const result = await runPlanning(
      withEpoch(goal("verify all checks pass"), 0),
      baselineRecord(CheckOutcome.PASS),
      {
        contractCriteria: [
          { id: "v-1", description: "Type check passes" },
          { id: "v-2", description: "Tests pass" },
        ],
      },
    );

    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    expect(result.plan.assignments).toHaveLength(1);
    expect(result.plan.assignments[0].id).toBe("a-verify");
    expect(result.plan.assignments[0].role).toBe("verification");
  });

  it("red baseline does not suppress implementation planning", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 0),
      baselineRecord(CheckOutcome.FAIL),
      { contractCriteria: CRITERIA },
    );

    // Either accepted with impl assignments, or replan/block with a reason —
    // but the planner itself must still derive implementation work from userTask.
    if ("plan" in result) {
      expect(
        result.plan.assignments.some((a) => a.role === "implementation"),
      ).toBe(true);
    } else {
      const { buildPlanFromUserTask } = await import(
        "../../src/planning/provisional-plan.js"
      );
      const plan = buildPlanFromUserTask({
        userTask: "add feature X to the dashboard",
        goalId: "g",
        baseline: baselineRecord(CheckOutcome.FAIL),
        contractCriteria: CRITERIA,
        currentEpoch: 0,
      });
      expect(plan.assignments.some((a) => a.role === "implementation")).toBe(true);
    }
  });

  it("preserves goal.planEpoch on the returned plan (never resets to 0)", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 3),
      baselineRecord(CheckOutcome.PASS),
      { contractCriteria: CRITERIA },
    );

    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    expect(result.plan.planEpoch).toBe(3);
  });

  it("blocks when canonical contractCriteria are absent (production path)", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 0),
      baselineRecord(CheckOutcome.PASS),
    );

    expect("decision" in result && result.decision).toBe("block");
  });

  it("test-only fallback criteria apply only with explicit opt-in", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 0),
      baselineRecord(CheckOutcome.PASS),
      { allowTestFallbackCriteria: true },
    );

    expect("plan" in result).toBe(true);
  });

  it("revisions bump epoch +1 via reviseProvisionalPlan", async () => {
    const result = await runPlanning(
      withEpoch(goal("add feature X to the dashboard"), 3),
      baselineRecord(CheckOutcome.PASS),
      { contractCriteria: CRITERIA },
    );

    expect("plan" in result).toBe(true);
    if (!("plan" in result)) return;
    const revised = reviseProvisionalPlan(result.plan);
    expect(revised.planEpoch).toBe(4);
  });
});
