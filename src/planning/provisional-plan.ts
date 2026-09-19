// Provisional plan artifact — produced during PREPARING, validated against
// goal contract criteria. Plans are provisional: epoch increments on
// contradiction; stale plans (epoch < current) are rejected.
//
// Planning is userTask-driven: assignments derive from goal.userTask, with
// baseline + workspace context as background/constraints. Baseline failures
// never suppress implementation planning. Every assignment references
// EXISTING contract criterion IDs — never fabricated strings. Coverage is
// exact: every contract criterion must map to >= 1 assignment.

import type { BaselineRecord } from "../baseline/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CriterionId = string;

export type ContractCriterion = {
  id: CriterionId;
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
  /** References to EXISTING contract criterion IDs this assignment satisfies. */
  criterionIds: CriterionId[];
  /**
   * Legacy alias for criterionIds. Always kept in sync — read either,
   * write via planner constructors which set both identically.
   */
  acceptanceCriteria: string[];
};

export type ProvisionalPlan = {
  goalId: string;
  planEpoch: number;
  assignments: PlanAssignment[];
  assumptions: string[];
  risks: string[];
};

/**
 * New planning input. Baseline data is background/constraint info only —
 * the planner produces implementation assignments from userTask.
 */
export type PlanInput = {
  userTask: string;
  goalId: string;
  baseline: BaselineRecord;
  contractCriteria: ContractCriterion[];
  /** Current plan epoch from the goal record. Required — never defaulted. */
  currentEpoch: number;
  contextBudget?: number;
};

// ─── Coverage error ─────────────────────────────────────────────────────────

/** Typed rejection: plan does not exactly cover the contract criteria. */
export class PlanCoverageError extends Error {
  readonly code = "PLAN_COVERAGE_ERROR" as const;
  readonly uncoveredCriterionIds: readonly CriterionId[];

  constructor(uncoveredCriterionIds: readonly CriterionId[], detail: string) {
    super(
      uncoveredCriterionIds.length === 0
        ? `PlanCoverageError: ${detail}`
        : `PlanCoverageError: ${detail} (uncovered: ${uncoveredCriterionIds.join(", ")})`,
    );
    this.name = "PlanCoverageError";
    this.uncoveredCriterionIds = uncoveredCriterionIds;
  }
}

// ─── Heuristics (deterministic decomposition helpers) ───────────────────────

/** Code-change verbs — userTask containing one implies implementation work. */
const CODE_CHANGE_PATTERN =
  /\b(add|implement|create|build|fix|repair|refactor|support|introduce|extend|migration|migrate|update|change|remove|delete|replace|feature|enhance|integrate|improve|optimize|enable|allow|write|edit|patch|upgrade|rename|move)\b/i;

/**
 * Explicitly read-only task openings. Unknown/imperative task wording defaults
 * to implementation rather than silently producing a verifier-only plan.
 * Mutation still remains bounded later by acquisition, exact write-set lease,
 * child guard, and dirty-conflict approval.
 */
const READ_ONLY_TASK_PATTERN =
  /^\s*(verify|check|audit|inspect|review|analy[sz]e|investigate|explain|report|assess|compare|find|identify|measure|benchmark|test|run)\b/i;

/** Criterion text shaped like verification rather than implementation. */
const VERIFICATION_SHAPED_PATTERN =
  /\b(pass|passes|passing|verify|verif|test|tests|tested|lint|typecheck|audit|coverage|green|regression|no regression|checks pass)\b/i;

/**
 * True when the userTask needs implementation work. Positive mutation verbs
 * win; otherwise only explicitly read-only task openings stay read-only.
 * This makes ambiguous imperative phrasing fail toward doing the requested
 * work rather than silently substituting verification.
 */
export function needsCodeChanges(userTask: string): boolean {
  if (CODE_CHANGE_PATTERN.test(userTask)) return true;
  return !READ_ONLY_TASK_PATTERN.test(userTask);
}

/** True when a criterion description is verification-shaped. */
export function isVerificationShaped(criterion: ContractCriterion): boolean {
  return VERIFICATION_SHAPED_PATTERN.test(criterion.description);
}

/** Extract path-like tokens from free text (deterministic, sorted, deduped). */
function extractFileHints(text: string): string[] {
  const found = new Set<string>();
  const re = /[\w./-]+\.(tsx|jsx|json|ts|js|md|py|go|rs)(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0]);
  }
  return [...found].sort();
}

/**
 * Mutation scope comes only from explicit file hints in the user's task.
 * Baseline dirt/check cwd are observations, never authority: importing them
 * here would silently grant workers access to unrelated pre-existing files
 * (or even the workspace root). No hints means an implementation assignment
 * will later fail closed with empty-write-set rather than broaden scope.
 */
function baselineTargetFiles(input: PlanInput): string[] {
  return extractFileHints(input.userTask);
}

/** Baseline as background: assumptions record observed state, never drive scope. */
function baselineAssumptions(input: PlanInput): string[] {
  const assumptions: string[] = [];
  for (const c of input.baseline.checks) {
    assumptions.push(`Baseline check "${c.command}" observed ${c.outcome}`);
  }
  const dirty = input.baseline.worktree.dirtyPaths.length;
  assumptions.push(
    dirty === 0
      ? "Worktree clean at baseline capture"
      : `Worktree has ${dirty} dirty path(s) at baseline capture (constraint, not scope)`,
  );
  return assumptions;
}

// ─── User-task-driven planner ───────────────────────────────────────────────

/**
 * Build a provisional plan from userTask + baseline background + contract criteria.
 *
 * - Implementation assignments derive from userTask (baseline red/green does
 *   not suppress them).
 * - A single `a-verify` assignment is emitted only when the task needs no
 *   code changes and every criterion is verification-shaped.
 * - Every assignment's criterionIds references an EXISTING contract criterion.
 *   When no criterion maps to required work, throws PlanCoverageError rather
 *   than inventing IDs.
 * - Coverage is validated exactly before return; uncovered criterion throws.
 */
export function buildPlanFromUserTask(input: PlanInput): ProvisionalPlan {
  const { userTask, goalId, contractCriteria, currentEpoch } = input;

  if (contractCriteria.length === 0) {
    throw new PlanCoverageError(
      [],
      "plan requires at least one contract criterion; cannot invent criterion references",
    );
  }

  const targetFiles = baselineTargetFiles(input);
  const assumptions = baselineAssumptions(input);
  const codeChanges = needsCodeChanges(userTask);

  let assignments: PlanAssignment[];

  if (!codeChanges) {
    // Pure-verification task: every criterion must be verification-shaped,
    // else the plan cannot be just a-verify.
    const nonVerify = contractCriteria.filter((c) => !isVerificationShaped(c));
    if (nonVerify.length > 0) {
      throw new PlanCoverageError(
        nonVerify.map((c) => c.id),
        `task needs no code changes but ${nonVerify.length} criterion/criteria are not verification-shaped; a-verify alone cannot cover them`,
      );
    }
    // Pure-verification task: one verification assignment covering all criteria.
    assignments = [
      {
        id: "a-verify",
        description: `Verify: ${userTask}`,
        targetFiles,
        role: "verification",
        criterionIds: contractCriteria.map((c) => c.id),
        acceptanceCriteria: contractCriteria.map((c) => c.id),
      },
    ];
  } else {
    // Decomposition heuristic: one assignment per criterion, role shaped by
    // the criterion text. Mapping is by construction to a real criterion ID.
    assignments = contractCriteria.map((criterion, i) => {
      const verify = isVerificationShaped(criterion);
      const n = i + 1;
      return {
        id: verify ? `a-verify-${n}` : `a-impl-${n}`,
        description: verify
          ? `Verify: ${criterion.description}`
          : `Implement: ${criterion.description} (${userTask})`,
        targetFiles,
        role: verify ? "verification" : "implementation",
        criterionIds: [criterion.id],
        acceptanceCriteria: [criterion.id],
      };
    });

    // userTask implies code changes: guarantee >= 1 implementation assignment,
    // still tied to a real criterion (convert the first, never invent one).
    if (!assignments.some((a) => a.role === "implementation")) {
      const first = assignments[0];
      assignments[0] = {
        ...first,
        id: "a-impl-1",
        description: `Implement: ${contractCriteria[0].description} (${userTask})`,
        role: "implementation",
      };
    }

    // Every criterion also needs an independent read-only verification path.
    // Converting a verification-shaped assignment into the mandatory
    // implementer above must not accidentally make the user outcome
    // self-attested by the mutation child.
    const independentlyVerified = new Set(
      assignments
        .filter((a) => a.role !== "implementation")
        .flatMap((a) => a.criterionIds),
    );
    const needsFinalVerification = contractCriteria.filter((c) => !independentlyVerified.has(c.id));
    if (needsFinalVerification.length > 0) {
      assignments.push({
        id: "a-verify-final",
        description: `Independently verify requested outcome and contract criteria: ${userTask}`,
        targetFiles,
        role: "verification",
        criterionIds: needsFinalVerification.map((c) => c.id),
        acceptanceCriteria: needsFinalVerification.map((c) => c.id),
      });
    }

    assignments = applyContextBudget(assignments, input.contextBudget);
  }

  const plan: ProvisionalPlan = {
    goalId,
    planEpoch: currentEpoch,
    assignments,
    assumptions,
    risks: [],
  };

  assertPlanCoverage(plan, { goalId, version: 1, criteria: contractCriteria });
  return plan;
}

/**
 * Group assignments when a context budget forces fewer of them.
 * Coverage is preserved: grouped assignments carry the union of criterion IDs.
 */
function applyContextBudget(
  assignments: PlanAssignment[],
  contextBudget?: number,
): PlanAssignment[] {
  if (contextBudget === undefined) return assignments;
  const cap = Math.max(1, Math.floor(contextBudget / 500));
  if (assignments.length <= cap) return assignments;
  const impl = assignments.filter((a) => a.role === "implementation");
  const verify = assignments.filter((a) => a.role !== "implementation");
  const partitions = [impl, verify].filter((p) => p.length > 0);
  const totalGroups = Math.min(cap, assignments.length);
  const base = Math.floor(totalGroups / partitions.length);
  const extra = totalGroups % partitions.length;
  const counts = partitions.map((p, i) => Math.min(p.length, base + (i < extra ? 1 : 0)));
  const split = (list: PlanAssignment[], prefix: string, offset: number, count: number): PlanAssignment[] => {
    const groups: PlanAssignment[][] = Array.from({ length: Math.max(1, count) }, () => []);
    list.forEach((a, i) => {
      groups[i % groups.length]!.push(a);
    });
    return groups.filter((g) => g.length > 0).map((group, gi) => {
      if (group.length === 1) return group[0]!;
      const criterionIds = [...new Set(group.flatMap((a) => a.criterionIds))];
      const targetFiles = [...new Set(group.flatMap((a) => a.targetFiles))].sort();
      const isImpl = group.some((a) => a.role === "implementation");
      const role = isImpl ? "implementation" : "verification";
      return {
        id: `${prefix}-g${offset + gi + 1}`,
        description: group.map((a) => a.description).join("; "),
        targetFiles,
        role,
        criterionIds,
        acceptanceCriteria: criterionIds,
      };
    });
  };
  const out: PlanAssignment[] = [];
  let offset = 0;
  partitions.forEach((list, i) => {
    const prefix = list === impl ? "a-impl" : "a-verify";
    const mapped = split(list, prefix, offset, counts[i]!);
    offset += mapped.length;
    out.push(...mapped);
  });
  return out;
}

// ─── Coverage validation (exact) ────────────────────────────────────────────

/**
 * Exact coverage check: every contract criterion must map to >= 1 assignment
 * via the canonical criterionIds refs. The legacy acceptanceCriteria alias
 * never satisfies coverage.
 * Returns the uncovered IDs (empty when covered).
 */
export function uncoveredCriteria(
  plan: ProvisionalPlan,
  contract: GoalContract,
): CriterionId[] {
  const covered = new Set<string>();
  for (const a of plan.assignments) {
    for (const id of a.criterionIds) covered.add(id);
  }
  return contract.criteria.map((c) => c.id).filter((id) => !covered.has(id));
}

/** Throw PlanCoverageError when any contract criterion is uncovered. */
export function assertPlanCoverage(
  plan: ProvisionalPlan,
  contract: GoalContract,
): void {
  const uncovered = uncoveredCriteria(plan, contract);
  if (uncovered.length > 0) {
    throw new PlanCoverageError(
      uncovered,
      `plan covers ${contract.criteria.length - uncovered.length}/${contract.criteria.length} contract criteria`,
    );
  }
  if (plan.assignments.length === 0) {
    throw new PlanCoverageError([], "plan must have at least one assignment");
  }
}

// ─── Legacy creation (caller-supplied assignments) ──────────────────────────

export type CreatePlanInput = {
  contract: GoalContract;
  baseline: import("./reconciliation.js").BaselineResults;
  assignments: PlanAssignment[];
  /** Current plan epoch from the goal record. Required — never defaulted. */
  currentEpoch: number;
  assumptions?: string[];
  risks?: string[];
};

/** Normalize one assignment: keep criterionIds/acceptanceCriteria in sync. */
function normalizeAssignment(a: PlanAssignment): PlanAssignment {
  const ids =
    a.criterionIds && a.criterionIds.length > 0
      ? a.criterionIds
      : (a.acceptanceCriteria ?? []);
  const legacy =
    a.acceptanceCriteria && a.acceptanceCriteria.length > 0
      ? a.acceptanceCriteria
      : ids;
  return { ...a, criterionIds: ids, acceptanceCriteria: legacy };
}

/**
 * Create a provisional plan from a goal contract and baseline results.
 * Assignments are caller-supplied; the function assembles the artifact,
 * populates default assumptions from baseline when none provided, then
 * enforces validatePlan + assertPlanCoverage: unknown criterion refs and
 * empty assignments throw PlanCoverageError.
 */
export function createProvisionalPlan(input: CreatePlanInput): ProvisionalPlan {
  const { contract, baseline, risks, currentEpoch } = input;
  const assignments = input.assignments.map(normalizeAssignment);

  let assumptions = input.assumptions;
  if (!assumptions) {
    assumptions = [];
    for (const task of baseline.tasks) {
      if (task.status === "succeeded") {
        assumptions.push(`Baseline task "${task.taskName}" passes`);
      }
    }
  }

  const plan: ProvisionalPlan = {
    goalId: contract.goalId,
    planEpoch: currentEpoch,
    assignments,
    assumptions,
    risks: risks ?? [],
  };
  const validation = validatePlan(plan, contract);
  if (!validation.valid) {
    const unknown = assignments.flatMap((a) =>
      a.criterionIds.filter((id) => !contract.criteria.some((c) => c.id === id)),
    );
    throw new PlanCoverageError(
      [...new Set([...unknown, ...uncoveredCriteria(plan, contract)])],
      `createProvisionalPlan rejected: ${validation.errors.join("; ")}`,
    );
  }
  assertPlanCoverage(plan, contract);
  return plan;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

/**
 * Validate a provisional plan against its goal contract.
 * - At least one assignment required.
 * - Every criterion reference on every assignment must exist in the contract.
 * - Exact coverage: every contract criterion must map to >= 1 assignment.
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
    // Canonical refs only — the legacy acceptanceCriteria alias is synced by
    // constructors but never counts as a reference here.
    for (const criterionId of assignment.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        errors.push(
          `Assignment "${assignment.id}" references unknown criterion "${criterionId}"`,
        );
      }
    }
  }

  for (const uncovered of uncoveredCriteria(plan, contract)) {
    errors.push(
      `Criterion "${uncovered}" has no covering assignment (plan rejected)`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ─── Epoch management ───────────────────────────────────────────────────────

/** Return a new plan with epoch incremented by 1. */
export function incrementEpoch(plan: ProvisionalPlan): ProvisionalPlan {
  return { ...plan, planEpoch: plan.planEpoch + 1 };
}

/**
 * Revise a plan: epoch bumps +1, prior epoch history preserved
 * (never reset to 0 — pass only deltas via overrides).
 */
export function reviseProvisionalPlan(
  plan: ProvisionalPlan,
  overrides?: Partial<Omit<ProvisionalPlan, "planEpoch" | "goalId">>,
): ProvisionalPlan {
  return {
    ...plan,
    ...overrides,
    assignments: overrides?.assignments ?? plan.assignments,
    planEpoch: plan.planEpoch + 1,
  };
}

/** True when the plan's epoch is behind the current epoch (stale). */
export function isStale(plan: ProvisionalPlan, currentEpoch: number): boolean {
  return plan.planEpoch < currentEpoch;
}
