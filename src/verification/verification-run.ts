/**
 * Verification runner — executes ordered checks, compares against baseline,
 * and produces a VerificationResult with baseline-relative status mapping.
 *
 * Status mapping: PASS→FAIL = regression (blocks acceptance).
 * Any non-PASS in `after` that was PASS in `before` is a regression.
 */

import {
  runCheck,
  type CheckRecord as RunCheckInput,
  type CheckResult,
  type CheckOutcome as RunCheckOutcome,
} from "../baseline/runner.js";
import {
  compareBaseline,
  type Disposition,
} from "../baseline/compare.js";
import { computeFingerprint } from "../baseline/failure-fingerprint.js";
import {
  CheckOutcome as FrozenOutcome,
  type BaselineRecord,
  type CheckRecord as FrozenCheck,
} from "../baseline/types.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type VerificationStatus = "PASS" | "FAIL" | "NO_BASELINE";

export type CheckVerification = {
  readonly command: string;
  readonly outcome: RunCheckOutcome;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly duration: number;
  readonly fingerprint: string | null;
  /** true if this check regressed relative to baseline */
  readonly regression: boolean;
};

export type VerificationResult = {
  readonly status: VerificationStatus;
  readonly checks: readonly CheckVerification[];
  readonly disposition: Disposition;
  readonly regressionCount: number;
  readonly improvementCount: number;
  readonly summary: string;
};

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Run ordered checks and compare results against a baseline.
 */
export async function runVerification(
  goal: string,
  checks: readonly RunCheckInput[],
  baseline: BaselineRecord | null,
): Promise<VerificationResult> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check));
  }

  // Build frozen CheckRecords from run results for comparison.
  // Cast runner CheckOutcome → frozen CheckOutcome (string values match).
  const afterRecords: FrozenCheck[] = results.map((r, i): FrozenCheck => ({
    command: checks[i].command,
    cwd: checks[i].cwd,
    outcome: r.outcome as unknown as FrozenOutcome,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    duration: r.duration,
    retried: false,
    fingerprint: r.outcome !== "PASS"
      ? computeFingerprint({ command: checks[i].command, stderr: r.stderr, exitCode: r.exitCode ?? 1 })
      : null,
  }));

  // If no baseline, no regressions possible
  if (!baseline) {
    const checkVerifications: CheckVerification[] = afterRecords.map((r): CheckVerification => ({
      command: r.command,
      outcome: r.outcome as unknown as RunCheckOutcome,
      exitCode: r.exitCode,
      stderr: r.stderr,
      duration: r.duration,
      fingerprint: r.fingerprint,
      regression: false,
    }));

    return {
      status: "NO_BASELINE",
      checks: checkVerifications,
      disposition: "clean",
      regressionCount: 0,
      improvementCount: 0,
      summary: `${goal}: no baseline available, all checks executed`,
    };
  }

  // Compare against baseline
  const afterBaseline: BaselineRecord = {
    goalId: baseline.goalId,
    workspace: baseline.workspace,
    worktree: baseline.worktree,
    checks: afterRecords,
    environment: baseline.environment,
    createdAt: new Date().toISOString(),
  };
  const delta = compareBaseline(baseline, afterBaseline);

  const regressionCommands = new Set(delta.regressions.map((r) => r.command));

  const checkVerifications: CheckVerification[] = afterRecords.map((r): CheckVerification => ({
    command: r.command,
    outcome: r.outcome as unknown as RunCheckOutcome,
    exitCode: r.exitCode,
    stderr: r.stderr,
    duration: r.duration,
    fingerprint: r.fingerprint,
    regression: regressionCommands.has(r.command),
  }));

  const regressionCount = delta.regressions.length;
  const improvementCount = delta.improvements.length;
  const status: VerificationStatus = regressionCount > 0 ? "FAIL" : "PASS";

  const summary = [
    `${goal}: ${status}`,
    `${checkVerifications.length} checks, ${regressionCount} regression(s), ${improvementCount} improvement(s)`,
  ].join("; ");

  return {
    status,
    checks: checkVerifications,
    disposition: delta.disposition,
    regressionCount,
    improvementCount,
    summary,
  };
}
