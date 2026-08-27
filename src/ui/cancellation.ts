// Graceful goal cancellation with settlement timeout and quarantine
// for indeterminate mutations.

import type { GoalRecord, GoalId, ISO8601 } from "../domain/types.js";
import {
  settleCancellation,
  createQuarantine,
  quarantineMutation,
  type QuarantineRecord,
  type MutationOutcome,
} from "../runtime/recovery.js";

export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 30_000;

export type CancellationResult = {
  goalId: GoalId;
  /** Whether the cancellation has been fully resolved. */
  settled: boolean;
  /** Mutation outcome from settlement. */
  outcome: MutationOutcome;
  /** Whether the mutation was quarantined for later resolution. */
  quarantined: boolean;
};

/**
 * Attempt graceful cancellation of a goal.
 *
 * If the goal is already terminal, returns settled immediately.
 * If the goal is in CANCELLING state, attempts mutation settlement.
 * Indeterminate mutations are quarantined with the given timeout.
 *
 * The caller is responsible for dispatching CancelRequested / CancellationSettled
 * events via the store — this function determines the right action.
 */
export function cancelGoal(
  record: GoalRecord,
  now: ISO8601,
  opts: {
    settlementTimeoutMs?: number;
    quarantine?: QuarantineRecord;
  } = {},
): CancellationResult {
  const { goalId } = record;
  const timeoutMs = opts.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
  const quarantine = opts.quarantine ?? createQuarantine();

  // Already terminal — nothing to do
  if (isTerminalState(record.state)) {
    return { goalId, settled: true, outcome: "SETTLED", quarantined: false };
  }

  // Not yet in CANCELLING — caller must dispatch CancelRequested first
  if (record.state !== "CANCELLING") {
    return { goalId, settled: false, outcome: "INDETERMINATE", quarantined: false };
  }

  // Attempt settlement
  const result = settleCancellation(record, now);
  if (!result) {
    return { goalId, settled: false, outcome: "INDETERMINATE", quarantined: false };
  }

  const { outcome } = result;

  // If indeterminate and there's an active mutation, check timeout/quarantine
  if (outcome === "INDETERMINATE" && record.activeMutationLease) {
    const leaseExpiry = new Date(record.activeMutationLease.expiresAt).getTime();
    const nowMs = new Date(now).getTime();
    const deadlineMs = nowMs + timeoutMs;

    if (leaseExpiry > deadlineMs) {
      // Lease outlasts the settlement window — quarantine
      quarantineMutation(
        quarantine,
        goalId,
        record.activeMutationLease,
        now,
        timeoutMs,
      );
      return { goalId, settled: false, outcome: "INDETERMINATE", quarantined: true };
    }
    // Lease will expire within window — caller should wait and retry
    return { goalId, settled: false, outcome: "INDETERMINATE", quarantined: false };
  }

  return { goalId, settled: true, outcome, quarantined: false };
}

const TERMINAL = new Set(["DONE", "BLOCKED", "FAILED", "NON_CONVERGENT", "CANCELLED"]);

function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}
