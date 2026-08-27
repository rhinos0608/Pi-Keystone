// E2E Scenario A: Clean repo, clear requirement, tests available.
// Full lifecycle: baseline → contract → execute → verify → review → done.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalRecord, GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { dispatchEvent, startGoal, type ReceiptLog } from "../../src/runtime/lifecycle.js";
import { formatProgress } from "../../src/ui/progress.js";
import { formatCompletion } from "../../src/ui/completion-report.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/e2e-clean",
  canonicalRoot: "/tmp/e2e-clean",
  projectKey: "e2e-clean",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-a1" as any,
  observedAt: new Date().toISOString() as any,
  gitHead: "abc123",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "clean",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-e2e" as any;
const FINDING = "finding-e2e" as any;
const ASSIGNMENT = "asgn-e2e" as any;

// ─── Scenario A: Clean Feature ──────────────────────────────────────────────

describe("Scenario A: Clean Feature — full lifecycle", () => {
  let dir: string;
  let store: GoalStore;
  let log: ReceiptLog;
  let goalId: GoalId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-e2e-a-"));
    store = new GoalStore(dir);
    log = [];
    goalId = `goal-e2a-${Date.now()}` as GoalId;
  });

  it("completes full lifecycle: CREATED → PREPARING → ... → DONE", () => {
    // 1. Create goal
    const record = createGoalRecord(goalId, "add user authentication", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    expect(store.get(goalId)!.state).toBe("PREPARING");

    // 2. Progress shows preparing
    const progress0 = formatProgress(store.get(goalId)!);
    expect(progress0.phase).toBe("PREPARING");
    expect(progress0.message).toContain("Preparing");

    // 3. Preparation jobs succeed
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

    // 4. Reconciliation accepts
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    }, log);
    expect(store.get(goalId)!.state).toBe("CONTRACT_REVIEW");

    // 5. Contract frozen
    dispatchEvent(store, goalId, {
      type: "ContractFrozen",
      contractVersion: 1,
      contractRef: ARTIFACT,
    }, log);
    expect(store.get(goalId)!.state).toBe("READY");
    expect(formatProgress(store.get(goalId)!).message).toBe("Contract frozen");

    // 6. Execution starts
    dispatchEvent(store, goalId, {
      type: "ExecutionStarted",
      contractVersion: 1,
      executionPlanRef: ARTIFACT,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("EXECUTING");

    // 7. Assignment completes
    dispatchEvent(store, goalId, {
      type: "AssignmentCompleted",
      assignmentId: ASSIGNMENT,
      reportRef: ARTIFACT,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("VERIFYING");

    // 8. Verification passes
    dispatchEvent(store, goalId, {
      type: "VerificationCompleted",
      runRef: ARTIFACT,
      accepted: true,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("REVIEWING");

    // 9. Review
    dispatchEvent(store, goalId, {
      type: "ReviewCompleted",
      reviewRef: ARTIFACT,
      candidateIds: [FINDING],
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("ADJUDICATING");

    // 10. Adjudication
    dispatchEvent(store, goalId, {
      type: "AdjudicationCompleted",
      decisionRefs: [ARTIFACT],
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("FINAL_AUDIT");

    // 11. Final audit passes
    dispatchEvent(store, goalId, {
      type: "FinalAuditCompleted",
      auditRefs: [ARTIFACT, ARTIFACT],
      accepted: true,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("COMPLETION_GATE");

    // 12. Completion gate passes
    dispatchEvent(store, goalId, {
      type: "CompletionEvaluated",
      reportRef: ARTIFACT,
      accepted: true,
      driverFence: 0,
    }, log);
    expect(store.get(goalId)!.state).toBe("DONE");

    // 13. Verify terminal state
    const final = store.get(goalId)!;
    expect(final.state).toBe("DONE");
    expect(final.reviewCycles).toBe(0);
    expect(final.repairCycles).toBe(0);
    expect(final.contractVersion).toBe(1);

    // 14. Completion report
    const report = formatCompletion(final);
    expect(report.status).toBe("DONE");
    expect(report.summary).toContain("completed successfully");
    expect(report.summary).toContain("add user authentication");

    // 15. Receipt log tracks full lifecycle
    expect(log.length).toBeGreaterThan(5);
    expect(log[0].eventType).toBe("GoalStarted");
    expect(log[log.length - 1].toState).toBe("DONE");
  });
});
