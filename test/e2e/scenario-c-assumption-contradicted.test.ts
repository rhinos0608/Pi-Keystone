// E2E Scenario C: Assumption contradicted — reconciliation forces replan.
// Baseline results contradict the provisional plan's assumptions.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { dispatchEvent, startGoal, type ReceiptLog } from "../../src/runtime/lifecycle.js";
import { reconcile } from "../../src/planning/reconciliation.js";
import type {
  BaselineResults,
  ProvisionalPlan,
  ContradictionRecord,
} from "../../src/planning/reconciliation.js";
import { formatProgress } from "../../src/ui/progress.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/e2e-replan",
  canonicalRoot: "/tmp/e2e-replan",
  projectKey: "e2e-replan",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-c1" as any,
  observedAt: new Date().toISOString() as any,
  gitHead: "ghi789",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "dirty",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-e2c" as any;

// ─── Scenario C: Assumption Contradicted ────────────────────────────────────

describe("Scenario C: Assumption contradicted — reconciliation forces replan", () => {
  let dir: string;
  let store: GoalStore;
  let log: ReceiptLog;
  let goalId: GoalId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-e2e-c-"));
    store = new GoalStore(dir);
    log = [];
    goalId = `goal-e2c-${Date.now()}` as GoalId;
  });

  it("diagnostics mismatch triggers replan", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "check-types",
          filePaths: ["src/types.ts"],
          status: "failed",
          diagnostics: ["Type 'string' is not assignable to type 'number'"],
        },
      ],
      verificationPassed: true,
    };

    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-types",
          targetFiles: ["src/types.ts"],
          basedOnTask: "check-types",
          diagnostics: ["Cannot find module 'xyz'"], // Different from baseline
        },
      ],
    };

    const result = reconcile(baseline, plan, new Set(), 0);

    expect(result.decision).toBe("replan");
    expect(result.findings.some((f) => f.kind === "failure_alters_problem")).toBe(true);
    expect(result.epochDelta).toBeUndefined(); // warning-level, not critical
  });

  it("critical contradictions increment epoch", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "test-a",
          filePaths: ["a.ts"],
          status: "succeeded",
        },
      ],
      verificationPassed: true,
    };

    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-a",
          targetFiles: ["a.ts"],
          basedOnTask: "test-a", // References a succeeded task
        },
      ],
    };

    const result = reconcile(baseline, plan, new Set(), 0);

    expect(result.decision).toBe("replan");
    expect(result.epochDelta).toBe(1); // Critical → bumps epoch
  });

  it("repeated contradictions escalate to block", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "test-a",
          filePaths: ["a.ts"],
          status: "succeeded",
        },
      ],
      verificationPassed: true,
    };

    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-a",
          targetFiles: ["a.ts"],
          basedOnTask: "test-a",
        },
      ],
    };

    // Build prior history with 2 prior contradictions of the same kind
    const history: ContradictionRecord[] = [
      { kind: "task_failure_already_passes", count: 2 },
    ];

    const result = reconcile(baseline, plan, new Set(), 0, history);

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("exceeding threshold");
  });

  it("dirty target files trigger warning", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "test-x",
          filePaths: ["src/dirty.ts"],
          status: "failed",
          diagnostics: ["error in dirty.ts"],
        },
      ],
      verificationPassed: true,
    };

    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-x",
          targetFiles: ["src/dirty.ts"],
          basedOnTask: "test-x",
        },
      ],
    };

    const dirtyFiles = new Set(["src/dirty.ts"]);
    const result = reconcile(baseline, plan, dirtyFiles, 0);

    expect(result.decision).toBe("accept");
    expect(result.findings.some((f) => f.kind === "target_files_dirty")).toBe(true);
  });

  it("full lifecycle: replan triggers CONTRACT_REVIEW then accept on retry", () => {
    const record = createGoalRecord(goalId, "refactor API", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);

    // Complete preparation
    dispatchEvent(store, goalId, {
      type: "PreparationProgress",
      job: "baseline",
      planEpoch: 0,
      attemptId: "att-1",
      basedOnRevision: REVISION,
      status: "SUCCEEDED",
      driverFence: 0,
      artifactRef: ARTIFACT,
    }, log);
    dispatchEvent(store, goalId, {
      type: "PreparationProgress",
      job: "plan",
      planEpoch: 0,
      attemptId: "att-2",
      basedOnRevision: REVISION,
      status: "SUCCEEDED",
      driverFence: 0,
      artifactRef: ARTIFACT,
    }, log);
    expect(store.get(goalId)!.state).toBe("RECONCILING");

    // Progress shows reconciling
    const progress = formatProgress(store.get(goalId)!);
    expect(progress.message).toBe("Baseline reconciled");

    // Reconciliation detects contradiction and decides to replan
    // Per reducer: REPLAN → CONTRACT_REVIEW (same as ACCEPT_PLAN_BASIS)
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "REPLAN",
    }, log);

    expect(store.get(goalId)!.state).toBe("CONTRACT_REVIEW");

    // From CONTRACT_REVIEW, contract is frozen (orchestrator re-runs critique)
    dispatchEvent(store, goalId, {
      type: "ContractFrozen",
      contractVersion: 1,
      contractRef: ARTIFACT,
    }, log);
    expect(store.get(goalId)!.state).toBe("READY");

    // Execution proceeds normally
    dispatchEvent(store, goalId, {
      type: "ExecutionStarted",
      contractVersion: 1,
      executionPlanRef: ARTIFACT,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("EXECUTING");
  });
});
