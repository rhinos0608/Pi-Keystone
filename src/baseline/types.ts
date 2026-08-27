/**
 * Frozen baseline types — Phase 5 schema-freeze.
 * Source of truth: ARCHITECTURE.md §3E (Baseline system), §3L (Deterministic verification).
 *
 * This module defines the check outcome enum, individual check records,
 * worktree state capture, and the top-level baseline record.
 */

// ---------------------------------------------------------------------------
// CheckOutcome
// ---------------------------------------------------------------------------

/** Outcome of a single check attempt or aggregated check run. */
export enum CheckOutcome {
  PASS = "PASS",
  FAIL = "FAIL",
  FLAKY = "FLAKY",
  SKIPPED = "SKIPPED",
  UNAVAILABLE = "UNAVAILABLE",
  TIMEOUT = "TIMEOUT",
}

// ---------------------------------------------------------------------------
// CheckRecord
// ---------------------------------------------------------------------------

/** Frozen record for a single baseline check. */
export type CheckRecord = {
  /** Human-readable or machine-parseable command that was run. */
  readonly command: string;

  /** Working directory the command executed in (absolute path). */
  readonly cwd: string;

  /** Aggregated outcome after retries. */
  readonly outcome: CheckOutcome;

  /** Process exit code; null when the process never launched or was killed by signal. */
  readonly exitCode: number | null;

  /** Captured stdout, truncated to a bounded budget. */
  readonly stdout: string;

  /** Captured stderr, truncated to a bounded budget. */
  readonly stderr: string;

  /** Wall-clock duration in milliseconds. */
  readonly duration: number;

  /** Whether this check was retried (retry count >= 1). */
  readonly retried: boolean;

  /** Content-addressed fingerprint for failure deduplication (SHA-256); null on PASS. */
  readonly fingerprint: string | null;
};

// ---------------------------------------------------------------------------
// BaselineWorktreeState
// ---------------------------------------------------------------------------

/** Git porcelain status code for a single dirty path. */
export type DirtyPathStatus =
  | "M"   // modified
  | "A"   // added
  | "D"   // deleted
  | "R"   // renamed
  | "C"   // copied
  | "??"; // untracked

/** A single entry in the dirty-worktree inventory. */
export type DirtyPath = {
  /** Repo-relative path. */
  readonly path: string;

  /** Git porcelain status code. */
  readonly status: DirtyPathStatus;

  /** Content SHA-256 when hashed; absent when over budget or unreadable. */
  readonly contentHash?: string;
};

/** Snapshot of the working tree at baseline capture time. */
export type BaselineWorktreeState = {
  /** Absolute path to the git repository root. */
  readonly gitRoot: string;

  /** Current branch name; absent in detached-HEAD state. */
  readonly branch?: string;

  /** HEAD commit SHA at capture time. */
  readonly headCommit: string;

  /** All dirty paths with their porcelain status codes. */
  readonly dirtyPaths: readonly DirtyPath[];

  /** Maximum total bytes used for content hashing. */
  readonly contentHashBudget: number;
};

// ---------------------------------------------------------------------------
// BaselineRecord
// ---------------------------------------------------------------------------

/** Top-level baseline record stored in GoalStore before contract freeze. */
export type BaselineRecord = {
  /** Goal this baseline belongs to. */
  readonly goalId: string;

  /** Workspace identity or canonical root. */
  readonly workspace: string;

  /** Worktree state captured at baseline time. */
  readonly worktree: BaselineWorktreeState;

  /** All checks executed during baseline. */
  readonly checks: readonly CheckRecord[];

  /** Environment fingerprint (OS, runtime, tool versions). */
  readonly environment: string;

  /** ISO-8601 timestamp of baseline capture. */
  readonly createdAt: string;
};
