// Mutation approval gate — collision-only approval bound to
// dirtySignature + planEpoch + intended write-set.
//
// ENFORCEMENT: evaluateApproval is wired into the production mutation flow
// via acquireAuthority (src/execution/mutation-launcher.ts) — the sole
// production callsite advancing ACQUIRED -> AUTHORITY_READY. APPROVED alone
// is not authority; only the phase advance it gates confers launchability.
//
// An approval is granted against a snapshot. It goes STALE when the world
// drifts (dirtySignature or planEpoch change), when it expires (15min
// default), or when the goal/assignment binding mismatches (replay across
// goals or assignments is rejected). It goes CONFLICT when the actual
// write-set exceeds the approved intent or fresh dirt collides with it.
// Lease validity is checked separately by the mutation launcher.

import * as path from "node:path";
import type { WorkspaceSnapshot } from "../baseline/snapshot.js";
import { conflictMatrix, type DirtyConflict } from "../baseline/snapshot.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Default approval lifetime: 15 minutes. */
export const APPROVAL_TTL_MS = 15 * 60 * 1_000;

export type MutationApproval = {
  goalId: string;
  planEpoch: number;
  assignmentId: string;
  dirtySignature: string;
  intendedWriteSet: string[];
  conflicts: DirtyConflict[];
  approvedAt: string;
  /** ISO8601 expiry; approvals past expiry evaluate STALE. */
  expiresAt: string;
};

export type ApprovalResult =
  | { status: "APPROVED" }
  | { status: "STALE"; reason: string }
  | { status: "CONFLICT"; reason: string; conflicts: DirtyConflict[] };

export type CreateApprovalOptions = {
  goalId: string;
  planEpoch: number;
  assignmentId: string;
  snapshot: WorkspaceSnapshot;
  intendedWriteSet: string[];
  /** Workspace root for absolute/relative collision normalization. */
  workspaceRoot?: string;
  approvedAt?: string;
  /** Lifetime override (ms); defaults to APPROVAL_TTL_MS. */
  ttlMs?: number;
  /** Explicit expiry override (wins over ttlMs). */
  expiresAt?: string;
};

export type EvaluateApprovalOptions = {
  /** Goal this evaluation serves — must match approval.goalId (anti-replay). */
  goalId: string;
  /** Assignment this evaluation serves — must match approval.assignmentId. */
  assignmentId: string;
  /** Workspace root both sides are relativized against before compare. */
  workspaceRoot?: string;
  /** Clock override (tests). */
  nowMs?: number;
};

// ─── API ────────────────────────────────────────────────────────────────────

/** Record an approval against the dirt visible in `snapshot`. */
export function createApproval(opts: CreateApprovalOptions): MutationApproval {
  const { conflicts } = conflictMatrix(opts.snapshot, opts.intendedWriteSet, opts.workspaceRoot);
  const approvedAt = opts.approvedAt ?? new Date().toISOString();
  const expiresAt =
    opts.expiresAt ?? new Date(Date.parse(approvedAt) + (opts.ttlMs ?? APPROVAL_TTL_MS)).toISOString();
  return {
    goalId: opts.goalId,
    planEpoch: opts.planEpoch,
    assignmentId: opts.assignmentId,
    dirtySignature: opts.snapshot.dirtySignature,
    intendedWriteSet: [...opts.intendedWriteSet].sort(),
    conflicts,
    approvedAt,
    expiresAt,
  };
}

/**
 * Relativize both sides against the workspace root before compare, so an
 * absolute entry and a relative entry naming the same file compare equal.
 * Without a root, falls back to separator/leading-`./` normalization.
 */
function normalize(entry: string, workspaceRoot?: string): string {
  let p = entry.replace(/\\/g, "/");
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
    else if (p === root) p = "";
  }
  if (p.startsWith("./")) p = p.slice(2);
  // Collapse `.`/`..` lexically so `src/../src/a.ts` equals `src/a.ts`.
  p = path.posix.normalize(p);
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

/**
 * Evaluate an approval against the current world:
 * - STALE when goal/assignment binding mismatches (replay), planEpoch
 *   drifts, dirtySignature drifts, or the approval expired.
 * - CONFLICT when actualWriteSet is not a subset of the approved intent.
 * - APPROVED otherwise, including dirty collisions that were present in the
 *   snapshot the user approved. dirtySignature equality proves that collision
 *   set/content has not drifted since approval.
 */
export function evaluateApproval(
  approval: MutationApproval,
  currentSnapshot: WorkspaceSnapshot,
  planEpoch: number,
  actualWriteSet: string[],
  opts: EvaluateApprovalOptions,
): ApprovalResult {
  if (opts.goalId !== approval.goalId) {
    return {
      status: "STALE",
      reason: `goalId mismatch: approved for ${approval.goalId}, evaluated for ${opts.goalId}`,
    };
  }
  if (opts.assignmentId !== approval.assignmentId) {
    return {
      status: "STALE",
      reason: `assignmentId mismatch: approved for ${approval.assignmentId}, evaluated for ${opts.assignmentId}`,
    };
  }
  const now = opts.nowMs ?? Date.now();
  const expires = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    return {
      status: "STALE",
      reason: `approval expired at ${approval.expiresAt}`,
    };
  }
  if (planEpoch !== approval.planEpoch) {
    return {
      status: "STALE",
      reason: `planEpoch drift: approved at ${approval.planEpoch}, current is ${planEpoch}`,
    };
  }
  if (currentSnapshot.dirtySignature !== approval.dirtySignature) {
    return {
      status: "STALE",
      reason: "dirtySignature drift: worktree changed since approval",
    };
  }
  const root = opts.workspaceRoot;
  const intended = new Set(approval.intendedWriteSet.map((e) => normalize(e, root)));
  const excess = actualWriteSet.map((e) => normalize(e, root)).filter((p) => !intended.has(p));
  if (excess.length > 0) {
    return {
      status: "CONFLICT",
      reason: `actual write-set exceeds approved intent: ${[...new Set(excess)].sort().join(", ")}`,
      conflicts: excess.map((p) => ({ path: p, kind: "untracked" as const })),
    };
  }
  // Collision-only approval: createApproval records the dirt visible at
  // approval time. Because dirtySignature is content-addressed and matched
  // above, any collision that still exists here is the exact dirt the user
  // approved, not a fresh conflict. Re-checking conflictMatrix here and
  // rejecting it would make dirty-collision approval impossible by design.
  return { status: "APPROVED" };
}
