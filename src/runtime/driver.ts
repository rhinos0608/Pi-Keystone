// Goal driver — fenced lease management
// Operates on GoalRecord from src/domain/types.ts

import type { GoalRecord, DriverLease, ISO8601 } from "../domain/types.js";

declare const crypto: { randomUUID(): string };

const DEFAULT_TTL_MS = 60_000; // 60 s

function now(): ISO8601 {
  return new Date().toISOString() as ISO8601;
}

function expiry(ttlMs: number): ISO8601 {
  return new Date(Date.now() + ttlMs).toISOString() as ISO8601;
}

/** True when the lease exists and hasn't expired. */
function leaseActive(lease: DriverLease | undefined): boolean {
  if (!lease) return false;
  return Date.now() < new Date(lease.expiresAt).getTime();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Acquire or renew a driver lease for a goal.
 * - No active lease (missing or expired) → new lease, fence counter incremented.
 * - Active lease, same session → heartbeat (extend expiry).
 * - Active lease, different session → rejected (returns record unchanged).
 *
 * Returns the (possibly mutated) GoalRecord.
 */
export function acquireDriverLease(
  record: GoalRecord,
  sessionId: string,
  opts?: { ttlMs?: number },
): GoalRecord {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const active = record.activeDriverLease;

  if (active && leaseActive(active)) {
    if (active.sessionId === sessionId) {
      // Heartbeat — extend expiry
      active.heartbeatAt = now();
      active.expiresAt = expiry(ttlMs);
      record.updatedAt = now();
    }
    // Different session → reject, no mutation
    return record;
  }

  // Takeover or first acquisition
  const fence = record.driverFenceCounter + 1;
  record.driverFenceCounter = fence;
  record.activeDriverLease = {
    leaseId: crypto.randomUUID(),
    sessionId,
    fencingToken: fence,
    acquiredAt: now(),
    heartbeatAt: now(),
    expiresAt: expiry(ttlMs),
  };
  record.updatedAt = now();
  return record;
}

/**
 * Check whether a fence token matches the current active lease.
 * Returns false if no lease or expired.
 */
export function checkDriverFence(
  record: GoalRecord,
  fence: number,
): boolean {
  if (!leaseActive(record.activeDriverLease)) return false;
  return record.activeDriverLease!.fencingToken === fence;
}

/**
 * Release the active driver lease for a goal.
 * Clears the active lease. Returns the mutated record.
 */
export function releaseDriverLease(record: GoalRecord): GoalRecord {
  record.activeDriverLease = undefined;
  record.updatedAt = now();
  return record;
}

/**
 * Heartbeat an existing lease (same-session renewal).
 * If no active lease or wrong session → no-op.
 */
export function heartbeatDriverLease(
  record: GoalRecord,
  sessionId: string,
  opts?: { ttlMs?: number },
): GoalRecord {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const active = record.activeDriverLease;
  if (!active || !leaseActive(active)) return record;
  if (active.sessionId !== sessionId) return record;

  active.heartbeatAt = now();
  active.expiresAt = expiry(ttlMs);
  record.updatedAt = now();
  return record;
}

/**
 * Validate that a GoalEvent's driverFence matches the current active lease.
 * Returns { ok: true } if valid, { ok: false, reason } if rejected.
 * Events without driverFence field always pass.
 */
export function validateFencedEvent(
  record: GoalRecord,
  event: { driverFence?: number; type: string },
): { ok: true } | { ok: false; reason: string } {
  if (event.driverFence === undefined) return { ok: true };
  if (!leaseActive(record.activeDriverLease)) {
    return { ok: false, reason: "no active driver lease" };
  }
  if (event.driverFence !== record.activeDriverLease!.fencingToken) {
    return {
      ok: false,
      reason: `fence mismatch: event=${event.driverFence} lease=${record.activeDriverLease!.fencingToken}`,
    };
  }
  return { ok: true };
}
