import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalRecord, GoalId, ArtifactRef, ISO8601 } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import {
  handleCompaction,
  checkpointGoal,
  restartGoal,
  type CompactionSummary,
  type GoalCheckpoint,
} from "../../src/context/compaction.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
let store: GoalStore;

function fakeWorkspace() {
  return {
    requestedRoot: "/tmp/test",
    canonicalRoot: "/tmp/test",
    projectKey: "abc123" as any,
    vcs: "git" as const,
  };
}

function fakeRevision() {
  return {
    snapshotId: "snap1" as any,
    observedAt: new Date().toISOString() as ISO8601,
    gitHead: "abc",
    branch: "main",
    graphRevision: 1,
    dirtySignature: "sig",
    capabilityDigest: "cap",
  };
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const base = createGoalRecord(
    "goal-1" as GoalId,
    "test task",
    fakeWorkspace(),
    fakeRevision(),
  );
  return { ...base, ...overrides };
}

function makeSummary(goal: GoalRecord): CompactionSummary {
  return {
    goalId: goal.goalId,
    state: goal.state,
    planEpoch: goal.planEpoch,
    reviewCycles: goal.reviewCycles,
    repairCycles: goal.repairCycles,
    snapshotRefs: [...goal.snapshotRefs],
    capturedAt: new Date().toISOString() as ISO8601,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = join(tmpdir(), `keystone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = new GoalStore(tmpDir);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("handleCompaction", () => {
  it("returns goal record when found", () => {
    const goal = makeGoal({ state: "EXECUTING" });
    store.create("goal-1" as GoalId, goal);
    const summary = makeSummary(goal);

    const result = handleCompaction(summary, store);
    expect(result).toBeDefined();
    expect(result!.goalId).toEqual("goal-1");
    expect(result!.state).toEqual("EXECUTING");
  });

  it("returns undefined when goal not in store", () => {
    const summary: CompactionSummary = {
      goalId: "missing-goal" as GoalId,
      state: "CREATED",
      planEpoch: 0,
      reviewCycles: 0,
      repairCycles: 0,
      snapshotRefs: [],
      capturedAt: new Date().toISOString() as ISO8601,
    };

    const result = handleCompaction(summary, store);
    expect(result).toBeUndefined();
  });

  it("preserves artifact refs through compaction", () => {
    const goal = makeGoal({
      state: "VERIFYING",
      activeContractRef: "contract-v3" as ArtifactRef,
      baselineRef: "baseline-abc" as ArtifactRef,
      findingLedgerRef: "findings-xyz" as ArtifactRef,
    });
    store.create("goal-1" as GoalId, goal);
    const summary = makeSummary(goal);

    const result = handleCompaction(summary, store);
    expect(result).toBeDefined();
    expect(result!.activeContractRef).toEqual("contract-v3");
    expect(result!.baselineRef).toEqual("baseline-abc");
    expect(result!.findingLedgerRef).toEqual("findings-xyz");
  });

  it("preserves snapshot refs through compaction", () => {
    const goal = makeGoal({
      snapshotRefs: ["snap-a" as any, "snap-b" as any, "snap-c" as any],
    });
    store.create("goal-1" as GoalId, goal);
    const summary = makeSummary(goal);

    const result = handleCompaction(summary, store);
    expect(result).toBeDefined();
    expect(result!.snapshotRefs).toEqual(["snap-a", "snap-b", "snap-c"]);
  });
});

describe("checkpointGoal", () => {
  it("creates checkpoint from store", () => {
    const goal = makeGoal({ state: "EXECUTING", planEpoch: 3 });
    store.create("goal-1" as GoalId, goal);

    const checkpoint = checkpointGoal("goal-1" as GoalId, store);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.goalId).toEqual("goal-1");
    expect(checkpoint!.record.state).toEqual("EXECUTING");
    expect(checkpoint!.record.planEpoch).toEqual(3);
    expect(checkpoint!.summary.state).toEqual("EXECUTING");
    expect(checkpoint!.summary.planEpoch).toEqual(3);
    expect(checkpoint!.checkpointedAt).toBeDefined();
  });

  it("returns undefined for missing goal", () => {
    const checkpoint = checkpointGoal("missing" as GoalId, store);
    expect(checkpoint).toBeUndefined();
  });

  it("checkpoint record is a deep clone", () => {
    const goal = makeGoal({ state: "VERIFYING" });
    store.create("goal-1" as GoalId, goal);

    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;
    // Mutate original — checkpoint should be unaffected
    goal.state = "DONE";
    goal.planEpoch = 999;

    expect(checkpoint.record.state).toEqual("VERIFYING");
    expect(checkpoint.record.planEpoch).toEqual(0);
  });

  it("summary captures snapshot refs", () => {
    const goal = makeGoal({
      snapshotRefs: ["snap-x" as any, "snap-y" as any],
    });
    store.create("goal-1" as GoalId, goal);

    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;
    expect(checkpoint.summary.snapshotRefs).toEqual(["snap-x", "snap-y"]);
  });
});

describe("restartGoal", () => {
  it("returns restart context from checkpoint + store", () => {
    const goal = makeGoal({ state: "EXECUTING", planEpoch: 5 });
    store.create("goal-1" as GoalId, goal);
    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

    const ctx = restartGoal(checkpoint, store);
    expect(ctx).toBeDefined();
    expect(ctx!.goal.goalId).toEqual("goal-1");
    expect(ctx!.state).toEqual("EXECUTING");
    expect(ctx!.planEpoch).toEqual(5);
    expect(ctx!.canContinue).toEqual(true);
    expect(ctx!.recoveredFrom).toEqual("checkpoint");
  });

  it("canContinue false for terminal states", () => {
    const goal = makeGoal({ state: "DONE" });
    store.create("goal-1" as GoalId, goal);
    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

    const ctx = restartGoal(checkpoint, store);
    expect(ctx).toBeDefined();
    expect(ctx!.canContinue).toEqual(false);
  });

  it("canContinue false for BLOCKED", () => {
    const goal = makeGoal({ state: "BLOCKED" });
    store.create("goal-1" as GoalId, goal);
    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

    const ctx = restartGoal(checkpoint, store);
    expect(ctx!.canContinue).toEqual(false);
  });

  it("canContinue true for all resumable states", () => {
    const resumableStates = [
      "CREATED", "PREPARING", "RECONCILING", "CONTRACT_REVIEW", "READY",
      "EXECUTING", "VERIFYING", "REVIEWING", "ADJUDICATING", "REPAIRING",
      "FINAL_AUDIT", "COMPLETION_GATE",
    ];

    for (const state of resumableStates) {
      const goal = makeGoal({ state: state as GoalRecord["state"] });
      store.create("goal-1" as GoalId, goal);
      const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;
      const ctx = restartGoal(checkpoint, store);
      expect(ctx!.canContinue).toEqual(true);
      // cleanup for next iteration
      store.delete("goal-1" as GoalId);
    }
  });
});

describe("3 compactions + restart preserve state", () => {
  it("survives multiple checkpoint-restart cycles", () => {
    let goal = makeGoal({ state: "PREPARING", planEpoch: 1 });
    store.create("goal-1" as GoalId, goal);

    // Simulate 3 compaction cycles: checkpoint, mutate store, restart
    for (let i = 0; i < 3; i++) {
      const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

      // Simulate state progression
      goal = store.get("goal-1" as GoalId)!;
      goal.state = (["RECONCILING", "CONTRACT_REVIEW", "EXECUTING"] as const)[i];
      goal.planEpoch = i + 1;
      goal.reviewCycles = i;
      goal.snapshotRefs = [...goal.snapshotRefs, `snap-cycle-${i}` as any];
      // Write back: create is no-clobber, so delete first.
      store.delete("goal-1" as GoalId);
      store.create("goal-1" as GoalId, goal);

      // Restart from checkpoint
      const ctx = restartGoal(checkpoint, store)!;
      expect(ctx).toBeDefined();
      expect(ctx.recoveredFrom).toEqual("checkpoint");
      expect(ctx.goal.goalId).toEqual("goal-1");
      // canContinue should be true throughout
      expect(ctx.canContinue).toEqual(true);
    }

    // Final state verification
    const finalGoal = store.get("goal-1" as GoalId)!;
    expect(finalGoal.state).toEqual("EXECUTING");
    expect(finalGoal.planEpoch).toEqual(3);
    expect(finalGoal.reviewCycles).toEqual(2);
    expect(finalGoal.snapshotRefs).toEqual(["snap-cycle-0", "snap-cycle-1", "snap-cycle-2"]);
  });

  it("handles checkpoint when store record advanced beyond checkpoint", () => {
    let goal = makeGoal({ state: "RECONCILING" });
    store.create("goal-1" as GoalId, goal);

    // Checkpoint at RECONCILING
    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

    // Store advances to EXECUTING
    goal = store.get("goal-1" as GoalId)!;
    goal.state = "EXECUTING";
    goal.planEpoch = 5;
    store.delete("goal-1" as GoalId);
    store.create("goal-1" as GoalId, goal);

    // Restart uses live store (advanced state)
    const ctx = restartGoal(checkpoint, store)!;
    expect(ctx.state).toEqual("EXECUTING");
    expect(ctx.planEpoch).toEqual(5);
  });

  it("restart falls back to checkpoint when store empty", () => {
    const goal = makeGoal({ state: "READY", planEpoch: 2 });
    store.create("goal-1" as GoalId, goal);
    const checkpoint = checkpointGoal("goal-1" as GoalId, store)!;

    // Remove from store
    store.delete("goal-1" as GoalId);

    // Restart falls back to checkpoint record
    const ctx = restartGoal(checkpoint, store)!;
    expect(ctx.goal.state).toEqual("READY");
    expect(ctx.planEpoch).toEqual(2);
    expect(ctx.canContinue).toEqual(true);
  });
});
