// Baseline orchestrator — captures worktree state + runs tier-0 checks.
// Returns a frozen BaselineRecord for downstream reconciliation.

import type { GoalRecord } from "../domain/types.js";
import type { BaselineRecord, CheckRecord as FrozenCheckRecord, CheckOutcome } from "./types.js";
import { runCheck, type CheckRecord as RunCheckInput } from "./runner.js";
import { getWorktreeState } from "./worktree.js";

/** Default tier-0 check commands run against the workspace. */
const TIER_ZERO_CHECKS: Array<{ label: string; command: string; args: string[] }> = [
  { label: "typecheck", command: "npx", args: ["tsc", "--noEmit"] },
  { label: "test", command: "npx", args: ["vitest", "run", "--reporter=dot"] },
  { label: "lint", command: "npx", args: ["eslint", "--max-warnings=0", "."] },
];

/**
 * Run baseline: capture worktree + execute tier-0 checks.
 * Individual check failures do not abort; all outcomes are recorded.
 */
export async function runBaseline(goal: GoalRecord): Promise<BaselineRecord> {
  const root = goal.workspace.canonicalRoot;
  const worktree = getWorktreeState(root);

  const frozenChecks: FrozenCheckRecord[] = [];

  for (const spec of TIER_ZERO_CHECKS) {
    const input: RunCheckInput = {
      command: spec.command,
      args: spec.args,
      cwd: root,
      maxMs: 60_000,
    };

    const result = await runCheck(input);

    frozenChecks.push({
      command: `${spec.command} ${spec.args.join(" ")}`,
      cwd: root,
      outcome: result.outcome as CheckOutcome,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 8_192),
      stderr: result.stderr.slice(0, 8_192),
      duration: result.duration,
      retried: false,
      fingerprint: null,
    });
  }

  return {
    goalId: goal.goalId,
    workspace: root,
    worktree,
    checks: frozenChecks,
    environment: `${process.platform} ${process.arch} node-${process.version}`,
    createdAt: new Date().toISOString(),
  };
}
