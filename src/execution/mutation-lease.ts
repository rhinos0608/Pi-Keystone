// Mutation lease — exclusive write lock per canonical worktree root.
//
// Single canonical family: reuses the domain `MutationLease` type and extends
// it with acquisition metadata (goalId, baseRevision, planEpoch, approvalRef).
//
// Cross-process protocol:
// - Lease file lives at `${canonicalRoot}/.keystone-lease.json`.
// - Acquisition uses O_EXCL atomic create (`writeFileSync` flag "wx"): the
//   file check and write are one atomic step, so two processes racing to
//   acquire cannot both succeed. An EEXIST means the other process won.
// - Fail-closed: a lease file that exists but cannot be read/parsed is
//   treated as a conflict (acquire denied), never as free.
// - Monotonic fencing tokens come from a persisted per-root counter file
//   (`.keystone-fence-counter.json`), so tokens increase across releases and
//   process restarts.
//
// RESIDUAL GAPS (documented): the fence-counter read-modify-write runs
// under a per-root directory-lock, so concurrent acquirers cannot duplicate
// or roll back the counter. Gaps are still possible: an acquirer may
// increment the counter and then lose the O_EXCL lease-file race, skipping
// its token. Skipped tokens are never reused, so fencing order stays
// strictly increasing; gaps are accepted, duplicates are not.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactRef, AssignmentId, ISO8601, MutationLease } from "../domain/types.js";
import { withLock } from "../store/directory-lock.js";

export type { MutationLease };
export type MutationLeasePhase = MutationLease["phase"];

// ─── Extended lease record ──────────────────────────────────────────────────

export type MutationLeaseRecord = MutationLease & {
  goalId: string;
  baseRevision: string | null;
  planEpoch: number;
  approvalRef?: ArtifactRef;
};

export type AcquireMutationLeaseOptions = {
  goalId: string;
  assignmentId: AssignmentId;
  sessionId: string;
  root: string;
  /** Acquisition-proposed write-set. Becomes allowedCanonicalPaths. */
  writeSet: string[];
  planEpoch?: number;
  baseRevision?: string | null;
  baseDirtySignature?: string;
  workerProcessIdentity?: string;
  ttlMs?: number;
  now?: number;
};

export type AcquireResult =
  | { acquired: true; lease: MutationLeaseRecord }
  | { acquired: false; reason: string };

export type LeasePhaseTransitionError = { ok: false; reason: string };
export type LeasePhaseTransition = { ok: true; lease: MutationLeaseRecord } | LeasePhaseTransitionError;

// ─── Constants ──────────────────────────────────────────────────────────────

const LEASE_FILENAME = ".keystone-lease.json";
const FENCE_COUNTER_FILENAME = ".keystone-fence-counter.json";
const DEFAULT_TTL_MS = 30_000;

// ─── In-process cache ───────────────────────────────────────────────────────

const activeLeases = new Map<string, MutationLeaseRecord>();

// ─── Path helpers ───────────────────────────────────────────────────────────

function leasePath(canonicalRoot: string): string {
  return path.join(canonicalRoot, LEASE_FILENAME);
}

function fenceCounterPath(canonicalRoot: string): string {
  return path.join(canonicalRoot, FENCE_COUNTER_FILENAME);
}

/** Typed fail-closed error when the workspace root cannot be resolved. */
export class CanonicalRootError extends Error {
  readonly code = "LEASE_ROOT_UNRESOLVABLE";
  constructor(root: string) {
    super(`keystone: workspace root not resolvable: ${root}`);
    this.name = "CanonicalRootError";
  }
}

/** Fail-closed: throws CanonicalRootError when realpathSync fails. */
export function canonicalizeRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    throw new CanonicalRootError(root);
  }
}

/** Resolve a write-set entry against the root; throws if it escapes the root. */
export function canonicalizeWritePath(root: string, entry: string): string {
  const abs = path.isAbsolute(entry) ? path.normalize(entry) : path.join(root, entry);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`write-set entry escapes workspace root: ${entry}`);
  }
  return abs;
}

function normalizePathSet(root: string, entries: readonly string[]): string[] {
  return [...new Set(entries.map((e) => canonicalizeWritePath(root, e)))].sort();
}

function isoNow(now?: number): ISO8601 {
  return new Date(now ?? Date.now()).toISOString() as ISO8601;
}

function msOf(t: ISO8601 | number | string): number {
  return new Date(t as string).getTime();
}

// ─── Persisted fence counter ────────────────────────────────────────────────

function readFenceCounter(canonicalRoot: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(fenceCounterPath(canonicalRoot), "utf-8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      Number.isSafeInteger((raw as { counter?: unknown }).counter) &&
      (raw as { counter: number }).counter >= 0
    ) {
      return (raw as { counter: number }).counter;
    }
    // Parseable-but-invalid counter state is still corruption. Treating it as
    // zero could reuse an old fencing token after a partial/manual rewrite.
    throw new Error("invalid fence counter shape");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    // Any corrupt/unreadable counter fails closed. A fencing counter must
    // never silently reset because token reuse can admit stale mutation work.
    throw new Error(`unreadable fence counter at ${fenceCounterPath(canonicalRoot)}`);
  }
}

function nextFencingToken(canonicalRoot: string): number {
  // Serialized under the per-root directory-lock: concurrent acquirers
  // cannot interleave the read-modify-write (no duplicate or reset tokens).
  return withLock(path.join(canonicalRoot, FENCE_COUNTER_FILENAME), () => {
    const next = readFenceCounter(canonicalRoot) + 1;
    const tmp = path.join(
      canonicalRoot,
      `.${FENCE_COUNTER_FILENAME}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
    );
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ counter: next }), "utf-8");
    try {
      fs.renameSync(tmp, fenceCounterPath(canonicalRoot));
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best-effort tmp cleanup.
      }
    }
    return next;
  });
}

// ─── Persisted lease file ───────────────────────────────────────────────────

type PersistedRead =
  | { kind: "missing" }
  | { kind: "valid"; lease: MutationLeaseRecord }
  | { kind: "expired"; lease: MutationLeaseRecord }
  | { kind: "unreadable"; reason: string };

function isLeaseRecord(value: unknown): value is MutationLeaseRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.leaseId === "string" &&
    typeof v.fencingToken === "number" &&
    typeof v.assignmentId === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.canonicalWorkspaceRoot === "string" &&
    Array.isArray(v.allowedCanonicalPaths) &&
    typeof v.baseDirtySignature === "string" &&
    typeof v.phase === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.goalId === "string" &&
    typeof v.planEpoch === "number"
  );
}

/** Fail-closed read: unreadable/corrupt files report "unreadable", never "missing". */
export function readPersistedLease(canonicalRoot: string, now?: number): PersistedRead {
  const nowMs = now ?? Date.now();
  let raw: string;
  try {
    raw = fs.readFileSync(leasePath(canonicalRoot), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", reason: `cannot read lease file: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "lease file is not valid JSON" };
  }
  if (!isLeaseRecord(parsed)) {
    return { kind: "unreadable", reason: "lease file has invalid shape" };
  }
  if (Number.isNaN(msOf(parsed.expiresAt)) || msOf(parsed.expiresAt) <= nowMs) {
    return { kind: "expired", lease: parsed };
  }
  return { kind: "valid", lease: parsed };
}

/** Atomic create (O_EXCL). Returns false when another process won the race. */
function atomicCreateLeaseFile(canonicalRoot: string, lease: MutationLeaseRecord): boolean {
  fs.mkdirSync(canonicalRoot, { recursive: true });
  try {
    fs.writeFileSync(leasePath(canonicalRoot), JSON.stringify(lease, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function overwriteLeaseFile(canonicalRoot: string, lease: MutationLeaseRecord): void {
  const tmp = path.join(canonicalRoot, `.${LEASE_FILENAME}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, leasePath(canonicalRoot));
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort tmp cleanup.
    }
  }
}

// ─── Lease-file lock ────────────────────────────────────────────────────────
//
// P1 race fix: every mutation of the lease file (acquire reclaim, explicit
// release, stale cleanup in checkLease, heartbeat renew, phase advance)
// serializes under the same per-root directory-lock, so
// read-verify-remove-recreate is one critical section. Removal additionally
// re-checks expiry + leaseId identity inside the lock immediately before
// unlinking: a lease that changed (different leaseId or no longer expired —
// e.g. a fresh lease created between a stale read and the reclaim) is never
// removed.

/** Base path for the per-root lease lock (`.lock` suffix appended by withLock). */
function leaseLockBase(canonicalRoot: string): string {
  return path.join(canonicalRoot, LEASE_FILENAME);
}

/**
 * Remove the lease file only when a fresh in-lock re-read still shows the
 * expected expired lease. Returns true when the file was removed; false when
 * the lease changed (different leaseId, no longer expired, or unreadable) —
 * the caller must then honor the fresh state instead of removing.
 * Lock-free core: callers must hold the lease lock.
 */
function reclaimIfSameExpiredCore(
  canonicalRoot: string,
  expectedLeaseId: string,
  nowMs: number,
): boolean {
  const fresh = readPersistedLease(canonicalRoot, nowMs);
  if (fresh.kind !== "expired" || fresh.lease.leaseId !== expectedLeaseId) return false;
  try {
    fs.rmSync(leasePath(canonicalRoot), { force: true });
  } catch {
    return false;
  }
  if (activeLeases.get(canonicalRoot)?.leaseId === expectedLeaseId) {
    activeLeases.delete(canonicalRoot);
  }
  return true;
}

/**
 * Guarded stale-lease reclamation: removes
 * `${canonicalRoot}/.keystone-lease.json` only when it still holds the
 * expected expired leaseId. A fresh lease created after the caller's stale
 * read is never deleted. Returns true only when reclamation succeeded.
 */
export function tryReclaimExpiredLease(root: string, expectedLeaseId: string, now?: number): boolean {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch {
    return false;
  }
  const nowMs = now ?? Date.now();
  return withLock(leaseLockBase(canonicalRoot), () =>
    reclaimIfSameExpiredCore(canonicalRoot, expectedLeaseId, nowMs),
  );
}

// ─── API ────────────────────────────────────────────────────────────────────

export function acquireLease(opts: AcquireMutationLeaseOptions): AcquireResult {
  const {
    goalId,
    assignmentId,
    sessionId,
    root,
    writeSet,
    planEpoch = 0,
    baseRevision = null,
    baseDirtySignature = "",
    ttlMs = DEFAULT_TTL_MS,
    now,
  } = opts;
  if (!goalId) return { acquired: false, reason: "goalId required" };
  if (!assignmentId) return { acquired: false, reason: "assignmentId required" };
  if (!sessionId) return { acquired: false, reason: "sessionId required" };
  if (!writeSet || writeSet.length === 0) {
    return { acquired: false, reason: "writeSet required (exact lease scope)" };
  }

  const nowMs = now ?? Date.now();
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch (error) {
    return { acquired: false, reason: (error as Error).message };
  }

  let allowedCanonicalPaths: string[];
  try {
    allowedCanonicalPaths = normalizePathSet(canonicalRoot, writeSet);
  } catch (error) {
    return { acquired: false, reason: (error as Error).message };
  }

  // In-process fast path (same-process exclusion).
  const cached = activeLeases.get(canonicalRoot);
  if (cached && msOf(cached.expiresAt) > nowMs) {
    return { acquired: false, reason: `workspace already leased at "${canonicalRoot}"` };
  }
  if (cached) activeLeases.delete(canonicalRoot);

  // Serialize read-verify-remove-recreate under the lease lock: disk state
  // wins over an empty in-process map, and stale-file reclamation re-checks
  // expiry + leaseId identity inside the lock immediately before removal.
  return withLock<AcquireResult>(leaseLockBase(canonicalRoot), () => {
    const persisted = readPersistedLease(canonicalRoot, nowMs);
    if (persisted.kind === "valid") {
      activeLeases.set(canonicalRoot, persisted.lease);
      return { acquired: false, reason: `workspace already leased at "${canonicalRoot}"` };
    }
    if (persisted.kind === "unreadable") {
      // Fail closed: do not treat a corrupt/unreadable file as free.
      return { acquired: false, reason: `lease file conflict at ${leasePath(canonicalRoot)}: ${persisted.reason}` };
    }
    if (persisted.kind === "expired") {
      const reclaimed = reclaimIfSameExpiredCore(canonicalRoot, persisted.lease.leaseId, nowMs);
      if (!reclaimed) {
        // Lease changed between the read and the reclaim (different leaseId
        // or no longer expired): never remove — honor the fresh state.
        const fresh = readPersistedLease(canonicalRoot, nowMs);
        if (fresh.kind === "valid") {
          activeLeases.set(canonicalRoot, fresh.lease);
          return { acquired: false, reason: `workspace already leased at "${canonicalRoot}"` };
        }
        if (fresh.kind === "unreadable") {
          return { acquired: false, reason: `lease file conflict at ${leasePath(canonicalRoot)}: ${fresh.reason}` };
        }
        if (fresh.kind === "expired") {
          return { acquired: false, reason: `stale lease file could not be reclaimed at ${leasePath(canonicalRoot)}` };
        }
        // Missing: the stale file vanished under us — proceed to create below.
      }
    }

    let fencingToken: number;
    try {
      // Nested fence-counter lock; order is always lease-lock -> fence-lock.
      fencingToken = nextFencingToken(canonicalRoot);
    } catch (error) {
      return { acquired: false, reason: (error as Error).message };
    }

    const lease: MutationLeaseRecord = {
      leaseId: randomUUID(),
      fencingToken,
      goalId,
      assignmentId,
      sessionId,
      workerProcessIdentity: opts.workerProcessIdentity ?? `${process.pid}`,
      canonicalWorkspaceRoot: canonicalRoot,
      allowedCanonicalPaths,
      baseRevision,
      baseDirtySignature,
      planEpoch,
      phase: "ACQUIRED",
      acquiredAt: isoNow(nowMs),
      heartbeatAt: isoNow(nowMs),
      expiresAt: new Date(nowMs + ttlMs).toISOString() as ISO8601,
    };

    if (!atomicCreateLeaseFile(canonicalRoot, lease)) {
      // Lost the race (same-process direct file write): adopt winner's state.
      const winner = readPersistedLease(canonicalRoot, Date.now());
      if (winner.kind === "valid") activeLeases.set(canonicalRoot, winner.lease);
      return { acquired: false, reason: `workspace already leased at "${canonicalRoot}"` };
    }

    activeLeases.set(canonicalRoot, lease);
    return { acquired: true, lease };
  });
}

export function releaseLease(root: string, leaseId: string): boolean {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch {
    return false;
  }
  const cached = activeLeases.get(canonicalRoot);
  if (cached && cached.leaseId !== leaseId) return false;

  // Serialize verify-then-remove under the lease lock so a concurrent
  // reclaim/acquire cannot interleave between the identity check and unlink.
  // Only remove the file when it holds our lease (fail closed on unreadable).
  return withLock(leaseLockBase(canonicalRoot), () => {
    const persisted = readPersistedLease(canonicalRoot);
    if (persisted.kind === "valid" || persisted.kind === "expired") {
      if (persisted.lease.leaseId !== leaseId) {
        if (persisted.kind === "valid") activeLeases.set(canonicalRoot, persisted.lease);
        return false;
      }
    } else if (persisted.kind === "unreadable") {
      return false;
    } else if (persisted.kind === "missing" && !cached) {
      return false;
    }

    activeLeases.delete(canonicalRoot);
    try {
      fs.rmSync(leasePath(canonicalRoot), { force: true });
    } catch {
      return false;
    }
    return true;
  });
}

/** Typed CONFLICT state: the root is not usable and must not be treated as free. */
export type LeaseConflict = { conflict: true; reason: string };

/** Narrow a checkLease result to the active lease (null on free or conflict). */
export function asActiveLease(result: MutationLeaseRecord | LeaseConflict | null): MutationLeaseRecord | null {
  if (result !== null && typeof result === "object" && "conflict" in result) return null;
  return result;
}

/**
 * Return the active lease for a root, null when free, or a typed CONFLICT
 * when the root is unresolvable or the lease file is unreadable — never
 * null-as-free for unreadable state.
 */
/**
 * Lock-free core of checkLease: read the active lease for an already
 * canonical root, reclaiming a stale file only when it still holds the same
 * expired leaseId. Callers must hold the lease lock.
 */
function checkLeaseCore(
  canonicalRoot: string,
  nowMs: number,
): MutationLeaseRecord | LeaseConflict | null {
  const cached = activeLeases.get(canonicalRoot);
  if (cached) {
    if (msOf(cached.expiresAt) <= nowMs) {
      activeLeases.delete(canonicalRoot);
      // Guarded reclaim: only remove the disk file when it still holds this
      // same expired lease — a fresh lease created after our stale read
      // survives, and we fall through to report it below.
      reclaimIfSameExpiredCore(canonicalRoot, cached.leaseId, nowMs);
    } else {
      return cached;
    }
  }
  const persisted = readPersistedLease(canonicalRoot, nowMs);
  if (persisted.kind === "valid") {
    activeLeases.set(canonicalRoot, persisted.lease);
    return persisted.lease;
  }
  if (persisted.kind === "unreadable") {
    return { conflict: true, reason: persisted.reason };
  }
  if (persisted.kind === "expired") {
    // Same guarded reclaim: never delete a lease that changed (different
    // leaseId or no longer expired) — honor the fresh state instead.
    const reclaimed = reclaimIfSameExpiredCore(canonicalRoot, persisted.lease.leaseId, nowMs);
    if (!reclaimed) {
      const fresh = readPersistedLease(canonicalRoot, nowMs);
      if (fresh.kind === "valid") {
        activeLeases.set(canonicalRoot, fresh.lease);
        return fresh.lease;
      }
      if (fresh.kind === "unreadable") {
        return { conflict: true, reason: fresh.reason };
      }
    }
  }
  // "missing" reports null (free). Unreadable is handled above as CONFLICT.
  return null;
}

/**
 * Read the active lease for a root. Serialized under the lease lock so
 * concurrent reclaim/release/acquire/heartbeat/advance cannot interleave
 * between the read and any stale-file cleanup.
 */
export function checkLease(root: string, now?: number): MutationLeaseRecord | LeaseConflict | null {
  const nowMs = now ?? Date.now();
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch (error) {
    return { conflict: true, reason: (error as Error).message };
  }
  return withLock(leaseLockBase(canonicalRoot), () => checkLeaseCore(canonicalRoot, nowMs));
}

/** Renew expiry on a lease owned by leaseId. Returns the renewed lease or null. */
export function heartbeatLease(
  root: string,
  leaseId: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now?: number,
): MutationLeaseRecord | null {
  const nowMs = now ?? Date.now();
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch {
    return null;
  }
  // Read-modify-write holds the lease lock: no concurrent reclaim, release,
  // or acquire can interleave between the check and the overwrite. The
  // renewed record derives from the in-lock re-read, never a stale read.
  return withLock(leaseLockBase(canonicalRoot), () => {
    const fresh = asActiveLease(checkLeaseCore(canonicalRoot, nowMs));
    if (!fresh || fresh.leaseId !== leaseId) return null;
    const renewed: MutationLeaseRecord = {
      ...fresh,
      heartbeatAt: isoNow(nowMs),
      expiresAt: new Date(nowMs + ttlMs).toISOString() as ISO8601,
    };
    overwriteLeaseFile(canonicalRoot, renewed);
    activeLeases.set(canonicalRoot, renewed);
    return renewed;
  });
}

const PHASE_ORDER: readonly MutationLeasePhase[] = ["ACQUIRED", "AUTHORITY_READY", "MUTATING", "SETTLING"];

/** Advance a lease one phase forward (staying in place is allowed). */
export function advanceLeasePhase(
  root: string,
  leaseId: string,
  toPhase: MutationLeasePhase,
  now?: number,
  extra?: { authorityReceiptRef?: ArtifactRef; approvalRef?: ArtifactRef },
): LeasePhaseTransition {
  const nowMs = now ?? Date.now();
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeRoot(root);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  // Read-modify-write holds the lease lock: no concurrent reclaim, release,
  // heartbeat, or advance can interleave between the check and the overwrite.
  return withLock(leaseLockBase(canonicalRoot), () => {
    const current = asActiveLease(checkLeaseCore(canonicalRoot, nowMs));
    if (!current || current.leaseId !== leaseId) {
      return { ok: false, reason: "no active lease held by caller" };
    }
    const fromIdx = PHASE_ORDER.indexOf(current.phase);
    const toIdx = PHASE_ORDER.indexOf(toPhase);
    if (fromIdx === -1 || toIdx === -1) {
      return { ok: false, reason: `unknown phase transition ${current.phase} -> ${toPhase}` };
    }
    if (toIdx !== fromIdx && toIdx !== fromIdx + 1) {
      return { ok: false, reason: `illegal phase transition ${current.phase} -> ${toPhase}` };
    }
    const next: MutationLeaseRecord = {
      ...current,
      phase: toPhase,
      heartbeatAt: isoNow(nowMs),
      ...(extra?.authorityReceiptRef ? { authorityReceiptRef: extra.authorityReceiptRef } : {}),
      ...(extra?.approvalRef ? { approvalRef: extra.approvalRef } : {}),
    };
    overwriteLeaseFile(canonicalRoot, next);
    activeLeases.set(canonicalRoot, next);
    return { ok: true, lease: next };
  });
}

/** Clear in-process cache only; disk files survive. Test-only two-process simulator. */
export function _clearMemoryOnly(): void {
  activeLeases.clear();
}

/** Clear memory and delete known disk files. Test-only. */
export function _resetLeases(): void {
  for (const [root] of activeLeases) {
    try {
      fs.rmSync(leasePath(root), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
  activeLeases.clear();
}
