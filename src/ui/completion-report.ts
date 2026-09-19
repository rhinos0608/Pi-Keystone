// Terminal-state completion report formatter.
// Produces structured reports for DONE, BLOCKED, FAILED, NON_CONVERGENT, CANCELLED goals.

import type { GoalRecord, GoalState } from "../domain/types.js";
import type { CompletionGateResult } from "../audit/completion-gate.js";
import type { CoverageSummary } from "../evidence/types.js";

type TerminalStatus = "DONE" | "BLOCKED" | "FAILED" | "NON_CONVERGENT" | "CANCELLED";

const TERMINAL_STATES = new Set<GoalState>([
  "DONE",
  "BLOCKED",
  "FAILED",
  "NON_CONVERGENT",
  "CANCELLED",
]);

export type CompletionReport = {
  goalId: string;
  state: GoalState;
  status: TerminalStatus;
  summary: string;
  evidenceRefs: string[];
  /** Evidence-backed predicate statuses from the completion gate, when provided. */
  predicates?: { id: string; description: string; satisfied: boolean }[];
  /** Manifest coverage summary, when an evidence manifest was provided. */
  coverage?: CoverageSummary;
};

/** Optional evidence backing a completion report. */
export type CompletionEvidence = {
  /** Gate result: predicate statuses render per-requirement evidence state. */
  gate?: CompletionGateResult;
  /** Manifest node IDs merged into evidenceRefs. */
  manifestNodeIds?: readonly string[];
  /** Manifest coverage summary rendered into the summary. */
  coverage?: CoverageSummary;
};

/**
 * Format a terminal goal record into a completion report.
 * For DONE: summary of what changed, verification status, finding count.
 * For BLOCKED/FAILED/NON_CONVERGENT: actionable explanation with evidence references.
 */
export function formatCompletion(goal: GoalRecord, evidence?: CompletionEvidence): CompletionReport {
  if (!TERMINAL_STATES.has(goal.state)) {
    throw new Error(`Goal is not terminal: ${goal.state}`);
  }

  const status = goal.state as TerminalStatus;

  const report: CompletionReport = {
    goalId: goal.goalId,
    state: goal.state,
    status,
    summary: buildSummary(goal, status, evidence),
    evidenceRefs: collectEvidence(goal, evidence),
  };
  if (evidence?.gate) {
    report.predicates = evidence.gate.predicates.map((p) => ({
      id: p.id,
      description: p.description,
      satisfied: p.satisfied,
    }));
  }
  if (evidence?.coverage) {
    report.coverage = evidence.coverage;
  }
  return report;
}

function buildSummary(goal: GoalRecord, status: TerminalStatus, evidence?: CompletionEvidence): string {
  switch (status) {
    case "DONE":
      return doneSummary(goal, evidence);
    case "BLOCKED":
      return blockedSummary(goal);
    case "FAILED":
      return failedSummary(goal);
    case "NON_CONVERGENT":
      return nonConvergentSummary(goal);
    case "CANCELLED":
      return cancelledSummary(goal);
  }
}

function doneSummary(goal: GoalRecord, evidence?: CompletionEvidence): string {
  const parts = [
    `Goal "${goal.userTask}" completed successfully.`,
    `Contract v${goal.contractVersion ?? "N/A"} satisfied.`,
    `${goal.reviewCycles} review cycle(s), ${goal.repairCycles} repair cycle(s).`,
    evidence?.gate
      ? `Evidence: ${evidence.gate.predicates.filter((pr) => pr.satisfied).length}/${evidence.gate.predicates.length} predicates satisfied.`
      : `All verification checks passed.`,
  ];
  if (evidence?.coverage) {
    parts.push(
      `Coverage: ${evidence.coverage.covered}/${evidence.coverage.total} criteria backed by passing assertions.`,
    );
  }
  return parts.join(" ");
}

function blockedSummary(goal: GoalRecord): string {
  return [
    `Goal "${goal.userTask}" blocked at plan epoch ${goal.planEpoch}.`,
    `Manual intervention required to resolve blockers.`,
  ].join(" ");
}

function failedSummary(goal: GoalRecord): string {
  const parts = [`Goal "${goal.userTask}" failed.`];
  if (goal.terminalReportRef) {
    parts.push(`Error report: ${goal.terminalReportRef}`);
  }
  return parts.join(" ");
}

function nonConvergentSummary(goal: GoalRecord): string {
  return [
    `Goal "${goal.userTask}" did not converge.`,
    `${goal.reviewCycles} review cycle(s), ${goal.repairCycles} repair cycle(s).`,
    `Contract v${goal.contractVersion ?? "N/A"} could not be satisfied.`,
    `See finding ledger ${goal.findingLedgerRef || "N/A"} for details.`,
  ].join(" ");
}

function cancelledSummary(goal: GoalRecord): string {
  const parts = [`Goal "${goal.userTask}" was cancelled.`];
  if (goal.cancellationReason) {
    parts.push(`Reason: ${goal.cancellationReason}`);
  }
  return parts.join(" ");
}

function collectEvidence(goal: GoalRecord, evidence?: CompletionEvidence): string[] {
  const refs: string[] = [];
  if (goal.terminalReportRef) refs.push(goal.terminalReportRef);
  if (goal.findingLedgerRef) refs.push(goal.findingLedgerRef);
  if (goal.evidenceIndexRef) refs.push(goal.evidenceIndexRef);
  const seen = new Set(refs);
  for (const id of evidence?.manifestNodeIds ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(id);
    }
  }
  return refs;
}
