/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssignmentId } from "../../src/domain/types.js";
import {
  acquireLease,
  releaseLease,
  checkLease,
  heartbeatLease,
  advanceLeasePhase,
  asActiveLease,
  canonicalizeRoot,
  readPersistedLease,
  tryReclaimExpiredLease,
  CanonicalRootError,
  _resetLeases,
  _clearMemoryOnly,
} from "../../src/execution/mutation-lease.js";

let tempDir: string;

const GOAL = "goal-001";
const ASSIGNMENT = "asgn-001" as AssignmentId;

function acquire(
  root: string = tempDir,
  overrides: Partial<Parameters<typeof acquireLease>[0]> = {},
) {
  return acquireLease({
    goalId: GOAL,
    assignmentId: ASSIGNMENT,
    sessionId: "sess-001",
    root,
    writeSet: ["src/a.ts"],
    ...overrides,
  });
}

beforeEach(() => {
  _resetLeases();
  tempDir = mkdtempSync(join(tmpdir(), "lease-test-"));
});

afterEach(() => {
  _resetLeases();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── acquire / release ──────────────────────────────────────────────────────

describe("acquireLease / releaseLease", () => {
  it("acquires lease with canonical shape", () => {
    const result = acquire();
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.lease.goalId).toBe(GOAL);
      expect(result.lease.assignmentId).toBe(ASSIGNMENT);
      expect(result.lease.phase).toBe("ACQUIRED");
      expect(result.lease.planEpoch).toBe(0);
      expect(result.lease.fencingToken).toBeGreaterThan(0);
      expect(typeof result.lease.leaseId).toBe("string");
      expect(result.lease.allowedCanonicalPaths).toHaveLength(1);
      expect(result.lease.allowedCanonicalPaths[0].endsWith("src/a.ts")).toBe(true);
    }
  });

  it("denies second lease on same root", () => {
    expect(acquire().acquired).toBe(true);
    expect(acquire().acquired).toBe(false);
  });

  it("conflict reason discloses no winner leaseId (bearer credential)", () => {
    const first = acquire();
    expect(first.acquired).toBe(true);
    const winnerId = first.acquired ? first.lease.leaseId : "no-lease";
    const second = acquire();
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).not.toContain(winnerId);
      expect(second.reason).toContain("already leased");
    }
  });

  it("denies second acquire from simulated second process (memory cleared, disk wins)", () => {
    const first = acquire();
    expect(first.acquired).toBe(true);
    _clearMemoryOnly(); // simulate a fresh process: empty map, same disk root
    const second = acquireLease({
      goalId: "goal-002",
      assignmentId: "asgn-002" as AssignmentId,
      sessionId: "sess-002",
      root: tempDir,
      writeSet: ["src/b.ts"],
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toContain("already leased");
  });

  it("allows lease on different root", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "lease-test-"));
    try {
      expect(acquire().acquired).toBe(true);
      expect(acquire(otherDir).acquired).toBe(true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("releases lease successfully", () => {
    const r1 = acquire();
    expect(r1.acquired).toBe(true);
    if (r1.acquired) expect(releaseLease(tempDir, r1.lease.leaseId)).toBe(true);
    expect(acquire().acquired).toBe(true);
  });

  it("rejects release with wrong leaseId", () => {
    expect(acquire().acquired).toBe(true);
    expect(releaseLease(tempDir, "wrong-id")).toBe(false);
  });

  it("rejects release for nonexistent root", () => {
    expect(releaseLease(join(tempDir, "nope"), "any")).toBe(false);
  });

  it("requires non-empty writeSet", () => {
    const result = acquire(tempDir, { writeSet: [] });
    expect(result.acquired).toBe(false);
  });

  it("rejects write-set entries escaping the root", () => {
    const result = acquire(tempDir, { writeSet: ["../escape.ts"] });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("escapes");
  });
});

// ─── persistence ────────────────────────────────────────────────────────────

describe("persistence", () => {
  it("persists lease to disk after acquire", () => {
    const result = acquire();
    expect(result.acquired).toBe(true);
    const leaseFile = join(tempDir, ".keystone-lease.json");
    expect(existsSync(leaseFile)).toBe(true);
    const data = JSON.parse(readFileSync(leaseFile, "utf-8"));
    expect(data.leaseId).toBe((result as { lease: { leaseId: string } }).lease.leaseId);
    expect(data.goalId).toBe(GOAL);
  });

  it("deletes lease file after release", () => {
    const result = acquire();
    expect(result.acquired).toBe(true);
    if (result.acquired) releaseLease(tempDir, result.lease.leaseId);
    expect(existsSync(join(tempDir, ".keystone-lease.json"))).toBe(false);
  });

  it("fail-closed: unreadable lease file blocks acquisition", () => {
    writeFileSync(join(tempDir, ".keystone-lease.json"), "{not valid json");
    const result = acquire();
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("conflict");
  });

  it("fail-closed: malformed persisted fence counter never resets to zero", () => {
    writeFileSync(join(tempDir, ".keystone-fence-counter.json"), JSON.stringify({ counter: "corrupt" }));
    const result = acquire();
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toMatch(/unreadable fence counter/);
    expect(existsSync(join(tempDir, ".keystone-lease.json"))).toBe(false);
  });
});

// ─── expiry + heartbeat ─────────────────────────────────────────────────────

describe("expiry", () => {
  it("lease expires after ttlMs", () => {
    acquire(tempDir, { ttlMs: 1 });
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy wait
    }
    expect(checkLease(tempDir)).toBeNull();
  });

  it("expired lease auto-clears on new acquire", () => {
    acquire(tempDir, { ttlMs: 1 });
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy wait
    }
    expect(acquire().acquired).toBe(true);
  });

  it("heartbeat renews expiry", () => {
    const first = acquire(tempDir, { ttlMs: 50 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    const renewed = heartbeatLease(tempDir, first.lease.leaseId, 10_000);
    expect(renewed).not.toBeNull();
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait past the original 50ms TTL
    }
    expect(asActiveLease(checkLease(tempDir))).not.toBeNull();
  });

  it("heartbeat rejects unknown leaseId", () => {
    expect(acquire().acquired).toBe(true);
    expect(heartbeatLease(tempDir, "nope")).toBeNull();
  });

  it("guarded reclaim never deletes a fresh lease created after a stale read (P1 race)", () => {
    const root = canonicalizeRoot(tempDir);
    const leaseFile = join(root, ".keystone-lease.json");
    const record = (leaseId: string, expiresAt: string) => ({
      leaseId,
      fencingToken: 1,
      goalId: GOAL,
      assignmentId: ASSIGNMENT,
      sessionId: "sess-x",
      workerProcessIdentity: "pid-x",
      canonicalWorkspaceRoot: root,
      allowedCanonicalPaths: [],
      baseDirtySignature: "",
      planEpoch: 0,
      phase: "ACQUIRED",
      acquiredAt: new Date(1_000).toISOString(),
      heartbeatAt: new Date(1_000).toISOString(),
      expiresAt,
    });
    // A holds a stale read of expired lease X...
    writeFileSync(leaseFile, JSON.stringify(record("lease-X", new Date(1_000).toISOString())));
    const stale = readPersistedLease(root, 1_000 + 60_000);
    expect(stale.kind).toBe("expired");
    // ...then B creates fresh lease Y on disk before A reclaims.
    writeFileSync(leaseFile, JSON.stringify(record("lease-Y", new Date(Date.now() + 60_000).toISOString())));
    // A's guarded reclaim of X must refuse: Y is valid under a different leaseId.
    expect(tryReclaimExpiredLease(root, "lease-X")).toBe(false);
    const survivor = JSON.parse(readFileSync(leaseFile, "utf-8")) as { leaseId: string };
    expect(survivor.leaseId).toBe("lease-Y");
    // Sanity: reclaiming a still-expired lease succeeds and removes the file.
    writeFileSync(leaseFile, JSON.stringify(record("lease-X", new Date(1_000).toISOString())));
    expect(tryReclaimExpiredLease(root, "lease-X", 1_000 + 60_000)).toBe(true);
    expect(existsSync(leaseFile)).toBe(false);
  });
});

// ─── fencing ────────────────────────────────────────────────────────────────

describe("fencingToken", () => {
  it("fencingToken increases with each acquisition (persisted counter)", () => {
    const r1 = acquire(tempDir, { ttlMs: 100 });
    expect(r1.acquired).toBe(true);
    if (!r1.acquired) return;
    const t1 = r1.lease.fencingToken;
    const start = Date.now();
    while (Date.now() - start < 110) {
      // busy wait
    }
    const r2 = acquire();
    expect(r2.acquired).toBe(true);
    if (r2.acquired) expect(r2.lease.fencingToken).toBeGreaterThan(t1);
  });

  it("fencing survives release (counter not reset)", () => {
    const r1 = acquire();
    expect(r1.acquired).toBe(true);
    if (!r1.acquired) return;
    releaseLease(tempDir, r1.lease.leaseId);
    const r2 = acquire();
    expect(r2.acquired).toBe(true);
    if (r2.acquired) expect(r2.lease.fencingToken).toBeGreaterThan(r1.lease.fencingToken);
  });
});

// ─── phases ─────────────────────────────────────────────────────────────────

describe("advanceLeasePhase", () => {
  it("advances ACQUIRED -> AUTHORITY_READY", () => {
    const r = acquire();
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    const next = advanceLeasePhase(tempDir, r.lease.leaseId, "AUTHORITY_READY");
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.lease.phase).toBe("AUTHORITY_READY");
  });

  it("rejects skipping phases", () => {
    const r = acquire();
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    const next = advanceLeasePhase(tempDir, r.lease.leaseId, "MUTATING");
    expect(next.ok).toBe(false);
  });
});

// ─── checkLease ─────────────────────────────────────────────────────────────

describe("checkLease", () => {
  it("returns lease when active", () => {
    const r = acquire(tempDir, { ttlMs: 10_000 });
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      const lease = asActiveLease(checkLease(tempDir));
      expect(lease?.leaseId).toBe(r.lease.leaseId);
    }
  });

  it("loads valid disk lease after memory-only reset (second process view)", () => {
    const r = acquire(tempDir, { ttlMs: 10_000 });
    expect(r.acquired).toBe(true);
    _clearMemoryOnly();
    const lease = asActiveLease(checkLease(tempDir));
    expect(lease?.leaseId).toBe((r as { lease: { leaseId: string } }).lease.leaseId);
  });

  it("returns null for no lease", () => {
    mkdirSync(join(tempDir, "empty"));
    expect(checkLease(join(tempDir, "empty"))).toBeNull();
  });

  it("returns typed CONFLICT on unreadable lease file (never null-as-free)", () => {
    writeFileSync(join(tempDir, ".keystone-lease.json"), "{not valid json");
    const result = checkLease(tempDir);
    expect(result).not.toBeNull();
    if (result !== null && typeof result === "object" && "conflict" in result) {
      expect(result.conflict).toBe(true);
      expect(typeof result.reason).toBe("string");
    } else {
      throw new Error("expected typed CONFLICT state");
    }
    expect(asActiveLease(result)).toBeNull();
  });

  it("returns typed CONFLICT when the root is unresolvable", () => {
    const result = checkLease(join(tempDir, "does-not-exist"));
    if (result !== null && typeof result === "object" && "conflict" in result) {
      expect(result.conflict).toBe(true);
    } else {
      throw new Error("expected typed CONFLICT state");
    }
  });
});

// ─── canonicalizeRoot fail-closed ──────────────────────────────────────────

describe("canonicalizeRoot", () => {
  it("throws a typed CanonicalRootError when realpathSync fails", () => {
    expect(() => canonicalizeRoot(join(tempDir, "does-not-exist"))).toThrow(CanonicalRootError);
    try {
      canonicalizeRoot(join(tempDir, "does-not-exist"));
    } catch (error) {
      expect((error as CanonicalRootError).code).toBe("LEASE_ROOT_UNRESOLVABLE");
    }
  });

  it("acquireLease denies (no throw) on an unresolvable root", () => {
    const result = acquire(join(tempDir, "does-not-exist"));
    expect(result.acquired).toBe(false);
  });
});
