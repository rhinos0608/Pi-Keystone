import { describe, it, afterAll } from "vitest";
import assert from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalStore } from "../../src/store/goal-store.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { acquireDriverLeasePersisted, releaseDriverLeasePersisted } from "../../src/runtime/driver.js";
import { startGoal } from "../../src/runtime/lifecycle.js";
import type { GoalRecord, GoalId, ISO8601, RevisionRef } from "../../src/domain/types.js";
import {
  acquireDriverLease,
  checkDriverFence,
  releaseDriverLease,
  heartbeatDriverLease,
  validateFencedEvent,
} from "../../src/runtime/driver.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REVISION: RevisionRef = {
  snapshotId: "snap-0" as any,
  observedAt: "2025-01-01T00:00:00.000Z" as ISO8601,
  graphRevision: 1,
  dirtySignature: "",
  capabilityDigest: "",
};

function makeRecord(overrides?: Partial<GoalRecord>): GoalRecord {
  return {
    schemaVersion: 1,
    recordVersion: 1,
    goalId: "goal-test" as GoalId,
    userTask: "test",
    createdAt: "2025-01-01T00:00:00.000Z" as ISO8601,
    updatedAt: "2025-01-01T00:00:00.000Z" as ISO8601,
    workspace: {
      requestedRoot: "/tmp",
      canonicalRoot: "/tmp",
      projectKey: "abc",
      vcs: "git",
    },
    startRevision: REVISION,
    currentRevision: REVISION,
    state: "EXECUTING",
    recoveryRequired: false,
    planEpoch: 0,
    contractVersion: 1,
    activeContractRef: "" as any,
    baselineRef: null,
    snapshotRefs: [],
    snapshotPins: [],
    findingLedgerRef: "" as any,
    evidenceIndexRef: "" as any,
    assignmentIndexRef: "" as any,
    verificationIndexRef: "" as any,
    preparation: {
      baselineJob: { kind: "baseline", planEpoch: 0, attemptId: "", basedOnRevision: REVISION, status: "PENDING" },
      provisionalPlanJob: { kind: "plan", planEpoch: 0, attemptId: "", basedOnRevision: REVISION, status: "PENDING" },
    },
    driverFenceCounter: 0,
    mutationFenceCounter: 0,
    reviewCycles: 0,
    repairCycles: 0,
    finalAuditAttempts: 0,
    lastTransitionId: "",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("acquireDriverLease", () => {
  it("first acquisition creates lease with fence=1", () => {
    const r = makeRecord();
    const result = acquireDriverLease(r, "session-A", { ttlMs: 60_000 });

    expect(result.activeDriverLease, "lease should exist").toBeTruthy();
    expect(result.activeDriverLease.sessionId).toEqual("session-A");
    expect(result.activeDriverLease.fencingToken).toEqual(1);
    expect(result.driverFenceCounter).toEqual(1);
    expect(result.activeDriverLease.leaseId.length > 0, "leaseId should be non-empty UUID").toBeTruthy();
  });

  it("second acquisition by same session heartbeats (extends expiry)", () => {
    const r = makeRecord();
    acquireDriverLease(r, "session-A", { ttlMs: 60_000 });
    const firstExpiry = r.activeDriverLease!.expiresAt;

    // Small delay to ensure time difference
    acquireDriverLease(r, "session-A", { ttlMs: 60_000 });
    expect(r.activeDriverLease!.fencingToken).toBe(1);
    expect(r.activeDriverLease!.expiresAt >= firstExpiry, "expiry should extend or stay").toBeTruthy();
  });

  it("different session rejected when lease active", () => {
    const r = makeRecord();
    acquireDriverLease(r, "session-A", { ttlMs: 60_000 });
    acquireDriverLease(r, "session-B", { ttlMs: 60_000 });

    expect(r.activeDriverLease!.sessionId).toBe("session-A");
    expect(r.activeDriverLease!.fencingToken).toBe(1);
  });

  it("takeover: expired lease allows new session", () => {
    const r = makeRecord();
    acquireDriverLease(r, "session-A", { ttlMs: 0 }); // expires immediately

    // Force expiry check
    r.activeDriverLease!.expiresAt = "2000-01-01T00:00:00.000Z" as ISO8601;

    acquireDriverLease(r, "session-B", { ttlMs: 60_000 });
    expect(r.activeDriverLease!.sessionId).toEqual("session-B");
    expect(r.activeDriverLease!.fencingToken).toBe(2);
  });
});

describe("checkDriverFence", () => {
  it("returns true for matching fence token", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    expect(checkDriverFence(r, 1)).toEqual(true);
  });

  it("returns false for mismatched fence token", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    expect(checkDriverFence(r, 999)).toEqual(false);
  });

  it("returns false when no active lease", () => {
    const r = makeRecord();
    expect(checkDriverFence(r, 1)).toEqual(false);
  });

  it("returns false when lease expired", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 0 });
    r.activeDriverLease!.expiresAt = "2000-01-01T00:00:00.000Z" as ISO8601;
    expect(checkDriverFence(r, 1)).toEqual(false);
  });
});

describe("releaseDriverLease", () => {
  it("clears the active lease", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    releaseDriverLease(r);
    expect(r.activeDriverLease).toEqual(undefined);
  });

  it("allows new session to acquire after release", () => {
    const r = makeRecord();
    acquireDriverLease(r, "session-A", { ttlMs: 60_000 });
    releaseDriverLease(r);
    acquireDriverLease(r, "session-B", { ttlMs: 60_000 });
    expect(r.activeDriverLease!.sessionId).toEqual("session-B");
    expect(r.activeDriverLease!.fencingToken).toEqual(2);
  });
});

describe("heartbeatDriverLease", () => {
  it("extends expiry for same session", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 1000 });
    const before = r.activeDriverLease!.expiresAt;
    heartbeatDriverLease(r, "s", { ttlMs: 5000 });
    expect(r.activeDriverLease!.expiresAt >= before).toBeTruthy();
  });

  it("no-op for wrong session", () => {
    const r = makeRecord();
    acquireDriverLease(r, "session-A", { ttlMs: 1000 });
    heartbeatDriverLease(r, "session-B", { ttlMs: 5000 });
    expect(r.activeDriverLease!.sessionId).toEqual("session-A");
  });

  it("no-op when no lease", () => {
    const r = makeRecord();
    heartbeatDriverLease(r, "s", { ttlMs: 5000 });
    expect(r.activeDriverLease).toEqual(undefined);
  });
});

describe("validateFencedEvent", () => {
  it("passes for event without driverFence", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    const result = validateFencedEvent(r, { type: "GoalStarted" } as any);
    expect(result).toEqual({ ok: true });
  });

  it("passes for matching fence", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    const result = validateFencedEvent(r, { type: "AssignmentCompleted", driverFence: 1 });
    expect(result).toEqual({ ok: true });
  });

  it("rejects mismatched fence", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 60_000 });
    const result = validateFencedEvent(r, { type: "AssignmentCompleted", driverFence: 42 });
    expect(result.ok).toEqual(false);
    if (!result.ok) {
      // Log-safe reason: no token numbers; exact tokens ride typed fields.
      expect(result.reason).toEqual("stale driver fence");
      expect(result.reason).not.toContain("42");
      expect(result.code).toEqual("STALE_DRIVER_FENCE");
      expect(result.eventFence).toEqual(42);
      expect(result.leaseFence).toEqual(1);
    }
  });

  it("rejects when no active lease", () => {
    const r = makeRecord();
    const result = validateFencedEvent(r, { type: "AssignmentCompleted", driverFence: 1 });
    expect(result.ok).toEqual(false);
    expect((result as any).reason.includes("no active driver lease")).toBeTruthy();
  });

  it("rejects when lease expired", () => {
    const r = makeRecord();
    acquireDriverLease(r, "s", { ttlMs: 0 });
    r.activeDriverLease!.expiresAt = "2000-01-01T00:00:00.000Z" as ISO8601;
    const result = validateFencedEvent(r, { type: "AssignmentCompleted", driverFence: 1 });
    expect(result.ok).toEqual(false);
  });
});

describe("fence counter monotonicity", () => {
  it("increments on each new lease acquisition", () => {
    const r = makeRecord();
    acquireDriverLease(r, "a", { ttlMs: 0 });
    r.activeDriverLease!.expiresAt = "2000-01-01T00:00:00.000Z" as ISO8601;

    acquireDriverLease(r, "b", { ttlMs: 0 });
    r.activeDriverLease!.expiresAt = "2000-01-01T00:00:00.000Z" as ISO8601;

    acquireDriverLease(r, "c", { ttlMs: 60_000 });

    expect(r.driverFenceCounter).toEqual(3);
    expect(r.activeDriverLease!.fencingToken).toEqual(3);
  });

  it("does not increment on heartbeat", () => {
    const r = makeRecord();
    acquireDriverLease(r, "a", { ttlMs: 60_000 });
    heartbeatDriverLease(r, "a", { ttlMs: 60_000 });
    heartbeatDriverLease(r, "a", { ttlMs: 60_000 });
    expect(r.driverFenceCounter).toEqual(1);
    expect(r.activeDriverLease!.fencingToken).toEqual(1);
  });
});

describe("persisted driver lease (CAS through GoalStore)", () => {
  const persistDirs: string[] = [];
  afterAll(() => {
    for (const dir of persistDirs) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "keystone-driver-persist-"));
    persistDirs.push(dir);
    const store = new GoalStore(dir);
    const goalId = "goal-persist" as GoalId;
    startGoal(store, goalId, createGoalRecord(goalId, "task", {
      requestedRoot: "/tmp",
      canonicalRoot: "/tmp",
      projectKey: "abc" as never,
      vcs: "git",
    }, REVISION), []);
    return { store, goalId, acquireDriverLeasePersisted, releaseDriverLeasePersisted };
  }

  it("acquire persists lease + counter visible on re-read", () => {
    const { store, goalId, acquireDriverLeasePersisted } = setup();
    const updated = acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 60_000 });
    expect(updated.activeDriverLease!.sessionId).toBe("session-A");
    expect(updated.activeDriverLease!.fencingToken).toBe(1);
    expect(updated.driverFenceCounter).toBe(1);
    const reread = store.get(goalId)!;
    expect(reread.activeDriverLease).toEqual(updated.activeDriverLease);
    expect(reread.driverFenceCounter).toBe(1);
  });

  it("same-session heartbeat persists extended expiry without counter bump", () => {
    const { store, goalId, acquireDriverLeasePersisted } = setup();
    acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 1000 });
    const before = store.get(goalId)!;
    const updated = acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 60_000 });
    expect(updated.activeDriverLease!.fencingToken).toBe(1);
    expect(updated.driverFenceCounter).toBe(1);
    expect(
      new Date(updated.activeDriverLease!.expiresAt).getTime() >=
      new Date(before.activeDriverLease!.expiresAt).getTime(),
    ).toBe(true);
  });

  it("different session rejected with no write", () => {
    const { store, goalId, acquireDriverLeasePersisted } = setup();
    acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 60_000 });
    const versionBefore = store.get(goalId)!.recordVersion;
    const same = acquireDriverLeasePersisted(store, goalId, "session-B", { ttlMs: 60_000 });
    expect(same.activeDriverLease!.sessionId).toBe("session-A");
    expect(store.get(goalId)!.recordVersion).toBe(versionBefore);
  });

  it("release persists lease clearance", () => {
    const { store, goalId, acquireDriverLeasePersisted, releaseDriverLeasePersisted } = setup();
    const acquired = acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 60_000 });
    const lease = acquired.activeDriverLease!;
    const released = releaseDriverLeasePersisted(store, goalId, {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fencingToken: lease.fencingToken,
    });
    expect(released.activeDriverLease).toBeUndefined();
    expect(store.get(goalId)!.activeDriverLease).toBeUndefined();
  });

  it("stale release cannot clear a newer session lease", () => {
    const { store, goalId, acquireDriverLeasePersisted, releaseDriverLeasePersisted } = setup();
    const first = acquireDriverLeasePersisted(store, goalId, "session-A", { ttlMs: 60_000 });
    const oldLease = first.activeDriverLease!;
    const rec = store.get(goalId)!;
    store.update(goalId, {
      type: "DriverLeaseAcquired",
      lease: { ...oldLease, expiresAt: "2000-01-01T00:00:00.000Z" as any },
      fenceCounter: rec.driverFenceCounter,
    });
    const second = acquireDriverLeasePersisted(store, goalId, "session-B", { ttlMs: 60_000 });
    expect(second.activeDriverLease?.sessionId).toBe("session-B");
    expect(second.activeDriverLease?.fencingToken).toBeGreaterThan(oldLease.fencingToken);

    const afterStaleRelease = releaseDriverLeasePersisted(store, goalId, {
      leaseId: oldLease.leaseId,
      sessionId: oldLease.sessionId,
      fencingToken: oldLease.fencingToken,
    });
    expect(afterStaleRelease.activeDriverLease?.sessionId).toBe("session-B");
    expect(afterStaleRelease.activeDriverLease?.leaseId).toBe(second.activeDriverLease?.leaseId);
  });
});
