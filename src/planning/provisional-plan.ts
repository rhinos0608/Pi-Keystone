// Provisional plan artifact — produced during PREPARING, validated against
// goal contract criteria. Plans are provisional: epoch increments on
// contradiction; stale plans (epoch < current) are rejected.

import type { GoalId } from "../domain/types.js";
import type { BaselineResults } from "./reconciliation.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContractCriterion = {
  id: string;
  description: string;
};

export type GoalContract = {
  goalId: string;
  version: number;
  criteria: ContractCriterion[];
};

export type PlanAssignment = {
  id: string;
  description: string;
  targetFiles: string[];
  role: string;
  /** References to contract criterion IDs this assignment satisfies. */
  acceptanceCriteria: string[];
};

export type ProvisionalPlan = {
  goalId: string;
  planEpoch: number;
  assignments: PlanAssignment[];
  assumptions: string[];
  risks: string[];
};

// ─── Creation ───────────────────────────────────────────────────────────────

export type CreatePlanInput = {
  contract: GoalContract;
  baseline: BaselineResults;
  assignments: PlanAssignment[];
  assumptions?: string[];
  risks?: string[];
};

/**
 * Create a provisional plan from a goal contract and baseline results.
 * Assignments are caller-supplied; the function assembles the artifact
 * and populates default assumptions from baseline when none provided.
 */
export function createProvisionalPlan(input: CreatePlanInput): ProvisionalPlan {
  const { contract, baseline, assignments, risks } = input;

  let assumptions = input.assumptions;
  if (!assumptions) {
    assumptions = [];
    for (const task of baseline.tasks) {
      if (task.status === "succeeded") {
        assumptions.push(`Baseline task "${task.taskName}" passes`);
      }
    }
  }

  return {
    goalId: contract.goalId,
    planEpoch: 0,
    assignments,
    assumptions,
    risks: risks ?? [],
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

/**
 * Validate a provisional plan against its goal contract.
 * - At least one assignment required.
 * - Every acceptance criterion reference on every assignment must exist in the contract.
 */
export function validatePlan(
  plan: ProvisionalPlan,
  contract: GoalContract,
): ValidationResult {
  const errors: string[] = [];

  if (plan.assignments.length === 0) {
    errors.push("Plan must have at least one assignment");
  }

  const criterionIds = new Set(contract.criteria.map((c) => c.id));
  for (const assignment of plan.assignments) {
    for (const criterionId of assignment.acceptanceCriteria) {
      if (!criterionIds.has(criterionId)) {
        errors.push(
          `Assignment "${assignment.id}" references unknown criterion "${criterionId}"`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Epoch management ───────────────────────────────────────────────────────

/** Return a new plan with epoch incremented by 1. */
export function incrementEpoch(plan: ProvisionalPlan): ProvisionalPlan {
  return { ...plan, planEpoch: plan.planEpoch + 1 };
}

/** True when the plan's epoch is behind the current epoch (stale). */
export function isStale(plan: ProvisionalPlan, currentEpoch: number): boolean {
  return plan.planEpoch < currentEpoch;
}
