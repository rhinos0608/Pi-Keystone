// Integration test: goal lifecycle end-to-end
// Tests: create → event dispatch → state transitions → continuation → persistence

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalRecord, GoalId, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import {
  dispatchEvent,
  startGoal,
  getGoalState,
  isTerminal,
  type ReceiptLog,
} from "../../src/runtime/lifecycle.js";
import {
  resumeAfterCompaction,
  buildContinuationContext,
} from "../../src/continuation.js";
import { createKeystone } from "../../src/index.js";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeGoalId(): GoalId {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as GoalId;
}

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test-project",
  canonicalRoot: "/tmp/test-project",
  projectKey: "abc123",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-001" as import("../../src/domain/types.js").SnapshotId,
  observedAt: new Date().toISOString() as import("../../src/domain/types.js").ISO8601,
  gitHead: "abc123",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "clean",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-001" as import("../../src/domain/types.js").ArtifactRef;
const FINDING = "finding-001" as import("../../src/domain/types.js").FindingId;
const ASSIGNMENT = "assign-001" as import("../../src/domain/types.js").AssignmentId;

/** Helper: advance from PREPARING → RECONCILING via successful preparation jobs */
function completePreparation(store: GoalStore, goalId: GoalId, log: ReceiptLog) {
  dispatchEvent(store, goalId, {
    type: "PreparationProgress",
    job: "baseline",
    planEpoch: 0,
    attemptId: "att-baseline-1",
    basedOnRevision: REVISION,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: ARTIFACT,
  }, log);
  dispatchEvent(store, goalId, {
    type: "PreparationProgress",
    job: "plan",
    planEpoch: 0,
    attemptId: "att-plan-1",
    basedOnRevision: REVISION,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: ARTIFACT,
  }, log);
}

/** Helper: RECONCILING → DONE. Uses consistent driverFence=0 for all events. */
function happyPathToEnd(store: GoalStore, goalId: GoalId, log: ReceiptLog) {
  dispatchEvent(store, goalId, {
    type: "ReconciliationCompleted",
    reportRef: ARTIFACT,
    planEpoch: 0,
    provisionalPlanRef: ARTIFACT,
    basedOnRevision: REVISION,
    decision: "ACCEPT_PLAN_BASIS",
  }, log);
  dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ARTIFACT }, log);
  dispatchEvent(store, goalId, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "AssignmentCompleted", assignmentId: ASSIGNMENT, reportRef: ARTIFACT, driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "VerificationCompleted", runRef: ARTIFACT, accepted: true, driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "ReviewCompleted", reviewRef: ARTIFACT, candidateIds: [FINDING], driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "AdjudicationCompleted", decisionRefs: [ARTIFACT], driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "FinalAuditCompleted", auditRefs: [ARTIFACT, ARTIFACT], accepted: true, driverFence: 0 }, log);
  dispatchEvent(store, goalId, { type: "CompletionEvaluated", reportRef: ARTIFACT, accepted: true, driverFence: 0 }, log);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GoalStore CRUD", () => {
  let dir: string;
  let store: GoalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-test-"));
    store = new GoalStore(dir);
  });

  it("creates and retrieves a goal", () => {
    const id = makeGoalId();
    const record = createGoalRecord(id, "build feature X", WORKSPACE, REVISION);
    store.create(id, record);

    const fetched = store.get(id);
    expect(fetched).toBeDefined();
    expect(fetched!.goalId).toBe(id);
    expect(fetched!.state).toBe("CREATED");
  });

  it("lists all goals", () => {
    const id1 = makeGoalId();
    const id2 = makeGoalId();
    store.create(id1, createGoalRecord(id1, "task 1", WORKSPACE, REVISION));
    store.create(id2, createGoalRecord(id2, "task 2", WORKSPACE, REVISION));

    const all = store.list();
    expect(all.length).toBe(2);
  });

  it("deletes a goal", () => {
    const id = makeGoalId();
    store.create(id, createGoalRecord(id, "task", WORKSPACE, REVISION));
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent goal", () => {
    const id = makeGoalId();
    expect(store.delete(id)).toBe(false);
  });

  it("update rejects invalid transition (reducer returns unchanged state)", () => {
    const id = makeGoalId();
    store.create(id, createGoalRecord(id, "task", WORKSPACE, REVISION));

    // CREATED → EXECUTING is invalid; reducer returns unchanged state, store skips validation
    const result = store.update(id, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0 });
    expect(result.state).toBe("CREATED");
  });
});

describe("Lifecycle event dispatch", () => {
  let dir: string;
  let store: GoalStore;
  let log: ReceiptLog;
  let goalId: GoalId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-test-"));
    store = new GoalStore(dir);
    log = [];
    goalId = makeGoalId();
  });

  it("full happy path: CREATED → PREPARING → RECONCILING → ... → DONE", () => {
    const record = createGoalRecord(goalId, "build feature", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    expect(store.get(goalId)!.state).toBe("PREPARING");

    completePreparation(store, goalId, log);
    expect(store.get(goalId)!.state).toBe("RECONCILING");

    happyPathToEnd(store, goalId, log);
    expect(store.get(goalId)!.state).toBe("DONE");

    expect(log.length).toBeGreaterThan(0);
    expect(log[0].eventType).toBe("GoalStarted");
    expect(log[log.length - 1].toState).toBe("DONE");
    expect(store.get(goalId)!.recordVersion).toBe(1 + log.length);
  });

  it("rejects events from terminal states (reducer returns unchanged state)", () => {
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    completePreparation(store, goalId, log);
    happyPathToEnd(store, goalId, log);

    expect(store.get(goalId)!.state).toBe("DONE");

    // DONE → PREPARING is invalid; reducer returns unchanged state
    const { record: updated } = dispatchEvent(store, goalId, { type: "GoalStarted" }, log);
    expect(updated.state).toBe("DONE");
  });

  it("pause and resume cycle", () => {
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    expect(store.get(goalId)!.state).toBe("PREPARING");

    // PAUSE from PREPARING (valid per transition table)
    dispatchEvent(store, goalId, { type: "PauseRequested", reason: "user break" }, log);
    expect(store.get(goalId)!.state).toBe("PAUSED");
    expect(store.get(goalId)!.pauseReason).toBe("user break");

    // RESUME goes to RECONCILING (only valid forward transition from PAUSED)
    dispatchEvent(store, goalId, { type: "ResumeRequested" }, log);
    expect(store.get(goalId)!.state).toBe("RECONCILING");
  });

  it("cancel from any non-terminal state", () => {
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    expect(store.get(goalId)!.state).toBe("PREPARING");

    dispatchEvent(store, goalId, { type: "CancelRequested", reason: "no longer needed" }, log);
    expect(store.get(goalId)!.state).toBe("CANCELLING");

    dispatchEvent(store, goalId, { type: "CancellationSettled", cleanupRef: ARTIFACT, mutationOutcome: "SETTLED" }, log);
    expect(store.get(goalId)!.state).toBe("CANCELLED");
  });

  it("fatal error moves to FAILED", () => {
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);

    dispatchEvent(store, goalId, { type: "FatalError", errorRef: ARTIFACT }, log);
    expect(store.get(goalId)!.state).toBe("FAILED");
  });

  it("track isTerminal correctly", () => {
    expect(isTerminal({ state: "DONE" } as GoalRecord)).toBe(true);
    expect(isTerminal({ state: "FAILED" } as GoalRecord)).toBe(true);
    expect(isTerminal({ state: "CANCELLED" } as GoalRecord)).toBe(true);
    expect(isTerminal({ state: "PREPARING" } as GoalRecord)).toBe(false);
    expect(isTerminal({ state: "EXECUTING" } as GoalRecord)).toBe(false);
  });
});

describe("Continuation after compaction", () => {
  let dir: string;
  let store: GoalStore;
  let log: ReceiptLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-test-"));
    store = new GoalStore(dir);
    log = [];
  });

  it("returns continuation context for non-terminal goal", () => {
    const goalId = makeGoalId();
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);

    const ctx = resumeAfterCompaction(store, goalId);
    expect(ctx).not.toBeNull();
    expect(ctx!.canContinue).toBe(true);
    expect(ctx!.state).toBe("PREPARING");
    expect(ctx!.nextStep).toBe("run_preparation_jobs");
  });

  it("returns null for terminal goal", () => {
    const goalId = makeGoalId();
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    completePreparation(store, goalId, log);
    happyPathToEnd(store, goalId, log);

    const ctx = resumeAfterCompaction(store, goalId);
    expect(ctx).toBeNull();
  });

  it("returns null for nonexistent goal", () => {
    const ctx = resumeAfterCompaction(store, "nonexistent" as GoalId);
    expect(ctx).toBeNull();
  });

  it("maps all states to correct next steps", () => {
    const goalId = makeGoalId();
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    store.create(goalId, record);

    const states = [
      ["CREATED", "dispatch_goal_started"],
      ["PREPARING", "run_preparation_jobs"],
      ["RECONCILING", "run_reconciliation"],
      ["CONTRACT_REVIEW", "run_contract_critique"],
      ["READY", "start_execution"],
      ["EXECUTING", "dispatch_next_assignment"],
      ["VERIFYING", "run_verification"],
      ["REVIEWING", "run_review"],
      ["ADJUDICATING", "run_adjudication"],
      ["REPAIRING", "dispatch_repair_assignment"],
      ["FINAL_AUDIT", "run_final_audit"],
      ["COMPLETION_GATE", "evaluate_completion"],
      ["DONE", "no_action"],
      ["FAILED", "no_action"],
    ] as const;

    for (const [state, expected] of states) {
      const raw = { ...record, state, recoveryRequired: false } as GoalRecord;
      writeFileSync(join(store["dir"], `${goalId}.json`), JSON.stringify(raw));

      const ctx = buildContinuationContext(store, goalId);
      expect(ctx!.nextStep).toBe(expected);
    }
  });
});

describe("Keystone extension (index.ts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-test-"));
  });

  it("createKeystone returns goal, hooks, store", () => {
    const ks = createKeystone({ dataDir: dir });
    expect(ks.goal).toBeDefined();
    expect(ks.hooks).toBeDefined();
    expect(ks.store).toBeDefined();
    expect(ks.receiptLog).toEqual([]);
  });

  it("goal command CRUD", () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();

    const created = ks.goal.create({
      goalId: id,
      userTask: "build feature",
      workspace: WORKSPACE,
      startRevision: REVISION,
    });
    expect(created.state).toBe("PREPARING");

    const fetched = ks.goal.get(id);
    expect(fetched!.goalId).toBe(id);

    const list = ks.goal.list();
    expect(list.length).toBe(1);

    expect(ks.goal.delete(id)).toBe(true);
    expect(ks.goal.get(id)).toBeUndefined();
  });

  it("hooks.session_before_compact returns continuation context", () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });

    const ctx = ks.hooks.session_before_compact(id);
    expect(ctx).not.toBeNull();
    expect(ctx!.canContinue).toBe(true);
  });

  it("receipt log is populated after dispatch", () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });

    ks.dispatchEvent(id, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    });

    expect(ks.receiptLog.length).toBe(2);
    expect(ks.receiptLog[1].eventType).toBe("ReconciliationCompleted");
  });

  it("isTerminal reflects goal state", () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });

    expect(ks.isTerminal(id)).toBe(false);

    // Move to DONE via proper state machine path
    ks.dispatchEvent(id, { type: "PreparationProgress", job: "baseline", planEpoch: 0, attemptId: "att-1", basedOnRevision: REVISION, status: "SUCCEEDED", driverFence: 0, artifactRef: ARTIFACT });
    ks.dispatchEvent(id, { type: "PreparationProgress", job: "plan", planEpoch: 0, attemptId: "att-2", basedOnRevision: REVISION, status: "SUCCEEDED", driverFence: 0, artifactRef: ARTIFACT });
    ks.dispatchEvent(id, { type: "ReconciliationCompleted", reportRef: ARTIFACT, planEpoch: 0, provisionalPlanRef: ARTIFACT, basedOnRevision: REVISION, decision: "ACCEPT_PLAN_BASIS" });
    ks.dispatchEvent(id, { type: "ContractFrozen", contractVersion: 1, contractRef: ARTIFACT });
    ks.dispatchEvent(id, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0 });
    ks.dispatchEvent(id, { type: "AssignmentCompleted", assignmentId: ASSIGNMENT, reportRef: ARTIFACT, driverFence: 0 });
    ks.dispatchEvent(id, { type: "VerificationCompleted", runRef: ARTIFACT, accepted: true, driverFence: 0 });
    ks.dispatchEvent(id, { type: "ReviewCompleted", reviewRef: ARTIFACT, candidateIds: [FINDING], driverFence: 0 });
    ks.dispatchEvent(id, { type: "AdjudicationCompleted", decisionRefs: [ARTIFACT], driverFence: 0 });
    ks.dispatchEvent(id, { type: "FinalAuditCompleted", auditRefs: [ARTIFACT, ARTIFACT], accepted: true, driverFence: 0 });
    ks.dispatchEvent(id, { type: "CompletionEvaluated", reportRef: ARTIFACT, accepted: true, driverFence: 0 });

    expect(ks.isTerminal(id)).toBe(true);
  });
});
