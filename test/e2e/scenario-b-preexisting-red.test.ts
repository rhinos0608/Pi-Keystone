// E2E Scenario B: Pre-existing failures distinguished from regressions.
// Baseline shows existing failures; execution must not blame them on new changes.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { dispatchEvent, startGoal, type ReceiptLog } from "../../src/runtime/lifecycle.js";
import { reconcile } from "../../src/planning/reconciliation.js";
import type { BaselineResults, ProvisionalPlan } from "../../src/planning/reconciliation.js";
import { formatCompletion } from "../../src/ui/completion-report.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/e2e-red",
  canonicalRoot: "/tmp/e2e-red",
  projectKey: "e2e-red",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-b1" as any,
  observedAt: new Date().toISOString() as any,
  gitHead: "def456",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "dirty",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-e2b" as any;

// ─── Scenario B: Pre-existing Red ───────────────────────────────────────────

describe("Scenario B: Pre-existing failures", () => {
  let dir: string;
  let store: GoalStore;
  let log: ReceiptLog;
  let goalId: GoalId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-e2e-b-"));
    store = new GoalStore(dir);
    log = [];
    goalId = `goal-e2b-${Date.now()}` as GoalId;
  });

  it("distinguishes pre-existing test failure from regression via reconciliation", () => {
    // 1. Create and start goal
    const record = createGoalRecord(goalId, "fix login bug", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);

    // 2. Baseline: pre-existing failure in src/legacy.ts
    //    (task failed but overall verification passed — pre-existing, not blocking)
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "unit-tests",
          filePaths: ["src/legacy.ts", "src/legacy.test.ts"],
          status: "failed",
          diagnostics: ["legacy.test.ts:42 — assertion mismatch"],
        },
      ],
      verificationPassed: true,
    };

    // 3. Plan that only touches new files, not the failing legacy files
    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-login",
          targetFiles: ["src/auth.ts", "src/auth.test.ts"],
          diagnostics: ["login token expiry"],
        },
      ],
    };

    // 4. Reconcile: plan doesn't address legacy failure, but targets different files
    const result = reconcile(baseline, plan, new Set(), 0);

    // Pre-existing failure is in a different file set than the plan targets.
    // No task_failure contradiction, but outside_cone_failure detected.
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].kind).toBe("outside_cone_failure");
    expect(result.decision).toBe("replan");
  });

  it("plan that targets pre-existing failure files triggers contradiction", () => {
    const baseline: BaselineResults = {
      tasks: [
        {
          taskName: "unit-tests",
          filePaths: ["src/legacy.ts"],
          status: "succeeded",
        },
      ],
      verificationPassed: true,
    };

    // Plan claims to fix a failing task that actually passed
    const plan: ProvisionalPlan = {
      actions: [
        {
          actionName: "fix-legacy",
          targetFiles: ["src/legacy.ts"],
          basedOnTask: "unit-tests", // references unit-tests which succeeded
          diagnostics: ["legacy broken"],
        },
      ],
    };

    const result = reconcile(baseline, plan, new Set(), 0);

    expect(result.decision).toBe("replan");
    expect(result.findings.some((f) => f.kind === "task_failure_already_passes")).toBe(true);
  });

  it("BLOCKED goal shows actionable explanation", () => {
    // Move goal to BLOCKED state via fatal error flow
    const record = createGoalRecord(goalId, "fix login", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);

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

    // Reconciliation blocks
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "BLOCK",
    }, log);

    expect(store.get(goalId)!.state).toBe("BLOCKED");

    const report = formatCompletion(store.get(goalId)!);
    expect(report.status).toBe("BLOCKED");
    expect(report.summary).toContain("Manual intervention");
  });
});
