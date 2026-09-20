import { describe, it, afterAll } from "vitest";
import assert from "vitest";

import type {
  GoalRecord,
  MutationLease,
  DriverLease,
  GoalId,
  ISO8601,
} from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { IgnoredEventError } from "../../src/store/goal-store.js";
import type { ReceiptLog } from "../../src/runtime/lifecycle.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  settleCancellation,
  createQuarantine,
  quarantineMutation,
  evictExpiredQuarantine,
  detectRecoveryIssues,
  repairOrphanedDriverLease,
  repairStaleMutationLease,
} from "../../src/runtime/recovery.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(offsetMs = 0): ISO8601 {
  return new Date(Date.now() + offsetMs).toISOString() as ISO8601;
}

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
    observedAt: iso() as any,
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

/** Persist a goal to a throwaway GoalStore; returns the store and goal id. */
const recoveryDirs: string[] = [];
function persistGoal(record: GoalRecord): { store: GoalStore; goalId: GoalId } {
  const dir = mkdtempSync(join(tmpdir(), "keystone-recovery-"));
  recoveryDirs.push(dir);
  const store = new GoalStore(dir);
  store.create(record.goalId, record);
  return { store, goalId: record.goalId };
}

afterAll(() => {
  for (const dir of recoveryDirs) rmSync(dir, { recursive: true, force: true });
});

function makeMutationLease(
  overrides: Partial<MutationLease> = {},
): MutationLease {
  return {
    leaseId: "mut-1",
    fencingToken: 1,
    assignmentId: "asgn-1" as any,
    sessionId: "sess-1",
    workerProcessIdentity: "pid-1",
    canonicalWorkspaceRoot: "/tmp/test",
    allowedCanonicalPaths: [],
    baseDirtySignature: "sig",
    phase: "MUTATING",
    acquiredAt: iso() as any,
    heartbeatAt: iso() as any,
    expiresAt: iso(60_000) as any, // 1 min from now
    ...overrides,
  };
}

function makeDriverLease(
  overrides: Partial<DriverLease> = {},
): DriverLease {
  return {
    leaseId: "drv-1",
    sessionId: "sess-1",
    fencingToken: 1,
    acquiredAt: iso() as any,
    heartbeatAt: iso() as any,
    expiresAt: iso(60_000) as any,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("settleCancellation", () => {
  it("returns null when goal is not CANCELLING", () => {
    const goal = makeGoal({ state: "EXECUTING" });
    expect(settleCancellation(goal, iso())).toEqual(null);
  });

  it("returns SETTLED when no active mutation lease", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: undefined,
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("SETTLED");
    expect(result!.event.type).toEqual("CancellationSettled");
  });

  it("returns SETTLED when mutation is in SETTLING phase and not expired", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "SETTLING" }),
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("SETTLED");
  });

  it("returns INDETERMINATE when mutation is in MUTATING phase and not expired (no rollback proof)", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "MUTATING" }),
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("INDETERMINATE");
  });

  it("returns INDETERMINATE when mutation lease is expired", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({
        phase: "MUTATING",
        expiresAt: iso(-1_000) as any, // expired 1s ago
      }),
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("INDETERMINATE");
  });

  it("returns INDETERMINATE for ACQUIRED phase (not settled enough)", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "ACQUIRED" }),
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("INDETERMINATE");
  });

  it("returns INDETERMINATE for AUTHORITY_READY phase", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "AUTHORITY_READY" }),
    });
    const result = settleCancellation(goal, iso());
    expect(result!.outcome).toEqual("INDETERMINATE");
  });
});

describe("quarantine", () => {
  it("creates empty quarantine", () => {
    const q = createQuarantine();
    expect(q.entries).toEqual([]);
  });

  it("quarantines a mutation with expiry", () => {
    const q = createQuarantine();
    const lease = makeMutationLease();
    const now = iso();
    const entry = quarantineMutation(q, "goal-1", lease, now, 30_000);

    expect(q.entries.length).toEqual(1);
    expect(entry.goalId).toEqual("goal-1");
    expect(entry.mutationLease).toEqual(lease);

    const expectedExpiry = new Date(new Date(now).getTime() + 30_000);
    expect(new Date(entry.expiresAt)).toEqual(expectedExpiry);
  });

  it("evicts expired entries", () => {
    const q = createQuarantine();
    const now = iso();

    // Add an already-expired entry
    quarantineMutation(q, "goal-expired", makeMutationLease(), iso(-60_000), -1);
    // Add a future entry
    quarantineMutation(q, "goal-future", makeMutationLease(), now, 60_000);

    const evicted = evictExpiredQuarantine(q, iso());
    expect(evicted.length).toEqual(1);
    expect(evicted[0].goalId).toEqual("goal-expired");
    expect(q.entries.length).toEqual(1);
    expect(q.entries[0].goalId).toEqual("goal-future");
  });
});

describe("detectRecoveryIssues", () => {
  it("detects orphaned driver lease", () => {
    const goal = makeGoal({
      activeDriverLease: makeDriverLease({
        expiresAt: iso(-1_000) as any,
      }),
    });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(1);
    expect(issues[0].kind).toEqual("orphaned_driver_lease");
  });

  it("detects stale mutation lease", () => {
    const goal = makeGoal({
      activeMutationLease: makeMutationLease({
        expiresAt: iso(-1_000) as any,
      }),
    });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(1);
    expect(issues[0].kind).toEqual("stale_mutation_lease");
    expect(issues[0]).toMatchObject({ phase: "MUTATING" });
  });

  it("detects stale recovery_required flag", () => {
    const goal = makeGoal({ recoveryRequired: true });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(1);
    expect(issues[0].kind).toEqual("stale_recovery_required");
  });

  it("skips terminal goals", () => {
    const goal = makeGoal({
      state: "DONE",
      activeDriverLease: makeDriverLease({
        expiresAt: iso(-1_000) as any,
      }),
    });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(0);
  });

  it("ignores valid non-expired leases", () => {
    const goal = makeGoal({
      activeDriverLease: makeDriverLease({ expiresAt: iso(60_000) as any }),
      activeMutationLease: makeMutationLease({
        expiresAt: iso(60_000) as any,
      }),
    });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(0);
  });

  it("returns multiple issues for a single goal", () => {
    const goal = makeGoal({
      activeDriverLease: makeDriverLease({
        expiresAt: iso(-1_000) as any,
      }),
      activeMutationLease: makeMutationLease({
        expiresAt: iso(-1_000) as any,
      }),
      recoveryRequired: true,
    });
    const issues = detectRecoveryIssues([goal], iso());
    expect(issues.length).toEqual(3);
  });
});

describe("repair", () => {
  // Task 1: repairs are persistent audited store writes (CAS + receipt log),
  // never direct object mutation. These tests drive the new (store, goalId)
  // signature against a real GoalStore.
  it("repairOrphanedDriverLease clears lease, persists, bumps version, logs receipt", () => {
    const { store, goalId } = persistGoal(makeGoal({
      activeDriverLease: makeDriverLease(),
      recordVersion: 5,
    }));
    const log: ReceiptLog = [];
    const patched = repairOrphanedDriverLease(store, goalId, log);
    expect(patched.activeDriverLease).toEqual(undefined);
    expect(patched.recoveryRequired).toEqual(true);
    expect(patched.recordVersion).toEqual(6);
    // Persistent: re-read from disk shows the repair.
    expect(store.get(goalId)?.activeDriverLease).toEqual(undefined);
    // Audited: receipt entry appended, no fake state transition.
    expect(log).toHaveLength(1);
    expect(log[0].eventType).toBe("Recovery:driver-lease");
    expect(log[0].fromState).toBe(log[0].toState);
  });

  it("repairStaleMutationLease clears lease, persists, bumps version, logs receipt", () => {
    const { store, goalId } = persistGoal(makeGoal({
      activeMutationLease: makeMutationLease(),
      recordVersion: 3,
    }));
    const log: ReceiptLog = [];
    const patched = repairStaleMutationLease(store, goalId, log);
    expect(patched.activeMutationLease).toEqual(undefined);
    expect(patched.recoveryRequired).toEqual(true);
    expect(patched.recordVersion).toEqual(4);
    expect(store.get(goalId)?.activeMutationLease).toEqual(undefined);
    expect(log).toHaveLength(1);
    expect(log[0].eventType).toBe("Recovery:mutation-lease");
  });

  it("repair with no such lease throws IgnoredEventError and writes nothing", () => {
    const { store, goalId } = persistGoal(makeGoal({ recordVersion: 7 }));
    expect(() => repairOrphanedDriverLease(store, goalId)).toThrowError(IgnoredEventError);
    expect(store.get(goalId)?.recordVersion).toBe(7);
  });
});
