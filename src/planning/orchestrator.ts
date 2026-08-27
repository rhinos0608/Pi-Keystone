// Planning orchestrator — creates provisional plan and reconciles against baseline.
// Returns either a plan ready for contract, or a replan/block decision.

import type { GoalRecord } from "../domain/types.js";
import type { BaselineRecord } from "../baseline/types.js";
import { createProvisionalPlan } from "./provisional-plan.js";
import { reconcile, type BaselineResults, type ProvisionalPlan as ReconPlan } from "./reconciliation.js";

export type PlanningResult =
  | { plan: import("./provisional-plan.js").ProvisionalPlan }
  | { decision: "replan" | "block"; reason: string };

/**
 * Run planning phase: create a provisional plan then reconcile it against baseline.
 * Maps baseline checks to reconciliation tasks and dirty paths.
 */
export async function runPlanning(
  goal: GoalRecord,
  baseline: BaselineRecord,
): Promise<PlanningResult> {
  // Convert BaselineRecord.checks → BaselineResults.tasks for reconciliation
  const results: BaselineResults = baselineToResults(baseline);

  // Build a minimal contract for createProvisionalPlan
  const contract: import("./provisional-plan.js").GoalContract = {
    goalId: goal.goalId,
    version: 1,
    criteria: results.tasks.map((t, i) => ({
      id: `c-${i}`,
      description: t.taskName,
    })),
  };

  // Build assignments from baseline failures
  const assignments: import("./provisional-plan.js").PlanAssignment[] = [];
  for (const task of results.tasks) {
    if (task.status === "failed") {
      assignments.push({
        id: `a-${task.taskName}`,
        description: `Fix failing task: ${task.taskName}`,
        targetFiles: task.filePaths,
        role: "repair",
        acceptanceCriteria: [`c-${task.taskName}`],
      });
    }
  }

  // If nothing failed, create a generic no-op assignment
  if (assignments.length === 0) {
    assignments.push({
      id: "a-verify",
      description: "All baseline checks pass — verify no regression",
      targetFiles: [],
      role: "verification",
      acceptanceCriteria: [],
    });
  }

  const plan = createProvisionalPlan({ contract, baseline: results, assignments });

  // Map to reconciliation's ProvisionalPlan shape
  const reconPlan: ReconPlan = {
    actions: assignments.map((a) => ({
      actionName: a.description,
      targetFiles: a.targetFiles,
    })),
  };

  const dirtyFiles = new Set(baseline.worktree.dirtyPaths.map((d) => d.path));

  const reconcileResult = reconcile(results, reconPlan, dirtyFiles, goal.planEpoch);

  if (reconcileResult.decision === "accept") {
    return { plan };
  }

  return {
    decision: reconcileResult.decision === "block" ? "block" : "replan",
    reason: reconcileResult.reason,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function baselineToResults(baseline: BaselineRecord): BaselineResults {
  const verificationPassed = baseline.checks.every((c) => c.outcome === "PASS" || c.outcome === "SKIPPED");
  return {
    tasks: baseline.checks.map((c) => ({
      taskName: c.command,
      filePaths: [c.cwd],
      status: c.outcome === "PASS" ? "succeeded" as const
        : c.outcome === "SKIPPED" ? "skipped" as const
        : "failed" as const,
      diagnostics: c.stderr ? [c.stderr.slice(0, 512)] : undefined,
    })),
    verificationPassed,
  };
}
