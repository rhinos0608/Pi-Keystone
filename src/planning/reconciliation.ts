// Reconciliation barrier — detects contradictions between baseline results
// and a provisional plan before accepting the plan for execution.

import type { ArtifactRef, ISO8601 } from "../domain/types.js";

// ─── Input types ───────────────────────────────────────────────────────────

/** Outcome of a single baseline task/assignment. */
export type BaselineTaskResult = {
  taskName: string;
  filePaths: string[];
  status: "succeeded" | "failed" | "skipped" | "error";
  diagnostics?: string[];
};

/** Baseline results collected during PREPARING phase. */
export type BaselineResults = {
  tasks: BaselineTaskResult[];
  verificationPassed: boolean;
  verificationDiagnostics?: string[];
};

/** A single action within a provisional plan. */
export type PlanAction = {
  actionName: string;
  targetFiles: string[];
  /** Name of baseline task this action is responding to, if any. */
  basedOnTask?: string;
  diagnostics?: string[];
};

/** A provisional plan produced by the planner. */
export type ProvisionalPlan = {
  actions: PlanAction[];
  ownershipMap?: Record<string, string>; // filePath → assigned task
};

/** Per-finding output from reconciliation. */
export type ReconciliationFinding = {
  kind:
    | "task_failure_already_passes"
    | "failure_alters_problem"
    | "target_files_dirty"
    | "verification_broken"
    | "diagnostics_contradict_ownership"
    | "partial_implementation"
    | "outside_cone_failure"
    | "capability_gap"
    | "ownership_false";
  severity: "info" | "warning" | "critical";
  detail: string;
  evidenceRefs?: string[];
};

export type ReconcileDecision = "accept" | "replan" | "block";

export type ReconcileResult = {
  decision: ReconcileDecision;
  reason: string;
  epochDelta?: number;
  findings: ReconciliationFinding[];
};

// ─── Contradiction history (in-memory per call-chain) ──────────────────────

export type ContradictionRecord = {
  kind: ReconciliationFinding["kind"];
  count: number;
};

// ─── Core function ─────────────────────────────────────────────────────────

const BLOCK_THRESHOLD = 3;

/**
 * Reconcile baseline results against a provisional plan.
 *
 * @param baseline    - Collected baseline task results
 * @param plan        - The provisional plan to validate
 * @param dirtyFiles  - Set of currently dirty file paths (uncommitted)
 * @param epoch       - Current planEpoch from the goal record
 * @param priorHistory - Accumulated contradiction counts from earlier
 *                       reconciliation attempts within the same epoch
 */
export function reconcile(
  baseline: BaselineResults,
  plan: ProvisionalPlan,
  dirtyFiles: ReadonlySet<string>,
  epoch: number,
  priorHistory: ContradictionRecord[] = [],
): ReconcileResult {
  const findings: ReconciliationFinding[] = [];

  // Clone prior history so we can mutate
  const history = new Map<string, number>();
  for (const rec of priorHistory) {
    history.set(rec.kind, rec.count);
  }

  function addFinding(finding: ReconciliationFinding) {
    findings.push(finding);
    const cur = history.get(finding.kind) ?? 0;
    history.set(finding.kind, cur + 1);
  }

  // 1. Task failure already passes — plan assumes task failed, but it succeeded
  for (const action of plan.actions) {
    if (!action.basedOnTask) continue;
    const task = baseline.tasks.find((t) => t.taskName === action.basedOnTask);
    if (task && task.status === "succeeded") {
      addFinding({
        kind: "task_failure_already_passes",
        severity: "critical",
        detail: `Plan action "${action.actionName}" targets failed task "${action.basedOnTask}" which actually succeeded`,
        evidenceRefs: [action.basedOnTask, action.actionName],
      });
    }
  }

  // 2. Failure alters problem — plan actions reference tasks that failed but
  //    with different diagnostic signatures than the baseline
  for (const action of plan.actions) {
    if (!action.basedOnTask) continue;
    const task = baseline.tasks.find((t) => t.taskName === action.basedOnTask);
    if (!task || task.status !== "failed") continue;
    if (task.diagnostics && action.diagnostics) {
      const overlap = task.diagnostics.some((d) => action.diagnostics!.includes(d));
      if (!overlap && action.diagnostics.length > 0 && task.diagnostics.length > 0) {
        addFinding({
          kind: "failure_alters_problem",
          severity: "warning",
          detail: `Plan action "${action.actionName}" diagnostics do not match baseline failure diagnostics for "${action.basedOnTask}"`,
          evidenceRefs: [action.basedOnTask, action.actionName],
        });
      }
    }
  }

  // 3. Target files dirty — plan wants to modify files with uncommitted changes
  for (const action of plan.actions) {
    const dirtyTargets = action.targetFiles.filter((f) => dirtyFiles.has(f));
    if (dirtyTargets.length > 0) {
      addFinding({
        kind: "target_files_dirty",
        severity: "warning",
        detail: `Plan action "${action.actionName}" targets dirty files: ${dirtyTargets.join(", ")}`,
        evidenceRefs: dirtyTargets,
      });
    }
  }

  // 4. Verification broken — baseline verification failed but plan assumes clean slate
  if (!baseline.verificationPassed) {
    // Only flag if plan doesn't explicitly address verification failure
    const addressesVerification = plan.actions.some((a) =>
      a.actionName.toLowerCase().includes("verif") ||
      a.diagnostics?.some((d) => d.toLowerCase().includes("verif")),
    );
    if (!addressesVerification) {
      addFinding({
        kind: "verification_broken",
        severity: "critical",
        detail: "Baseline verification failed but plan does not address verification issues",
        evidenceRefs: [],
      });
    }
  }

  // 5. Diagnostics contradict ownership — ownershipMap assigns a file to a task
  //    but that task's diagnostics don't align with the file's baseline diagnostics
  if (plan.ownershipMap) {
    for (const [filePath, assignedTask] of Object.entries(plan.ownershipMap)) {
      const task = baseline.tasks.find((t) => t.taskName === assignedTask);
      if (!task || task.status === "succeeded" || task.status === "skipped") continue;
      if (task.filePaths.includes(filePath)) continue; // consistent
      // Task doesn't claim this file but ownership says it should
      if (task.diagnostics && task.diagnostics.length > 0) {
        addFinding({
          kind: "diagnostics_contradict_ownership",
          severity: "warning",
          detail: `Ownership assigns "${filePath}" to task "${assignedTask}" which does not list this file`,
          evidenceRefs: [assignedTask, filePath],
        });
      }
    }
  }

  // 6. Partial implementation — task succeeded but has warnings; plan assumes full failure
  for (const action of plan.actions) {
    if (!action.basedOnTask) continue;
    const task = baseline.tasks.find((t) => t.taskName === action.basedOnTask);
    if (task && task.status === "succeeded" && task.diagnostics && task.diagnostics.length > 0) {
      addFinding({
        kind: "partial_implementation",
        severity: "warning",
        detail: `Plan action "${action.actionName}" targets task "${action.basedOnTask}" which succeeded but has warnings`,
        evidenceRefs: [action.basedOnTask, ...task.diagnostics.slice(0, 3)],
      });
    }
  }

  // 7. Outside-cone failure — failed task files not in any plan action's targetFiles
  const allTargetFiles = new Set(plan.actions.flatMap((a) => a.targetFiles));
  for (const task of baseline.tasks) {
    if (task.status !== "failed") continue;
    const outsideFiles = task.filePaths.filter((f) => !allTargetFiles.has(f));
    if (outsideFiles.length > 0) {
      addFinding({
        kind: "outside_cone_failure",
        severity: "info",
        detail: `Task "${task.taskName}" failed on files outside plan impact cone: ${outsideFiles.join(", ")}`,
        evidenceRefs: [task.taskName, ...outsideFiles],
      });
    }
  }

  // 8. Capability gap — plan action references specialized tooling not broadly available
  const TOOL_PATTERN = /\b(bash|mcp|docker|kubernetes|kubectl|terraform):/i;
  for (const action of plan.actions) {
    if (TOOL_PATTERN.test(action.actionName)) {
      addFinding({
        kind: "capability_gap",
        severity: "warning",
        detail: `Plan action "${action.actionName}" references specialized tooling that may not be available`,
        evidenceRefs: [action.actionName],
      });
    }
  }

  // 9. Ownership false — ownershipMap assigns file to a task that already succeeded
  if (plan.ownershipMap) {
    for (const [filePath, assignedTask] of Object.entries(plan.ownershipMap)) {
      const task = baseline.tasks.find((t) => t.taskName === assignedTask);
      if (task && task.status === "succeeded") {
        addFinding({
          kind: "ownership_false",
          severity: "warning",
          detail: `Ownership assigns "${filePath}" to task "${assignedTask}" which already succeeded — no changes expected`,
          evidenceRefs: [assignedTask, filePath],
        });
      }
    }
  }

  // ─── Decision logic ──────────────────────────────────────────────────────

  if (findings.length === 0) {
    return { decision: "accept", reason: "No contradictions detected", findings };
  }

  const epochDelta =
    findings.some((f) => f.severity === "critical") ? 1 : undefined;

  // Check escalation: any contradiction kind hit block threshold
  for (const [, count] of history) {
    if (count >= BLOCK_THRESHOLD) {
      return {
        decision: "block",
        reason: `Contradiction repeated ${count} times — exceeding threshold of ${BLOCK_THRESHOLD}`,
        epochDelta,
        findings,
      };
    }
  }

  return {
    decision: "replan",
    reason: `${findings.length} contradiction(s) detected`,
    epochDelta,
    findings,
  };
}
