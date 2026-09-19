import { describe, it, expect } from "vitest";
import {
  buildPlanFromUserTask,
  createProvisionalPlan,
  validatePlan,
  assertPlanCoverage,
  uncoveredCriteria,
  reviseProvisionalPlan,
  incrementEpoch,
  isStale,
  PlanCoverageError,
  type GoalContract,
  type BaselineResults,
  type PlanAssignment,
  type PlanInput,
} from "../../src/planning/provisional-plan.js";
import type { BaselineRecord } from "../../src/baseline/types.js";
import { CheckOutcome } from "../../src/baseline/types.js";

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
  criterionIds: ["criterion-a"],
  acceptanceCriteria: ["criterion-a"],
};

function fullCoverageAssignments(): PlanAssignment[] {
  return [
    VALID_ASSIGNMENT,
    {
      id: "assign-2",
      description: "Fix tests",
      targetFiles: ["test/b.test.ts"],
      role: "worker",
      criterionIds: ["criterion-b", "criterion-c"],
      acceptanceCriteria: ["criterion-b", "criterion-c"],
    },
  ];
}

function baselineRecord(checks: BaselineRecord["checks"]): BaselineRecord {
  return {
    goalId: "goal-001",
    workspace: "/repo",
    worktree: {
      gitRoot: "/repo",
      headCommit: "abc123",
      dirtyPaths: [],
      contentHashBudget: 1024,
    },
    checks,
    environment: "test",
    createdAt: new Date().toISOString(),
  };
}

function planInput(userTask: string, criteria = CONTRACT.criteria, currentEpoch = 0): PlanInput {
  return {
    userTask,
    goalId: "goal-001",
    baseline: baselineRecord([]),
    contractCriteria: criteria,
    currentEpoch,
  };
}

// ─── Create plan from contract ──────────────────────────────────────────────

describe("createProvisionalPlan", () => {
  it("creates plan from contract and baseline results", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
      risks: ["type definitions may shift"],
    });

    expect(plan.goalId).toBe("goal-001");
    expect(plan.planEpoch).toBe(0);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments[0].id).toBe("assign-1");
    expect(plan.risks).toEqual(["type definitions may shift"]);
  });

  it("honors the required currentEpoch (no literal 0)", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 4,
    });

    expect(plan.planEpoch).toBe(4);
  });

  it("rejects empty assignments with PlanCoverageError", () => {
    expect(() =>
      createProvisionalPlan({
        contract: CONTRACT,
        baseline: EMPTY_BASELINE,
        assignments: [],
        currentEpoch: 0,
      }),
    ).toThrow(PlanCoverageError);
  });

  it("rejects unknown criterion refs with PlanCoverageError", () => {
    expect(() =>
      createProvisionalPlan({
        contract: CONTRACT,
        baseline: BASELINE,
        assignments: [
          {
            id: "assign-bad",
            description: "Do something",
            targetFiles: ["src/x.ts"],
            role: "worker",
            criterionIds: ["criterion-a", "nonexistent-criterion"],
            acceptanceCriteria: ["criterion-a", "nonexistent-criterion"],
          },
        ],
        currentEpoch: 0,
      }),
    ).toThrow(PlanCoverageError);
  });

  it("derives assumptions from baseline succeeded tasks when none provided", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    expect(plan.assumptions).toEqual(['Baseline task "typecheck" passes']);
    expect(plan.assumptions.length).toBe(1);
  });

  it("uses provided assumptions when given", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
      assumptions: ["custom assumption"],
    });

    expect(plan.assumptions).toEqual(["custom assumption"]);
  });

  it("defaults risks and assumptions to empty arrays", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: EMPTY_BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    expect(plan.assumptions).toEqual([]);
    expect(plan.risks).toEqual([]);
  });

  it("syncs criterionIds from legacy acceptanceCriteria", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: EMPTY_BASELINE,
      assignments: [
        {
          id: "legacy",
          description: "Legacy shape",
          targetFiles: [],
          role: "worker",
          criterionIds: [],
          acceptanceCriteria: ["criterion-a"],
        },
        {
          id: "cover-rest",
          description: "Cover remaining criteria",
          targetFiles: [],
          role: "worker",
          criterionIds: ["criterion-b", "criterion-c"],
          acceptanceCriteria: ["criterion-b", "criterion-c"],
        },
      ],
      currentEpoch: 0,
    });

    expect(plan.assignments[0].criterionIds).toEqual(["criterion-a"]);
  });
});

// ─── Epoch increment ────────────────────────────────────────────────────────

describe("incrementEpoch", () => {
  it("increments epoch by 1", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 2,
    });

    expect(plan.planEpoch).toBe(2);
    const bumped = incrementEpoch(plan);
    expect(bumped.planEpoch).toBe(3);
  });

  it("is cumulative across multiple increments", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
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
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    incrementEpoch(plan);
    expect(plan.planEpoch).toBe(0);
  });
});

// ─── Plan revisions ─────────────────────────────────────────────────────────

describe("reviseProvisionalPlan", () => {
  it("bumps epoch +1 and never resets to 0", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    const r1 = reviseProvisionalPlan(plan);
    expect(r1.planEpoch).toBe(1);
    const r2 = reviseProvisionalPlan(r1, { risks: ["new risk"] });
    expect(r2.planEpoch).toBe(2);
    expect(r2.risks).toEqual(["new risk"]);
    expect(r2.assignments).toEqual(plan.assignments);
    // originals untouched
    expect(plan.planEpoch).toBe(0);
    expect(r1.planEpoch).toBe(1);
  });
});

// ─── Stale plan rejection ───────────────────────────────────────────────────

describe("isStale", () => {
  it("returns true when plan epoch is behind current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    expect(isStale(plan, 1)).toBe(true);
    expect(isStale(plan, 5)).toBe(true);
  });

  it("returns false when plan epoch matches current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    expect(isStale(plan, 0)).toBe(false);
  });

  it("returns false when plan epoch is ahead of current", () => {
    const plan = createProvisionalPlan({
      contract: CONTRACT,
      baseline: BASELINE,
      assignments: fullCoverageAssignments(),
      currentEpoch: 0,
    });

    const bumped = incrementEpoch(incrementEpoch(plan));
    expect(isStale(bumped, 0)).toBe(false);
  });
});

// ─── Empty assignments rejected ─────────────────────────────────────────────
// NOTE: createProvisionalPlan throws PlanCoverageError on empty assignments;
// validatePlan-level checks below use literal plan objects.

function literalPlan(assignments: PlanAssignment[]) {
  return {
    goalId: "goal-001",
    planEpoch: 0,
    assignments,
    assumptions: [] as string[],
    risks: [] as string[],
  };
}

describe("validatePlan — empty assignments", () => {
  it("rejects plan with no assignments", () => {
    const plan = literalPlan([]);

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Plan must have at least one assignment");
  });
});

// ─── Valid plan accepted ────────────────────────────────────────────────────

describe("validatePlan — valid plan", () => {
  it("accepts plan where all criteria references are valid", () => {
    const plan = literalPlan(fullCoverageAssignments());

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects plan referencing unknown criterion", () => {
    const plan = literalPlan([
      {
        id: "assign-bad",
        description: "Do something",
        targetFiles: ["src/x.ts"],
        role: "worker",
        criterionIds: ["criterion-a", "nonexistent-criterion"],
        acceptanceCriteria: ["criterion-a", "nonexistent-criterion"],
      },
    ]);

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Assignment "assign-bad" references unknown criterion "nonexistent-criterion"',
    );
  });

  it("rejects plan with uncovered criterion", () => {
    const plan = literalPlan([VALID_ASSIGNMENT]);

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('"criterion-b"') && e.includes("no covering assignment")),
    ).toBe(true);
  });

  it("collects multiple validation errors", () => {
    const plan = literalPlan([
      {
        id: "assign-x",
        description: "X",
        targetFiles: [],
        role: "worker",
        criterionIds: ["bad-1"],
        acceptanceCriteria: ["bad-1"],
      },
      {
        id: "assign-y",
        description: "Y",
        targetFiles: [],
        role: "worker",
        criterionIds: ["bad-2"],
        acceptanceCriteria: ["bad-2"],
      },
    ]);

    const result = validatePlan(plan, CONTRACT);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── UserTask-driven planning ───────────────────────────────────────────────

describe("buildPlanFromUserTask", () => {
  it("emits implementation assignments tied to real criteria for feature work", () => {
    const plan = buildPlanFromUserTask(
      planInput("add feature X: user profile page", [
        { id: "req-1", description: "User can view their profile page" },
        { id: "req-2", description: "Type check passes" },
      ]),
    );

    const impl = plan.assignments.filter((a) => a.role === "implementation");
    expect(impl.length).toBeGreaterThanOrEqual(1);
    for (const a of plan.assignments) {
      for (const id of a.criterionIds) {
        expect(["req-1", "req-2"]).toContain(id);
      }
      expect(a.id).not.toMatch(/^c-/);
    }
  });

  it("defaults ambiguous imperative wording to implementation instead of verifier-only", () => {
    const plan = buildPlanFromUserTask(
      planInput("make the button blue", [
        { id: "req-1", description: "Verify requested outcome: make the button blue" },
      ]),
    );
    expect(plan.assignments.some((a) => a.role === "implementation")).toBe(true);
    expect(plan.assignments.some((a) => a.role === "verification")).toBe(true);
  });

  it("never fabricates criterion references", () => {
    const plan = buildPlanFromUserTask(planInput("add dark mode toggle"));

    const known = new Set(CONTRACT.criteria.map((c) => c.id));
    for (const a of plan.assignments) {
      expect(a.criterionIds.length).toBeGreaterThanOrEqual(1);
      for (const id of a.criterionIds) {
        expect(known.has(id)).toBe(true);
      }
    }
  });

  it("emits only a-verify for pure-verification tasks", () => {
    const plan = buildPlanFromUserTask(
      planInput("verify all checks pass with no code changes", [
        { id: "v-1", description: "Type check passes" },
        { id: "v-2", description: "Tests pass" },
      ]),
    );

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].id).toBe("a-verify");
    expect(plan.assignments[0].role).toBe("verification");
  });

  it("throws PlanCoverageError when no criteria exist", () => {
    expect(() => buildPlanFromUserTask(planInput("add feature X", []))).toThrow(
      PlanCoverageError,
    );
  });

  it("plans implementation work even when the baseline is red", () => {
    const red = baselineRecord([
      {
        command: "npm test",
        cwd: "/repo",
        outcome: CheckOutcome.FAIL,
        exitCode: 1,
        stdout: "",
        stderr: "17 failures",
        duration: 10,
        retried: false,
        fingerprint: "f",
      },
    ]);
    const plan = buildPlanFromUserTask({
      userTask: "add feature X to the dashboard",
      goalId: "goal-001",
      baseline: red,
      contractCriteria: [
        { id: "req-1", description: "Dashboard shows feature X" },
      ],
      currentEpoch: 0,
    });

    expect(plan.assignments.some((a) => a.role === "implementation")).toBe(true);
  });

  it("honors currentEpoch instead of resetting to 0", () => {
    const plan = buildPlanFromUserTask(planInput("add feature X", undefined, 5));
    expect(plan.planEpoch).toBe(5);
  });

  it("pure-verify branch rejects non-verification-shaped criteria", () => {
    expect(() =>
      buildPlanFromUserTask(
        planInput("verify all checks pass with no code changes", [
          { id: "v-1", description: "Type check passes" },
          { id: "impl-1", description: "User can edit their profile page" },
        ]),
      ),
    ).toThrow(PlanCoverageError);
  });
});

// ─── Exact coverage ─────────────────────────────────────────────────────────

describe("assertPlanCoverage / uncoveredCriteria", () => {
  it("throws PlanCoverageError listing uncovered criteria", () => {
    const plan = literalPlan([VALID_ASSIGNMENT]);

    expect(uncoveredCriteria(plan, CONTRACT)).toEqual(
      expect.arrayContaining(["criterion-b", "criterion-c"]),
    );
    let caught: PlanCoverageError | null = null;
    try {
      assertPlanCoverage(plan, CONTRACT);
    } catch (err) {
      caught = err as PlanCoverageError;
    }
    expect(caught).toBeInstanceOf(PlanCoverageError);
    expect(caught!.uncoveredCriterionIds).toEqual(
      expect.arrayContaining(["criterion-b", "criterion-c"]),
    );
  });

  it("passes when every criterion maps to >= 1 assignment", () => {
    const plan = literalPlan(fullCoverageAssignments());

    expect(uncoveredCriteria(plan, CONTRACT)).toEqual([]);
    expect(() => assertPlanCoverage(plan, CONTRACT)).not.toThrow();
  });

  it("legacy acceptanceCriteria alias alone does not satisfy coverage", () => {
    const plan = literalPlan([
      {
        id: "alias-only",
        description: "Alias-only refs",
        targetFiles: [],
        role: "worker",
        criterionIds: [],
        acceptanceCriteria: ["criterion-a", "criterion-b", "criterion-c"],
      },
    ]);
    expect(uncoveredCriteria(plan, CONTRACT)).toEqual(
      expect.arrayContaining(["criterion-a", "criterion-b", "criterion-c"]),
    );
    expect(() => assertPlanCoverage(plan, CONTRACT)).toThrow(PlanCoverageError);
  });
});
