/**
 * Baseline comparison — diffs two frozen BaselineRecords by check outcome.
 *
 * Identity matching:
 *   - Failed checks match by fingerprint (SHA-256 dedup from failure-fingerprint.ts)
 *   - Passed checks match by command string
 *   - Any check present in `after` but absent in `before` is treated as a new failure
 *     when its outcome is non-PASS
 */

import {
  CheckOutcome,
  type BaselineRecord,
  type CheckRecord,
} from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type CheckDelta = {
  /** Check command (human-readable). */
  readonly command: string;
  /** Outcome in the `before` baseline. */
  readonly beforeOutcome: CheckOutcome;
  /** Outcome in the `after` baseline. */
  readonly afterOutcome: CheckOutcome;
  /** Fingerprint used for identity matching (null if not a failure). */
  readonly fingerprint: string | null;
  /** Exit code in `before`; null if process never launched. */
  readonly beforeExitCode: number | null;
  /** Exit code in `after`; null if process never launched. */
  readonly afterExitCode: number | null;
};

export type Disposition = "clean" | "regression" | "mixed";

export type BaselineDelta = {
  readonly regressions: readonly CheckDelta[];
  readonly improvements: readonly CheckDelta[];
  readonly unchanged: readonly CheckDelta[];
  readonly disposition: Disposition;
};

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Compare two baseline records and classify every check.
 *
 * Checks are matched first by fingerprint (for failures), then by command.
 * A regression is: before=PASS → after=non-PASS.
 * An improvement is: before=non-PASS → after=PASS.
 * Everything else is unchanged.
 */
export function compareBaseline(
  before: BaselineRecord,
  after: BaselineRecord,
): BaselineDelta {
  const regressions: CheckDelta[] = [];
  const improvements: CheckDelta[] = [];
  const unchanged: CheckDelta[] = [];

  // Build lookup for `before` checks — fingerprint → CheckRecord, then command → CheckRecord
  const beforeByFingerprint = new Map<string, CheckRecord>();
  const beforeByCommand = new Map<string, CheckRecord>();
  for (const rec of before.checks) {
    if (rec.fingerprint) {
      beforeByFingerprint.set(rec.fingerprint, rec);
    }
    beforeByCommand.set(rec.command, rec);
  }

  const matchedBeforeCommands = new Set<string>();

  for (const afterRec of after.checks) {
    let matchedBeforeRec: CheckRecord | undefined;

    // Fingerprint identity first (for failures)
    if (afterRec.fingerprint) {
      matchedBeforeRec = beforeByFingerprint.get(afterRec.fingerprint);
    }
    // Then command string
    if (!matchedBeforeRec) {
      matchedBeforeRec = beforeByCommand.get(afterRec.command);
    }

    if (matchedBeforeRec) {
      matchedBeforeCommands.add(matchedBeforeRec.command);
      const delta: CheckDelta = {
        command: afterRec.command,
        beforeOutcome: matchedBeforeRec.outcome,
        afterOutcome: afterRec.outcome,
        fingerprint: afterRec.fingerprint,
        beforeExitCode: matchedBeforeRec.exitCode,
        afterExitCode: afterRec.exitCode,
      };

      if (isRegression(matchedBeforeRec.outcome, afterRec.outcome)) {
        regressions.push(delta);
      } else if (isImprovement(matchedBeforeRec.outcome, afterRec.outcome)) {
        improvements.push(delta);
      } else {
        unchanged.push(delta);
      }
    } else {
      // New check in `after` — not in `before`
      const delta: CheckDelta = {
        command: afterRec.command,
        beforeOutcome: CheckOutcome.SKIPPED,
        afterOutcome: afterRec.outcome,
        fingerprint: afterRec.fingerprint,
        beforeExitCode: null,
        afterExitCode: afterRec.exitCode,
      };

      if (!isPassOutcome(afterRec.outcome)) {
        regressions.push(delta);
      } else {
        unchanged.push(delta);
      }
    }
  }

  // Checks in `before` absent from `after` — count as regressions only if they were passing
  for (const beforeRec of before.checks) {
    if (matchedBeforeCommands.has(beforeRec.command)) continue;
    // Check if after has a check matching this fingerprint
    if (beforeRec.fingerprint) {
      const afterMatch = after.checks.some(
        (r) => r.fingerprint === beforeRec.fingerprint,
      );
      if (afterMatch) continue;
    }

    const delta: CheckDelta = {
      command: beforeRec.command,
      beforeOutcome: beforeRec.outcome,
      afterOutcome: CheckOutcome.SKIPPED,
      fingerprint: beforeRec.fingerprint,
      beforeExitCode: beforeRec.exitCode,
      afterExitCode: null,
    };

    if (isPassOutcome(beforeRec.outcome)) {
      regressions.push(delta); // was passing, now gone = regression
    } else {
      unchanged.push(delta);
    }
  }

  const disposition: Disposition =
    regressions.length > 0 && improvements.length > 0
      ? "mixed"
      : regressions.length > 0
        ? "regression"
        : "clean";

  return { regressions, improvements, unchanged, disposition };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** PASS → non-PASS is a regression. */
function isRegression(before: CheckOutcome, after: CheckOutcome): boolean {
  return isPassOutcome(before) && !isPassOutcome(after);
}

/** non-PASS → PASS is an improvement. */
function isImprovement(before: CheckOutcome, after: CheckOutcome): boolean {
  return !isPassOutcome(before) && isPassOutcome(after);
}

function isPassOutcome(o: CheckOutcome): boolean {
  return o === CheckOutcome.PASS;
}
