import { describe, it, expect } from "vitest";
import {
  reconcile,
  nextEpochAfterReconcile,
  type BaselineResults,
  type ProvisionalPlan,
  type ContradictionRecord,
} from "../../src/planning/reconciliation.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function cleanBaseline(): BaselineResults {
  return {
    tasks: [
      { taskName: "task-a", filePaths: ["src/a.ts"], status: "succeeded" },
      { taskName: "task-b", filePaths: ["src/b.ts"], status: "succeeded" },
    ],
    verificationPassed: true,
  };
}

function cleanPlan(): ProvisionalPlan {
  return {
    actions: [
      { actionName: "act-1", targetFiles: ["src/new.ts"] },
    ],
  };
}

const EMPTY_DIRTY = new Set<string>();

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("reconcile", () => {
  it("accepts when no contradictions detected", () => {
    const result = reconcile(cleanBaseline(), cleanPlan(), EMPTY_DIRTY, 0);
    expect(result.decision).toBe("accept");
    expect(result.findings).toHaveLength(0);
    expect(result.epochDelta).toBeUndefined();
  });

  it("records dirty target files without treating them as a planning contradiction", () => {
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix-a", targetFiles: ["src/dirty.ts"] },
      ],
    };
    const dirtyFiles = new Set(["src/dirty.ts"]);
    const result = reconcile(cleanBaseline(), plan, dirtyFiles, 0);
    expect(result.decision).toBe("accept");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("target_files_dirty");
    expect(result.findings[0].detail).toContain("src/dirty.ts");
  });

  it("returns block when verification is broken and unaddressed", () => {
    const baseline: BaselineResults = {
      tasks: [],
      verificationPassed: false,
      verificationDiagnostics: ["test suite failed"],
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "refactor-x", targetFiles: ["src/x.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    expect(result.decision).toBe("replan"); // first time is replan
    expect(result.findings[0].kind).toBe("verification_broken");
    expect(result.findings[0].severity).toBe("critical");
  });

  it("increments epochDelta on critical findings", () => {
    const baseline: BaselineResults = {
      tasks: [{ taskName: "t1", filePaths: ["f.ts"], status: "succeeded" }],
      verificationPassed: false,
    };
    // Plan assumes t1 failed — contradiction
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix", targetFiles: ["f.ts"], basedOnTask: "t1" },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 2);
    expect(result.decision).toBe("replan");
    expect(result.epochDelta).toBe(1);
    expect(result.findings[0].kind).toBe("task_failure_already_passes");
    expect(result.findings[0].severity).toBe("critical");
  });

  it("escalates repeated contradictions to block", () => {
    const baseline: BaselineResults = {
      tasks: [{ taskName: "t1", filePaths: ["f.ts"], status: "succeeded" }],
      verificationPassed: false,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix", targetFiles: ["f.ts"], basedOnTask: "t1" },
      ],
    };
    // Two prior rounds already hit this contradiction
    const history: ContradictionRecord[] = [
      { kind: "task_failure_already_passes", count: 2 },
      { kind: "verification_broken", count: 1 },
    ];
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 5, history);
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("3 times");
    expect(result.epochDelta).toBe(1);
  });

  it("does not escalate repeated dirty-target observations into a contradiction block", () => {
    const baseline: BaselineResults = {
      tasks: [],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "noop", targetFiles: ["src/clean.ts"] },
      ],
    };
    const dirtyFiles = new Set(["src/clean.ts"]);
    const history: ContradictionRecord[] = [
      { kind: "target_files_dirty", count: 2 },
    ];
    const result = reconcile(baseline, plan, dirtyFiles, 1, history);
    expect(result.decision).toBe("accept");
  });

  it("detects diagnostics contradict ownership", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "lint",
          filePaths: ["src/a.ts"],
          status: "failed",
          diagnostics: ["lint error in a.ts"],
        },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [{ actionName: "fix-lint", targetFiles: ["src/a.ts"] }],
      ownershipMap: { "src/b.ts": "lint" },
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    expect(result.decision).toBe("replan");
    const ownershipFinding = result.findings.find(
      (f) => f.kind === "diagnostics_contradict_ownership",
    );
    expect(ownershipFinding).toBeDefined();
    expect(ownershipFinding!.detail).toContain("src/b.ts");
  });

  it("detects failure alters problem", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "compile",
          filePaths: ["src/x.ts"],
          status: "failed",
          diagnostics: ["TS2345: argument mismatch"],
        },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-compile",
          targetFiles: ["src/x.ts"],
          basedOnTask: "compile",
          diagnostics: ["TS7006: parameter implicitly has 'any' type"],
        },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    expect(result.decision).toBe("replan");
    expect(result.findings[0].kind).toBe("failure_alters_problem");
    expect(result.findings[0].severity).toBe("warning");
  });

  // ─── New contradiction kinds ───────────────────────────────────────────

  it("detects partial_implementation", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "lint-fix",
          filePaths: ["src/a.ts", "src/b.ts"],
          status: "succeeded",
          diagnostics: ["some warning in a.ts"],
        },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix-lint", targetFiles: ["src/a.ts"], basedOnTask: "lint-fix" },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "partial_implementation");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.evidenceRefs).toContain("lint-fix");
  });

  it("detects outside_cone_failure", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "compile",
          filePaths: ["src/known.ts", "src/unknown.ts"],
          status: "failed",
        },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix-compile", targetFiles: ["src/known.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "outside_cone_failure");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.evidenceRefs).toContain("src/unknown.ts");
    expect(f!.detail).toContain("src/unknown.ts");
  });

  it("detects capability_gap", () => {
    const baseline = cleanBaseline();
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "bash:build-test", targetFiles: ["src/c.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "capability_gap");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.detail).toContain("bash:build-test");
  });

  it("detects capability_gap for mcp:", () => {
    const baseline = cleanBaseline();
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "mcp:fetch-data", targetFiles: ["src/d.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "capability_gap");
    expect(f).toBeDefined();
  });

  it("detects ownership_false", () => {
    const baseline: BaselineResults = {
      tasks: [
        { taskName: "lint", filePaths: ["src/a.ts"], status: "succeeded" },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [{ actionName: "noop", targetFiles: [] }],
      ownershipMap: { "src/a.ts": "lint" },
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "ownership_false");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
    expect(f!.evidenceRefs).toContain("lint");
    expect(f!.evidenceRefs).toContain("src/a.ts");
  });

  it("includes evidenceRefs on existing findings", () => {
    const baseline: BaselineResults = {
      tasks: [{ taskName: "t1", filePaths: ["f.ts"], status: "succeeded" }],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix", targetFiles: ["f.ts"], basedOnTask: "t1" },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    expect(result.findings[0].evidenceRefs).toBeDefined();
    expect(result.findings[0].evidenceRefs).toContain("t1");
  });

  it("does not detect outside_cone_failure when all failed files are in cone", () => {
    const baseline: BaselineResults = {
      tasks: [
        { taskName: "compile", filePaths: ["src/a.ts"], status: "failed" },
      ],
      verificationPassed: true,
    };
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix", targetFiles: ["src/a.ts", "src/b.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "outside_cone_failure");
    expect(f).toBeUndefined();
  });

  it("does not detect capability_gap for normal action names", () => {
    const baseline = cleanBaseline();
    const plan: ProvisionalPlan = {
      actions: [
        { actionName: "fix-lint-warnings", targetFiles: ["src/x.ts"] },
      ],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 0);
    const f = result.findings.find((x) => x.kind === "capability_gap");
    expect(f).toBeUndefined();
  });
});

describe("nextEpochAfterReconcile", () => {
  it("bumps epoch by delta on replan, preserving prior epochs", () => {
    const baseline: BaselineResults = {
      tasks: [],
      verificationPassed: false,
      verificationDiagnostics: ["test suite failed"],
    };
    const plan: ProvisionalPlan = {
      actions: [{ actionName: "reformat code", targetFiles: ["src/x.ts"] }],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 2);
    expect(result.decision).toBe("replan");
    expect(nextEpochAfterReconcile(2, result)).toBe(3);
  });

  it("keeps epoch unchanged on accept (never resets to 0)", () => {
    const baseline = cleanBaseline();
    const plan: ProvisionalPlan = {
      actions: [{ actionName: "fix", targetFiles: ["src/x.ts"] }],
    };
    const result = reconcile(baseline, plan, EMPTY_DIRTY, 4);
    expect(result.decision).toBe("accept");
    expect(nextEpochAfterReconcile(4, result)).toBe(4);
  });
});
