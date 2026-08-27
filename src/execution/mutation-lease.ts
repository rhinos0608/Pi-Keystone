// Mutation lease — exclusive write lock per canonical worktree.
// Includes disk persistence for crash recovery.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MutationLease = {
  leaseId: string;
  goalId: string;
  fencingToken: number;
  root: string;
  expiresAt: number;
  ownerPid: number;
};

export type AcquireResult =
  | { acquired: true; lease: MutationLease }
  | { acquired: false; reason: string };

// ─── State ──────────────────────────────────────────────────────────────────

const activeLeases = new Map<string, MutationLease>();

const LEASE_FILENAME = ".keystone-lease.json";

// ─── Disk persistence ──────────────────────────────────────────────────────

function leasePath(root: string): string {
  return join(root, LEASE_FILENAME);
}

/**
 * Write lease to disk at ${root}/.keystone-lease.json
 */
function persistLease(root: string, lease: MutationLease): void {
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(leasePath(root), JSON.stringify(lease), "utf-8");
  } catch {
    // Best-effort persistence; in-memory state is authoritative
  }
}

/**
 * Read lease from disk. Returns null if missing, corrupted, or expired.
 */
function loadLease(root: string): MutationLease | null {
  try {
    const raw = readFileSync(leasePath(root), "utf-8");
    const parsed = JSON.parse(raw) as MutationLease;
    if (typeof parsed.leaseId !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete persisted lease file from disk.
 */
function deleteLeaseFile(root: string): void {
  try {
    unlinkSync(leasePath(root));
  } catch {
    // File may not exist; best-effort cleanup
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Acquire exclusive mutation lease for a worktree root.
 * One lease per root — second caller gets denied.
 * Persists lease to disk for crash recovery.
 * Returns the lease or a denial reason.
 */
export function acquireLease(opts: {
  goalId: string;
  root: string;
  ttlMs?: number;
}): AcquireResult {
  const { goalId, root, ttlMs = 30_000 } = opts;

  // Check for existing active lease on same root
  const existing = activeLeases.get(root);
  if (existing) {
    if (existing.expiresAt > Date.now()) {
      return { acquired: false, reason: `root "${root}" already leased by ${existing.leaseId}` };
    }
    // Stale lease — auto-expire
    activeLeases.delete(root);
    deleteLeaseFile(root);
  }

  const lease: MutationLease = {
    leaseId: randomUUID(),
    goalId,
    fencingToken: Date.now(),
    root,
    expiresAt: Date.now() + ttlMs,
    ownerPid: process.pid,
  };

  activeLeases.set(root, lease);
  persistLease(root, lease);
  return { acquired: true, lease };
}

/**
 * Release a lease. Only succeeds if caller owns the lease.
 * Removes from memory and deletes persisted file.
 */
export function releaseLease(root: string, leaseId: string): boolean {
  const existing = activeLeases.get(root);
  if (!existing) return false;
  if (existing.leaseId !== leaseId) return false;
  activeLeases.delete(root);
  deleteLeaseFile(root);
  return true;
}

/**
 * Check if a lease is still valid (exists and not expired).
 * Falls back to disk if not found in memory.
 */
export function checkLease(root: string): MutationLease | null {
  const lease = activeLeases.get(root);
  if (lease) {
    if (lease.expiresAt <= Date.now()) {
      activeLeases.delete(root);
      deleteLeaseFile(root);
      return null;
    }
    return lease;
  }

  // Fallback: try loading from disk
  const diskLease = loadLease(root);
  if (diskLease) {
    activeLeases.set(root, diskLease);
    return diskLease;
  }

  return null;
}

/**
 * Clear all leases. Clears both memory and disk state. Test-only.
 */
export function _resetLeases(): void {
  for (const [root] of activeLeases) {
    deleteLeaseFile(root);
  }
  activeLeases.clear();
}
