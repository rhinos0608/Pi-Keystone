// Validation helpers for GoalRecord

import type { GoalRecord, GoalState, GoalId, ISO8601 } from "./types.js";

// All terminal states — no transitions allowed from these
const TERMINAL_STATES: ReadonlySet<GoalState> = new Set([
  "DONE",
  "BLOCKED",
  "FAILED",
  "NON_CONVERGENT",
  "CANCELLED",
]);

// States that CANCELLING excludes from resume (per architecture §3A)
const NON_RESUMABLE_STATES: ReadonlySet<GoalState> = new Set([
  "PAUSED",
  "CANCELLING",
  "DONE",
  "BLOCKED",
  "FAILED",
  "NON_CONVERGENT",
  "CANCELLED",
]);

/**
 * Allowed transitions extracted from §3A transition table.
 * Key = source state, value = set of legal target states.
 */
const TRANSITIONS = new Map<GoalState, Set<GoalState>>([
  ["CREATED", new Set(["PREPARING", "BLOCKED", "FAILED", "CANCELLING"])],
  ["PREPARING", new Set(["RECONCILING", "BLOCKED", "FAILED", "PAUSED", "CANCELLING"])],
  [
    "RECONCILING",
    new Set(["PREPARING", "CONTRACT_REVIEW", "BLOCKED", "FAILED"]),
  ],
  [
    "CONTRACT_REVIEW",
    new Set(["READY", "RECONCILING", "BLOCKED", "FAILED"]),
  ],
  ["READY", new Set(["EXECUTING", "BLOCKED", "FAILED", "CANCELLING"])],
  [
    "EXECUTING",
    new Set(["VERIFYING", "BLOCKED", "FAILED", "CANCELLING"]),
  ],
  [
    "VERIFYING",
    new Set(["REVIEWING", "EXECUTING", "REPAIRING", "BLOCKED", "FAILED"]),
  ],
  [
    "REVIEWING",
    new Set(["ADJUDICATING", "FINAL_AUDIT", "BLOCKED", "FAILED"]),
  ],
  [
    "ADJUDICATING",
    new Set(["REPAIRING", "REVIEWING", "FINAL_AUDIT", "BLOCKED", "FAILED", "NON_CONVERGENT"]),
  ],
  ["REPAIRING", new Set(["VERIFYING", "NON_CONVERGENT", "BLOCKED", "FAILED"])],
  [
    "FINAL_AUDIT",
    new Set(["COMPLETION_GATE", "ADJUDICATING", "BLOCKED", "FAILED", "NON_CONVERGENT"]),
  ],
  [
    "COMPLETION_GATE",
    new Set(["DONE", "REPAIRING", "PAUSED", "BLOCKED", "FAILED", "CANCELLING"]),
  ],
  ["PAUSED", new Set(["RECONCILING", "CANCELLING", "FAILED"])],
  // CANCELLING only allows CANCELLED (via CancellationSettled) or FAILED (fatal)
  ["CANCELLING", new Set(["CANCELLED", "FAILED"])],
]);

// Any nonterminal state can transition to CANCELLING via CancelRequested
const CANCELLABLE_STATES: ReadonlySet<GoalState> = new Set(
  [...TRANSITIONS.keys()].filter((s) => !TERMINAL_STATES.has(s) && s !== "CANCELLING"),
);

export function createGoalRecord(
  goalId: GoalId,
  userTask: string,
  workspace: GoalRecord["workspace"],
  startRevision: GoalRecord["startRevision"],
): GoalRecord {
  const now = new Date().toISOString() as ISO8601;
  return {
    schemaVersion: 1,
    recordVersion: 1,
    goalId,
    userTask,
    createdAt: now,
    updatedAt: now,
    workspace,
    startRevision,
    currentRevision: startRevision,
    state: "CREATED",
    recoveryRequired: false,
    planEpoch: 0,
    contractVersion: null,
    activeContractRef: null,
    baselineRef: null,
    snapshotRefs: [],
    snapshotPins: [],
    findingLedgerRef: "" as GoalRecord["findingLedgerRef"],
    evidenceIndexRef: "" as GoalRecord["evidenceIndexRef"],
    assignmentIndexRef: "" as GoalRecord["assignmentIndexRef"],
    verificationIndexRef: "" as GoalRecord["verificationIndexRef"],
    preparation: {
      baselineJob: {
        kind: "baseline",
        planEpoch: 0,
        attemptId: "",
        basedOnRevision: startRevision,
        status: "PENDING",
      },
      provisionalPlanJob: {
        kind: "plan",
        planEpoch: 0,
        attemptId: "",
        basedOnRevision: startRevision,
        status: "PENDING",
      },
    },
    driverFenceCounter: 0,
    mutationFenceCounter: 0,
    reviewCycles: 0,
    repairCycles: 0,
    finalAuditAttempts: 0,
    lastTransitionId: "",
  };
}

export function validateTransition(
  from: GoalState,
  to: GoalState,
): { valid: boolean; reason?: string } {
  // CANCELLING: only CANCELLED or FAILED allowed
  if (from === "CANCELLING") {
    const allowed = new Set(["CANCELLED", "FAILED"]);
    if (!allowed.has(to)) {
      return {
        valid: false,
        reason: `CANCELLING only allows ${[...allowed].join("|")}, got ${to}`,
      };
    }
    return { valid: true };
  }

  // Any nonterminal can go to CANCELLING via CancelRequested
  if (to === "CANCELLING" && CANCELLABLE_STATES.has(from)) {
    return { valid: true };
  }

  // Any nonterminal can go to PAUSED via PauseRequested
  if (to === "PAUSED" && CANCELLABLE_STATES.has(from)) {
    return { valid: true };
  }

  // Terminal states: no transitions
  if (TERMINAL_STATES.has(from)) {
    return {
      valid: false,
      reason: `${from} is terminal, no transitions allowed`,
    };
  }

  const allowed = TRANSITIONS.get(from);
  if (!allowed) {
    return { valid: false, reason: `Unknown source state: ${from}` };
  }

  if (!allowed.has(to)) {
    return {
      valid: false,
      reason: `Transition ${from} -> ${to} not in allowed set [${[...allowed].join(", ")}]`,
    };
  }

  return { valid: true };
}
