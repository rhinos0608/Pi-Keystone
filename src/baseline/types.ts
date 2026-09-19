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

// ---------------------------------------------------------------------------
// Task 6 (Wave 2e): ecosystem discovery + per-check baseline
// ---------------------------------------------------------------------------
//
// Additive to the frozen schema above. The frozen BaselineRecord stays the
// canonical persisted shape; the types below describe JS/TS ecosystem
// detection, per-check execution results, and content-hashed failure
// fingerprints used to build the pre-existing damage ledger.

/** JS/TS package manager detected from lockfiles. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** Conventional script names mapped to check roles (presence-based). */
export type EcosystemScripts = {
  readonly typecheck?: string;
  readonly test?: string;
  readonly lint?: string;
};

/** Result of detectEcosystem(root): scripts + versions + manager. */
export type EcosystemInfo = {
  /** Absolute workspace root that was inspected. */
  readonly root: string;
  /** Detected package manager ("unknown" when no package.json). */
  readonly packageManager: PackageManager;
  /** Mapped script names; absent role means the check is UNAVAILABLE. */
  readonly scripts: EcosystemScripts;
  /** Best-effort tool versions keyed by tool name (e.g. tsc, vitest). */
  readonly toolVersions: Readonly<Record<string, string>>;
  /** False when no package.json exists at root. */
  readonly hasPackageJson: boolean;
};

/** Check roles executed for an ecosystem baseline. */
export type EcosystemCheckId = "typecheck" | "test" | "lint";

/** Per-check execution result with status + exit + duration + version. */
export type EcosystemCheckResult = {
  readonly checkId: EcosystemCheckId;
  /** Aggregated outcome after at most one retry. */
  readonly status: "PASS" | "FAIL" | "FLAKY" | "SKIPPED" | "UNAVAILABLE" | "TIMEOUT";
  /** Command line that was executed (human-readable). */
  readonly command: string;
  /** Process exit code; null when never launched or killed. */
  readonly exitCode: number | null;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Best-effort `--version` capture; null when unavailable. */
  readonly version: string | null;
  /** Whether the check was retried (retry count >= 1). */
  readonly retried: boolean;
};

/** Single parsed failure with content hash for later comparison. */
export type FailureFingerprint = {
  /** Content hash (sha256 of checkId + file + line + diagnostic). */
  readonly id: string;
  readonly checkId: EcosystemCheckId | string;
  readonly file: string;
  readonly line?: number;
  readonly diagnostic: string;
  /** Duplicate of id; kept so hashes travel with the record. */
  readonly hash: string;
};

/** Worktree path inventory for the ecosystem baseline record. */
export type EcosystemWorktreeSummary = {
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
};

/** Task 6 baseline record: revision + dirt + per-check results + ledger. */
export type EcosystemBaseline = {
  /** HEAD commit SHA at capture time ("unknown" when not a git repo). */
  readonly revision: string;
  /** Hash of normalized worktree status; drifts invalidate approvals. */
  readonly dirtySignature: string;
  readonly worktree: EcosystemWorktreeSummary;
  /** Per-check results; test/lint absent when no script maps to them. */
  readonly checks: {
    readonly typecheck: EcosystemCheckResult;
    readonly test?: EcosystemCheckResult;
    readonly lint?: EcosystemCheckResult;
  };
  readonly failureFingerprints: readonly FailureFingerprint[];
  /** Fingerprint id → content hash (equals the id; explicit for join). */
  readonly contentHashes: Readonly<Record<string, string>>;
  readonly capturedAt: string;
};
