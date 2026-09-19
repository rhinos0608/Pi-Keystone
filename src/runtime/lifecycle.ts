// Lifecycle orchestration: event → reducer → persist → log receipt.
// Coordinates state transitions for goals.

import type { GoalRecord, GoalId, GoalEvent } from "../domain/types.js";
import { validateDriverFence } from "../domain/events.js";
import { validateFencedEvent } from "./driver.js";
import { GoalStore, goalReducer, type GoalReducer } from "../store/goal-store.js";

/** Fenced event rejected by the active driver lease (stale token, expired, or missing lease). */
export class FenceError extends Error {
  readonly code = "FENCE_REJECTED" as const;
  constructor(reason: string) {
    super(`Driver fence rejected: ${reason}`);
    this.name = "FenceError";
  }
}

/** Event dispatched against a terminal goal state. Never a transition. */
export class TerminalStateError extends Error {
  readonly code = "TERMINAL_STATE" as const;
  readonly state: GoalRecord["state"];
  constructor(state: GoalRecord["state"], eventType: string) {
    super(`Event ${eventType} rejected: goal is terminal in ${state}`);
    this.name = "TerminalStateError";
    this.state = state;
  }
}

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
 *
 * Fence-bypass rule: when fencing is active for the goal, a state-changing
 * event that LACKS driverFence is rejected with FenceError instead of
 * skipping validation. State-changing = every event type carrying
 * driverFence in src/domain/types.ts (required or optional). Pure
 * bookkeeping stays exempt (fence optional): GoalStarted (pre-lease
 * bootstrap, no fence field), DriverLeaseAcquired / DriverLeaseReleased
 * (the lease-management channel itself; fencing them would deadlock
 * acquisition and release).
 *
 * NOTE (dead event): ContractCritiqueCompleted carries no driverFence field
 * and has no reducer case (goal-store applyGoalEvent falls through to
 * default → IgnoredEventError), so it is currently undispatcheable while
 * fencing is active: dispatching it then fails with FenceError (missing
 * fence), and without fencing it fails with IgnoredEventError (no-op).
 * Do NOT add a reducer case (YAGNI — zero prod callers); either wire the
 * critique flow with a fence-carrying event or delete the constructor.
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

  if (isTerminal(current)) {
    throw new TerminalStateError(current.state, event.type);
  }

  // Fence validation goes through the active-lease validator (lease presence,
  // expiry, token) once fencing is active for the goal. Goals that never
  // acquired a driver lease keep the legacy counter check so pre-lease
  // bootstrap events (fence 0, counter 0) still dispatch.
  // Bypass close: a state-changing event missing the fence key while fencing
  // is active is rejected, never silently unvalidated.
  const fencingActive =
    current.activeDriverLease !== undefined || current.driverFenceCounter > 0;
  if ("driverFence" in event && event.driverFence !== undefined) {
    if (fencingActive) {
      const check = validateFencedEvent(current, { type: event.type, driverFence: event.driverFence });
      if (!check.ok) throw new FenceError(check.reason); // reasons are log-safe (no tokens)
    } else if (!validateDriverFence(event, current.driverFenceCounter)) {
      throw new FenceError("fence mismatch: expected counter token does not match event");
    }
  } else if (
    fencingActive &&
    event.type !== "GoalStarted" &&
    event.type !== "DriverLeaseAcquired" &&
    event.type !== "DriverLeaseReleased"
  ) {
    throw new FenceError(
      `missing driverFence for state-changing event ${event.type} while fencing is active`,
    );
  }

  const fromState = current.state;
  // Compare-and-swap on the version read above: a concurrent writer between
  // this read and the persist fails with VersionConflictError, no write.
  const updated = store.update(goalId, event, reducer, {
    expectedVersion: current.recordVersion,
  });

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
export function getGoalState(store: GoalStore, goalId: GoalId): GoalRecord | null {
  return store.get(goalId);
}

/**
 * Check if a goal is in a terminal state.
 */
export function isTerminal(record: GoalRecord): boolean {
  const terminal = new Set(["DONE", "BLOCKED", "FAILED", "NON_CONVERGENT", "CANCELLED"]);
  return terminal.has(record.state);
}
