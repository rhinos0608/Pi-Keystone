// Terminal-state completion report formatter.
// Produces structured reports for DONE, BLOCKED, FAILED, NON_CONVERGENT, CANCELLED goals.

import type { GoalRecord, GoalState } from "../domain/types.js";

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
};

/**
 * Format a terminal goal record into a completion report.
 * For DONE: summary of what changed, verification status, finding count.
 * For BLOCKED/FAILED/NON_CONVERGENT: actionable explanation with evidence references.
 */
export function formatCompletion(goal: GoalRecord): CompletionReport {
  if (!TERMINAL_STATES.has(goal.state)) {
    throw new Error(`Goal is not terminal: ${goal.state}`);
  }

  const status = goal.state as TerminalStatus;

  return {
    goalId: goal.goalId,
    state: goal.state,
    status,
    summary: buildSummary(goal, status),
    evidenceRefs: collectEvidence(goal),
  };
}

function buildSummary(goal: GoalRecord, status: TerminalStatus): string {
  switch (status) {
    case "DONE":
      return doneSummary(goal);
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

function doneSummary(goal: GoalRecord): string {
  return [
    `Goal "${goal.userTask}" completed successfully.`,
    `Contract v${goal.contractVersion ?? "N/A"} satisfied.`,
    `${goal.reviewCycles} review cycle(s), ${goal.repairCycles} repair cycle(s).`,
    `All verification checks passed.`,
  ].join(" ");
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

function collectEvidence(goal: GoalRecord): string[] {
  const refs: string[] = [];
  if (goal.terminalReportRef) refs.push(goal.terminalReportRef);
  if (goal.findingLedgerRef) refs.push(goal.findingLedgerRef);
  if (goal.evidenceIndexRef) refs.push(goal.evidenceIndexRef);
  return refs;
}
