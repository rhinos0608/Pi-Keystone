// Lifecycle orchestration: event → reducer → persist → log receipt.
// Coordinates state transitions for goals.

import type { GoalRecord, GoalId, GoalEvent } from "../domain/types.js";
import { validateDriverFence } from "../domain/events.js";
import { GoalStore, goalReducer, type GoalReducer } from "../store/goal-store.js";

export type ReceiptEntry = {
  goalId: GoalId;
  eventType: string;
  fromState: GoalRecord["state"];
  toState: GoalRecord["state"];
  recordVersion: number;
  timestamp: string;
  transitionId: string;
};

export type ReceiptLog = ReceiptEntry[];

/**
 * Dispatch a GoalEvent against a stored goal.
 * 1. Reads current record from store
 * 2. Validates driver fence (if applicable)
 * 3. Applies reducer → new record
 * 4. Validates state transition
 * 5. Persists
 * 6. Appends receipt log entry
 * Returns { record, receipt } or throws.
 */
export function dispatchEvent(
  store: GoalStore,
  goalId: GoalId,
  event: GoalEvent,
  receiptLog: ReceiptLog,
  reducer: GoalReducer = goalReducer,
): { record: GoalRecord; receipt: ReceiptEntry } {
  const current = store.get(goalId);
  if (!current) throw new Error(`Goal ${goalId} not found`);

  // Validate driver fence if event carries one
  if ("driverFence" in event) {
    const fence = (event as { driverFence: number }).driverFence;
    if (!validateDriverFence(event, current.driverFenceCounter)) {
      throw new Error(
        `Driver fence mismatch: expected ${current.driverFenceCounter}, got ${fence}`,
      );
    }
  }

  const fromState = current.state;
  const updated = store.update(goalId, event, reducer);

  const receipt: ReceiptEntry = {
    goalId,
    eventType: event.type,
    fromState,
    toState: updated.state,
    recordVersion: updated.recordVersion,
    timestamp: new Date().toISOString(),
    transitionId: updated.lastTransitionId,
  };
  receiptLog.push(receipt);

  return { record: updated, receipt };
}

/**
 * Start a new goal through the lifecycle.
 * Creates the record, dispatches GoalStarted, returns the prepared goal.
 */
export function startGoal(
  store: GoalStore,
  goalId: GoalId,
  record: GoalRecord,
  receiptLog: ReceiptLog,
): GoalRecord {
  store.create(goalId, record);
  const { record: updated } = dispatchEvent(store, goalId, { type: "GoalStarted" }, receiptLog);
  return updated;
}

/**
 * Retrieve the current state of a goal (read-only).
 */
export function getGoalState(store: GoalStore, goalId: GoalId): GoalRecord | undefined {
  return store.get(goalId);
}

/**
 * Check if a goal is in a terminal state.
 */
export function isTerminal(record: GoalRecord): boolean {
  const terminal = new Set(["DONE", "BLOCKED", "FAILED", "NON_CONVERGENT", "CANCELLED"]);
  return terminal.has(record.state);
}
