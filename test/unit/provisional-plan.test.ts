import { describe, it, expect } from "vitest";
import {
  createProvisionalPlan,
  validatePlan,
  incrementEpoch,
  isStale,
  type GoalContract,
  type BaselineResults,
  type PlanAssignment,
} from "../../src/planning/provisional-plan.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONTRACT: GoalContract = {
  goalId: "goal-001",
  version: 1,
  criteria: [
    { id: "criterion-a", description: "Type check passes" },
    { id: "criterion-b", description: "Tests pass" },
    { id: "criterion-c", description: "No regressions" },
  ],
};

const BASELINE: BaselineResults = {
  tasks: [
    { taskName: "typecheck", filePaths: ["src/a.ts"], status: "succeeded" },
    { taskName: "tests", filePaths: ["test/b.test.ts"], status: "failed", diagnostics: ["timeout"] },
  ],
  verificationPassed: false,
  verificationDiagnostics: ["test suite timed out"],
};

const EMPTY_BASELINE: BaselineResults = {
  tasks: [],
  verificationPassed: true,
};

const VALID_ASSIGNMENT: PlanAssignment = {
  id: "assign-1",
  description: "Fix type errors",
  targetFiles: ["src/a.ts"],
  role: "worker",
  acceptanceCriteria: ["criterion-a"],
};

// ─── Create plan from contract ──────────────────────────────────────────────

describe("createProvisionalPlan", () => {
  it("creates plan from contract and baseline results", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
      risks: ["type definitions may shift"],
    });

    expect(plan.goalId).toBe("goal-001");
    expect(plan.planEpoch).toBe(0);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].id).toBe("assign-1");
    expect(plan.risks).toEqual(["type definitions may shift"]);
  });

  it("derives assumptions from baseline succeeded tasks when none provided", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    expect(plan.assumptions).toEqual(['Baseline task "typecheck" passes']);
    expect(plan.assumptions.length).toBe(1);
  });

  it("uses provided assumptions when given", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
      assumptions: ["custom assumption"],
    });

    expect(plan.assumptions).toEqual(["custom assumption"]);
  });

  it("defaults risks and assumptions to empty arrays", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: EMPTY_BASELINE,
      assignments: [],
    });

    expect(plan.assumptions).toEqual([]);
    expect(plan.risks).toEqual([]);
  });
});

// ─── Epoch increment ────────────────────────────────────────────────────────

describe("incrementEpoch", () => {
  it("increments epoch by 1", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    expect(plan.planEpoch).toBe(0);
    const bumped = incrementEpoch(plan);
    expect(bumped.planEpoch).toBe(1);
  });

  it("is cumulative across multiple increments", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    const e1 = incrementEpoch(plan);
    const e2 = incrementEpoch(e1);
    const e3 = incrementEpoch(e2);
    expect(e3.planEpoch).toBe(3);
  });

  it("does not mutate the original plan", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    incrementEpoch(plan);
    expect(plan.planEpoch).toBe(0);
  });
});

// ─── Stale plan rejection ───────────────────────────────────────────────────

describe("isStale", () => {
  it("returns true when plan epoch is behind current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    expect(isStale(plan, 1)).toBe(true);
    expect(isStale(plan, 5)).toBe(true);
  });

  it("returns false when plan epoch matches current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    expect(isStale(plan, 0)).toBe(false);
  });

  it("returns false when plan epoch is ahead of current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [VALID_ASSIGNMENT],
    });

    const bumped = incrementEpoch(incrementEpoch(plan));
    expect(isStale(bumped, 0)).toBe(false);
  });
});

// ─── Empty assignments rejected ─────────────────────────────────────────────

describe("validatePlan — empty assignments", () => {
  it("rejects plan with no assignments", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [],
    });

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan must have at least one assignment");
  });
});

// ─── Valid plan accepted ────────────────────────────────────────────────────

describe("validatePlan — valid plan", () => {
  it("accepts plan where all criteria references are valid", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [
        VALID_ASSIGNMENT,
        {
          id: "assign-2",
          description: "Fix tests",
          targetFiles: ["test/b.test.ts"],
          role: "worker",
          acceptanceCriteria: ["criterion-b", "criterion-c"],
        },
      ],
    });

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects plan referencing unknown criterion", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [
        {
          id: "assign-bad",
          description: "Do something",
          targetFiles: ["src/x.ts"],
          role: "worker",
          acceptanceCriteria: ["criterion-a", "nonexistent-criterion"],
        },
      ],
    });

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Assignment "assign-bad" references unknown criterion "nonexistent-criterion"',
    ]);
  });

  it("collects multiple validation errors", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: [
        {
          id: "assign-x",
          description: "X",
          targetFiles: [],
          role: "worker",
          acceptanceCriteria: ["bad-1"],
        },
        {
          id: "assign-y",
          description: "Y",
          targetFiles: [],
          role: "worker",
          acceptanceCriteria: ["bad-2"],
        },
      ],
    });

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});
