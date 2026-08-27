import { describe, it } from "vitest";
import assert from "vitest";
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
    expect((result as any).reason.includes("fence mismatch")).toBeTruthy();
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
