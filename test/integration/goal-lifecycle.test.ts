// Integration test: goal lifecycle end-to-end
// Tests: create → event dispatch → state transitions → continuation → persistence

import { describe, it, expect, beforeEach, onTestFinished } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalRecord, GoalId, RevisionRef, WorkspaceIdentity, MutationLease } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore, InvalidTransitionError, IgnoredEventError } from "../../src/store/goal-store.js";
import { TerminalStateError } from "../../src/runtime/lifecycle.js";
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
import { acquireLease, releaseLease, checkLease } from "../../src/execution/mutation-lease.js";

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
    expect(store.get(id)).toBeNull();
  });

  it("returns false when deleting nonexistent goal", () => {
    const id = makeGoalId();
    expect(store.delete(id)).toBe(false);
  });

  it("update rejects wrong-source event with typed IgnoredEventError (no write, no bump)", () => {
    const id = makeGoalId();
    store.create(id, createGoalRecord(id, "task", WORKSPACE, REVISION));

    // CREATED → EXECUTING is invalid; the source-guarded reducer returns base
    // unchanged, so the store throws IgnoredEventError instead of persisting
    // a fake transition.
    expect(() =>
      store.update(id, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0 }),
    ).toThrowError(IgnoredEventError);
    expect(store.get(id)!.state).toBe("CREATED");
    expect(store.get(id)!.recordVersion).toBe(1);
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

  it("rejects events from terminal states with typed TerminalStateError", () => {
    const record = createGoalRecord(goalId, "task", WORKSPACE, REVISION);
    startGoal(store, goalId, record, log);
    completePreparation(store, goalId, log);
    happyPathToEnd(store, goalId, log);

    expect(store.get(goalId)!.state).toBe("DONE");
    const versionBefore = store.get(goalId)!.recordVersion;

    // DONE admits no transitions: typed rejection, no write, no version bump.
    expect(() => dispatchEvent(store, goalId, { type: "GoalStarted" }, log)).toThrowError(
      TerminalStateError,
    );
    expect(store.get(goalId)!.state).toBe("DONE");
    expect(store.get(goalId)!.recordVersion).toBe(versionBefore);
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
    expect(ks.goal.get(id)).toBeNull();
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

    // ReconciliationCompleted only applies in RECONCILING: drive preparation
    // there first (a no-op dispatch would now throw IgnoredEventError).
    ks.dispatchEvent(id, { type: "PreparationProgress", job: "baseline", planEpoch: 0, attemptId: "att-1", basedOnRevision: REVISION, status: "SUCCEEDED", driverFence: 0, artifactRef: ARTIFACT });
    ks.dispatchEvent(id, { type: "PreparationProgress", job: "plan", planEpoch: 0, attemptId: "att-2", basedOnRevision: REVISION, status: "SUCCEEDED", driverFence: 0, artifactRef: ARTIFACT });
    ks.dispatchEvent(id, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    });

    expect(ks.receiptLog.length).toBe(4);
    expect(ks.receiptLog[ks.receiptLog.length - 1].eventType).toBe("ReconciliationCompleted");
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

  it("hooks.session_start repairs an expired lease and clears recoveryRequired so continuation resumes", async () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });
    const { acquireDriverLeasePersisted } = await import("../../src/runtime/driver.js");
    acquireDriverLeasePersisted(ks.store, id, "session-old", { ttlMs: 0 });
    // Force expiry in the past through a persisted heartbeat-free write.
    const rec = ks.store.get(id)!;
    ks.store.update(id, {
      type: "DriverLeaseAcquired",
      lease: { ...rec.activeDriverLease!, expiresAt: "2000-01-01T00:00:00.000Z" as never },
      fenceCounter: rec.driverFenceCounter,
    });
    ks.hooks.session_start();
    const after = ks.store.get(id)!;
    expect(after.activeDriverLease).toBeUndefined();
    expect(after.recoveryRequired).toBe(false);
    expect(ks.hooks.session_before_compact(id)!.canContinue).toBe(true);
  });

  it("hooks.session_start keeps PAUSED stable until explicit release", () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });
    ks.dispatchEvent(id, { type: "PauseRequested", reason: "break" });
    expect(ks.store.get(id)!.state).toBe("PAUSED");
    const receiptsBefore = ks.receiptLog.length;
    ks.hooks.session_start();
    expect(ks.store.get(id)!.state).toBe("PAUSED");
    expect(ks.receiptLog.length).toBe(receiptsBefore);
  });

  it("hooks.session_start repairs a stale PAUSED driver lease but does not resume", async () => {
    const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "task", workspace: WORKSPACE, startRevision: REVISION });
    const { acquireDriverLeasePersisted } = await import("../../src/runtime/driver.js");
    const leased = acquireDriverLeasePersisted(ks.store, id, "session-old");
    const fence = leased.activeDriverLease!.fencingToken;
    ks.dispatchEvent(id, { type: "PauseRequested", reason: "break", driverFence: fence });
    expect(ks.store.get(id)!.state).toBe("PAUSED");
    const rec = ks.store.get(id)!;
    ks.store.update(id, {
      type: "DriverLeaseAcquired",
      lease: { ...rec.activeDriverLease!, expiresAt: "2000-01-01T00:00:00.000Z" as never },
      fenceCounter: rec.driverFenceCounter,
    });
    const receiptsBefore = ks.receiptLog.length;
    ks.hooks.session_start();
    expect(ks.store.get(id)!.state).toBe("PAUSED");
    expect(ks.store.get(id)!.activeDriverLease).toBeUndefined();
    // Driver-lease repair + clear-recovery only. Resume is user-authorized.
    expect(ks.receiptLog.length).toBe(receiptsBefore + 2);
    expect(ks.receiptLog.slice(-2).map((r) => r.eventType)).toEqual([
      "Recovery:driver-lease",
      "Recovery:clear-recovery",
    ]);
  });

  it("runtime cancellation keeps the durable mirror when disk lease identity conflicts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "keystone-cancel-conflict-"));
    onTestFinished(() => {
      rmSync(workspace, { recursive: true, force: true });
    });
    let diskLeaseId = "unknown";
    onTestFinished(() => {
      try { releaseLease(workspace, diskLeaseId); } catch {}
    });
    try {
      const ks = createKeystone({ dataDir: dir });
    const id = makeGoalId();
    const assignmentId = "cancel-conflict-assignment" as import("../../src/domain/types.js").AssignmentId;
    const workspaceIdentity: WorkspaceIdentity = {
      requestedRoot: workspace,
      canonicalRoot: workspace,
      projectKey: "cancel-conflict",
      vcs: "none",
    };
    ks.goal.create({ goalId: id, userTask: "task", workspace: workspaceIdentity, startRevision: REVISION });
    // Establish legitimate mutation authority context before injecting the
    // conflicting disk/mirror identities. MutationLeaseAttached is intentionally
    // rejected outside EXECUTING/REPAIRING.
    completePreparation(ks.store, id, ks.receiptLog);
    ks.dispatchEvent(id, {
      type: "ReconciliationCompleted",
      reportRef: ARTIFACT,
      planEpoch: 0,
      provisionalPlanRef: ARTIFACT,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    });
    ks.dispatchEvent(id, { type: "ContractFrozen", contractVersion: 1, contractRef: ARTIFACT });
    const { acquireDriverLeasePersisted } = await import("../../src/runtime/driver.js");
    const leased = acquireDriverLeasePersisted(ks.store, id, "cancel-session");
    const driverFence = leased.activeDriverLease!.fencingToken;
    ks.dispatchEvent(id, {
      type: "ExecutionStarted",
      contractVersion: 1,
      executionPlanRef: ARTIFACT,
      driverFence,
      assignments: [{ id: assignmentId, dependsOn: [] }],
    });
    const disk = acquireLease({
      goalId: String(id),
      assignmentId,
      sessionId: "cancel-session",
      root: workspace,
      writeSet: ["owned.txt"],
      baseDirtySignature: "",
    });
    expect(disk.acquired).toBe(true);
    if (!disk.acquired) throw new Error(disk.reason);
    diskLeaseId = disk.lease.leaseId;
    const mirror = { ...disk.lease, leaseId: "different-mirror-lease" };
    ks.dispatchEvent(id, { type: "MutationLeaseAttached", lease: mirror, driverFence });

    const outcome = await ks.cancelGoal(id, "stop");
    const after = ks.store.get(id)!;
    expect(outcome).toEqual({ state: "CANCELLING", outcome: "INDETERMINATE" });
    expect(after.state).toBe("CANCELLING");
    expect(after.recoveryRequired).toBe(true);
    expect(after.activeMutationLease?.leaseId).toBe("different-mirror-lease");
    const stillOnDisk = checkLease(workspace);
    expect(stillOnDisk && !("conflict" in stillOnDisk) ? stillOnDisk.leaseId : null).toBe(disk.lease.leaseId);
    } finally {
      try { releaseLease(workspace, diskLeaseId); } catch {}
    }
  });
});
