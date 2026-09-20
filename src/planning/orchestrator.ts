// Planning orchestrator — builds a userTask-driven provisional plan,
// then reconciles it against baseline background/constraints.
// Returns either a plan ready for contract, or a replan/block decision.

import type { GoalRecord } from "../domain/types.js";
import type { BaselineRecord } from "../baseline/types.js";
import {
  buildPlanFromUserTask,
  PlanCoverageError,
  type ContractCriterion,
  type ProvisionalPlan as PlanArtifact,
} from "./provisional-plan.js";
import {
  reconcile,
  type BaselineResults,
  type ProvisionalPlan as ReconPlan,
} from "./reconciliation.js";

export type PlanningResult =
  | { plan: PlanArtifact }
  | { decision: "replan" | "block"; reason: string };

export type PlanningOptions = {
  /**
   * Canonical contract criteria. Required in the production path: planning
   * validates plan/gate ID membership against these exact IDs. When absent,
   * the plan is blocked unless `allowTestFallbackCriteria` is set (tests only).
   */
  contractCriteria?: ContractCriterion[];
  contextBudget?: number;
  /** Permit the test-only derived fallback criteria. Never set in production. */
  allowTestFallbackCriteria?: boolean;
};

/**
 * Run planning phase: derive assignments from goal.userTask (baseline is
 * background/constraint info only), then reconcile against baseline.
 * The returned plan preserves goal.planEpoch — never reset to 0.
 */
export async function runPlanning(
  goal: GoalRecord,
  baseline: BaselineRecord,
  opts: PlanningOptions = {},
): Promise<PlanningResult> {
  let criteria = opts.contractCriteria;
  if (!criteria) {
    if (!opts.allowTestFallbackCriteria) {
      return {
        decision: "block",
        reason:
          "Planning requires explicit canonical contractCriteria; derived fallback criteria are test-only (pass allowTestFallbackCriteria to use deriveFallbackCriteriaForTests)",
      };
    }
    criteria = deriveFallbackCriteriaForTests(goal.userTask);
  }

  let plan: PlanArtifact;
  try {
    plan = buildPlanFromUserTask({
      userTask: goal.userTask,
      goalId: goal.goalId,
      baseline,
      contractCriteria: criteria,
      currentEpoch: goal.planEpoch,
      contextBudget: opts.contextBudget,
    });
  } catch (err) {
    if (err instanceof PlanCoverageError) {
      return { decision: "block", reason: err.message };
    }
    throw err;
  }

  // Preserve current epoch — revisions bump via reviseProvisionalPlan, never reset.
  plan = { ...plan, planEpoch: goal.planEpoch };

  // Reconcile against baseline background (dirty paths, broken verification).
  // Actions carry basedOnTask + diagnostics so failure-linked detectors can
  // fire from available data. basedOnTask links an action to the first FAILED
  // baseline task it touches (task filePaths are check cwds; assignment
  // targetFiles include cwds via baselineTargetFiles). Succeeded/skipped
  // tasks are never linked: basedOnTask asserts the plan responds to a
  // failure, so linking a passing task would fabricate a
  // task_failure_already_passes critical. Diagnostics mirror the linked
  // failure's baseline evidence verbatim, so failure_alters_problem stays
  // silent on consistent plans and still fires for genuinely mismatched ones.
  const results: BaselineResults = baselineToResults(baseline);
  // Normalize once to a shared base so absolute check cwds and repo-relative
  // hints compare on the same footing (bare cwd "/" aside).
  const normalizeBase = (p: string): string => `/repo-relative/${p.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const reconPlan: ReconPlan = {
    actions: plan.assignments.map((a) => {
      const linked = results.tasks.find(
        (t) => t.status === "failed" && t.filePaths.some((f) => {
          const base = normalizeBase(f);
          return a.targetFiles.some((target) => {
            const norm = normalizeBase(target);
            return norm === base || norm.startsWith(`${base}/`);
          });
        }),
      );
      const diagnostics =
        linked?.diagnostics && linked.diagnostics.length > 0 ? [...linked.diagnostics] : undefined;
      return {
        actionName: a.description,
        targetFiles: a.targetFiles,
        ...(linked ? { basedOnTask: linked.taskName } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      };
    }),
    // No ownershipMap: BaselineRecord carries per-check cwds only, with no
    // per-file→check mapping, so no cheap correct derivation exists.
    // Ownership detectors (#5 diagnostics_contradict_ownership, #9
    // ownership_false) fire only when a caller supplies ownershipMap.
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

/**
 * Test-only bootstrap criteria from userTask when no canonical criteria are
 * supplied. One criterion per sentence/clause (capped); IDs are stable
 * within the call. Production callers must pass contractCriteria explicitly —
 * assignment references always point at the criteria actually used.
 */
export function deriveFallbackCriteriaForTests(userTask: string): ContractCriterion[] {
  const clauses = userTask
    .split(/[.;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5);
  const items = clauses.length > 0 ? clauses : [userTask.trim() || "unspecified task"];
  return items.map((description, i) => ({
    id: `criterion-${i + 1}`,
    description,
  }));
}

/**
 * @deprecated Alias for {@link deriveFallbackCriteriaForTests}. Kept so
 * existing import sites (incl. the package entrypoint) keep compiling.
 * Test-only.
 */
export const deriveCriteriaFromUserTask = deriveFallbackCriteriaForTests;

function baselineToResults(baseline: BaselineRecord): BaselineResults {
  const ok = (c: BaselineRecord["checks"][number]) =>
    c.outcome === "PASS" || c.outcome === "SKIPPED" || c.outcome === "UNAVAILABLE";
  const verificationPassed = baseline.checks.every(ok);
  return {
    tasks: baseline.checks.map((c) => {
      // Diagnostics entries: stderr slice plus the check's content fingerprint
      // when present (BaselineRecord has no failureFingerprints array; the
      // per-check fingerprint is the only content hash available here).
      const diagnostics = [
        ...(c.stderr ? [c.stderr.slice(0, 512)] : []),
        ...(c.fingerprint ? [`fingerprint ${c.fingerprint}`] : []),
      ];
      return {
        taskName: c.command,
        filePaths: [c.cwd],
        status: ok(c) ? ("succeeded" as const) : ("failed" as const),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    }),
    verificationPassed,
  };
}
