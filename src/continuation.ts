// Goal continuation after compaction.
// Resumes from GoalStore, rebuilds context, dispatches next assignment.

import type { GoalRecord, GoalId, GoalState } from "./domain/types.js";
import { GoalStore } from "./store/goal-store.js";

/** States that can be resumed after compaction. */
const RESUMABLE_STATES = new Set<GoalState>([
  "CREATED",
  "PREPARING",
  "RECONCILING",
  "CONTRACT_REVIEW",
  "READY",
  "EXECUTING",
  "VERIFYING",
  "REVIEWING",
  "ADJUDICATING",
  "REPAIRING",
  "FINAL_AUDIT",
  "COMPLETION_GATE",
]);

export type ContinuationContext = {
  goal: GoalRecord;
  state: GoalState;
  planEpoch: number;
  reviewCycles: number;
  repairCycles: number;
  nextStep: string;
  canContinue: boolean;
};

/**
 * Build continuation context after compaction.
 * Reads goal from store and determines what the next step should be.
 */
export function buildContinuationContext(
  store: GoalStore,
  goalId: GoalId,
): ContinuationContext | undefined {
  const goal = store.get(goalId);
  if (!goal) return undefined;

  return {
    goal,
    state: goal.state,
    planEpoch: goal.planEpoch,
    reviewCycles: goal.reviewCycles,
    repairCycles: goal.repairCycles,
    nextStep: resolveNextStep(goal),
    canContinue: RESUMABLE_STATES.has(goal.state) && !goal.recoveryRequired,
  };
}

/**
 * Determine the next step based on current goal state.
 */
function resolveNextStep(goal: GoalRecord): string {
  switch (goal.state) {
    case "CREATED":
      return "dispatch_goal_started";
    case "PREPARING":
      return "run_preparation_jobs";
    case "RECONCILING":
      return "run_reconciliation";
    case "CONTRACT_REVIEW":
      return "run_contract_critique";
    case "READY":
      return "start_execution";
    case "EXECUTING":
      return "dispatch_next_assignment";
    case "VERIFYING":
      return "run_verification";
    case "REVIEWING":
      return "run_review";
    case "ADJUDICATING":
      return "run_adjudication";
    case "REPAIRING":
      return "dispatch_repair_assignment";
    case "FINAL_AUDIT":
      return "run_final_audit";
    case "COMPLETION_GATE":
      return "evaluate_completion";
    case "PAUSED":
      return "resume_or_cancel";
    case "BLOCKED":
      return "resolve_blockers";
    case "DONE":
    case "FAILED":
    case "NON_CONVERGENT":
    case "CANCELLED":
    case "CANCELLING":
      return "no_action";
    default:
      return "unknown";
  }
}

/**
 * Resume goal after compaction — returns the context needed for the
 * agent to pick up where it left off.
 */
export function resumeAfterCompaction(
  store: GoalStore,
  goalId: GoalId,
): ContinuationContext | null {
  const ctx = buildContinuationContext(store, goalId);
  if (!ctx || !ctx.canContinue) return null;
  return ctx;
}
