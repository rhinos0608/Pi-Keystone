// Human-readable phase transition strings for goal progress display.

import type { GoalRecord, GoalState } from "../domain/types.js";

export type GoalProgress = {
  phase: GoalState;
  message: string;
  timestamp: string;
};

/**
 * Format a goal record into a human-readable progress message
 * reflecting the current lifecycle phase.
 */
export function formatProgress(goal: GoalRecord): GoalProgress {
  return {
    phase: goal.state,
    message: describePhase(goal),
    timestamp: goal.updatedAt,
  };
}

function describePhase(goal: GoalRecord): string {
  switch (goal.state) {
    case "CREATED":
      return "Goal created";
    case "PREPARING":
      return describePreparing(goal);
    case "RECONCILING":
      return "Baseline reconciled";
    case "CONTRACT_REVIEW":
      return "Contract under review";
    case "READY":
      return "Contract frozen";
    case "EXECUTING":
      return `Execution phase · contract v${goal.contractVersion ?? 1}`;
    case "VERIFYING":
      return "Verifying changes";
    case "REVIEWING":
      return "Reviewing results";
    case "ADJUDICATING":
      return "Adjudicating findings";
    case "REPAIRING":
      return `Repairing · attempt ${goal.repairCycles}`;
    case "FINAL_AUDIT":
      return "Final audit in progress";
    case "COMPLETION_GATE":
      return "Evaluating completion";
    case "PAUSED":
      return goal.pauseReason ? `Paused — ${goal.pauseReason}` : "Paused";
    case "CANCELLING":
      return "Cancelling…";
    case "DONE":
      return "Goal completed";
    case "BLOCKED":
      return "Goal blocked";
    case "FAILED":
      return "Goal failed";
    case "NON_CONVERGENT":
      return `Non-convergent after ${goal.reviewCycles} review cycles`;
    case "CANCELLED":
      return "Goal cancelled";
  }
}

function describePreparing(goal: GoalRecord): string {
  const { baselineJob, provisionalPlanJob } = goal.preparation;
  if (baselineJob.status === "FAILED" || provisionalPlanJob.status === "FAILED") {
    return "Preparation failed";
  }
  if (baselineJob.status === "SUCCEEDED" && provisionalPlanJob.status === "SUCCEEDED") {
    return "Preparation complete";
  }
  return "Preparing baseline and plan";
}
