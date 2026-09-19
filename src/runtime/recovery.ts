// Cancellation settlement, quarantine, and startup recovery
// Phase 4 — P4-W7

import type {
  GoalRecord,
  GoalEvent,
  MutationLease,
  DriverLease,
  ArtifactRef,
  ISO8601,
  GoalId,
} from "../domain/types.js";
import type { ReceiptLog } from "./lifecycle.js";
import { GoalStore } from "../store/goal-store.js";

// ─── Cancellation Settlement ────────────────────────────────────────────────

export type MutationOutcome = "SETTLED" | "ROLLED_BACK" | "INDETERMINATE";

export type SettlementResult = {
  outcome: MutationOutcome;
  event: GoalEvent;
};

/**
 * Attempt to settle in-flight mutations when CANCELLED intent is received.
 * Returns a CancellationSettled event with the determined outcome.
 *
 * - SETTLING mutations that haven't expired → SETTLED
 * - MUTATING mutations that haven't expired → ROLLED_BACK
 * - Expired or unstarted mutations → INDETERMINATE (quarantine path)
 */
export function settleCancellation(
  record: GoalRecord,
  now: ISO8601,
): SettlementResult | null {
  if (record.state !== "CANCELLING") return null;

  const mutation = record.activeMutationLease;
  if (!mutation) {
    return {
      outcome: "SETTLED",
      event: {
        type: "CancellationSettled",
        cleanupRef: "" as ArtifactRef,
        mutationOutcome: "SETTLED",
      },
    };
  }

  const expired = new Date(mutation.expiresAt) <= new Date(now);

  if (expired) {
    return {
      outcome: "INDETERMINATE",
      event: {
        type: "CancellationSettled",
        cleanupRef: "" as ArtifactRef,
        mutationOutcome: "INDETERMINATE",
      },
    };
  }

  if (mutation.phase === "SETTLING") {
    return {
      outcome: "SETTLED",
      event: {
        type: "CancellationSettled",
        cleanupRef: "" as ArtifactRef,
        mutationOutcome: "SETTLED",
      },
    };
  }

  if (mutation.phase === "MUTATING") {
    // Never claim ROLLED_BACK without proof: this function runs in-process
    // with no rollback artifact (no evidence the partial writes were undone),
    // so a MUTATING lease is INDETERMINATE (quarantine path) until external
    // evidence proves settlement or rollback.
    return {
      outcome: "INDETERMINATE",
      event: {
        type: "CancellationSettled",
        cleanupRef: "" as ArtifactRef,
        mutationOutcome: "INDETERMINATE",
      },
    };
  }

  // ACQUIRED or AUTHORITY_READY but not expired — indeterminate
  return {
    outcome: "INDETERMINATE",
    event: {
      type: "CancellationSettled",
      cleanupRef: "" as ArtifactRef,
      mutationOutcome: "INDETERMINATE",
    },
  };
}

// ─── Quarantine ─────────────────────────────────────────────────────────────

export type QuarantineEntry = {
  goalId: string;
  mutationLease: MutationLease;
  quarantinedAt: ISO8601;
  expiresAt: ISO8601;
};

export type QuarantineRecord = {
  entries: QuarantineEntry[];
};

export function createQuarantine(): QuarantineRecord {
  return { entries: [] };
}

/**
 * Add an indeterminate mutation lease to quarantine with a timeout.
 */
export function quarantineMutation(
  quarantine: QuarantineRecord,
  goalId: string,
  mutationLease: MutationLease,
  now: ISO8601,
  timeoutMs: number,
): QuarantineEntry {
  const expiresAt = new Date(new Date(now).getTime() + timeoutMs).toISOString() as ISO8601;
  const entry: QuarantineEntry = {
    goalId,
    mutationLease,
    quarantinedAt: now,
    expiresAt,
  };
  quarantine.entries.push(entry);
  return entry;
}

/**
 * Evict expired quarantine entries. Returns the evicted entries.
 * Expired entries are force-settled as INDETERMINATE.
 */
export function evictExpiredQuarantine(
  quarantine: QuarantineRecord,
  now: ISO8601,
): QuarantineEntry[] {
  const expired: QuarantineEntry[] = [];
  quarantine.entries = quarantine.entries.filter((e) => {
    if (new Date(e.expiresAt) <= new Date(now)) {
      expired.push(e);
      return false;
    }
    return true;
  });
  return expired;
}

// ─── Startup Recovery ───────────────────────────────────────────────────────

export type RecoveryAction =
  | { kind: "orphaned_driver_lease"; goalId: string; leaseId: string }
  | { kind: "stale_mutation_lease"; goalId: string; leaseId: string; phase: MutationLease["phase"] }
  | { kind: "stale_recovery_required"; goalId: string };

/**
 * Scan goals and detect orphaned driver leases (expired lease on non-terminal goal).
 * Also detects stale mutation leases and goals stuck with recoveryRequired.
 */
export function detectRecoveryIssues(
  goals: GoalRecord[],
  now: ISO8601,
): RecoveryAction[] {
  const TERMINAL_STATES = new Set([
    "DONE",
    "BLOCKED",
    "FAILED",
    "NON_CONVERGENT",
    "CANCELLED",
  ]);

  const issues: RecoveryAction[] = [];

  for (const goal of goals) {
    // Terminal goals are skipped entirely: a terminal flag is wedged by
    // design (no transition out exists), and continuation canContinue is
    // already false for them — reporting stale_recovery_required there only
    // invites a no-op clear. Terminal bookkeeping is operator-owned, not
    // startup-recovery-owned.
    if (TERMINAL_STATES.has(goal.state)) continue;

    // Orphaned driver lease
    if (goal.activeDriverLease) {
      const leaseExpired = new Date(goal.activeDriverLease.expiresAt) <= new Date(now);
      if (leaseExpired) {
        issues.push({
          kind: "orphaned_driver_lease",
          goalId: goal.goalId,
          leaseId: goal.activeDriverLease.leaseId,
        });
      }
    }

    // Stale mutation lease
    if (goal.activeMutationLease) {
      const mutExpired = new Date(goal.activeMutationLease.expiresAt) <= new Date(now);
      if (mutExpired) {
        issues.push({
          kind: "stale_mutation_lease",
          goalId: goal.goalId,
          leaseId: goal.activeMutationLease.leaseId,
          phase: goal.activeMutationLease.phase,
        });
      }
    }

    // Goal flagged for recovery but may need re-check
    if (goal.recoveryRequired) {
      issues.push({
        kind: "stale_recovery_required",
        goalId: goal.goalId,
      });
    }
  }

  return issues;
}

/**
 * Repair a goal with an orphaned driver lease through a persistent, audited
 * store repair: clears the stale lease, flags recoveryRequired, CAS-guards
 * the write, bumps recordVersion, and appends a receipt log entry.
 * Never mutates caller-owned objects; operates on the stored record.
 */
export function repairOrphanedDriverLease(
  store: GoalStore,
  goalId: GoalId,
  receiptLog?: ReceiptLog,
): GoalRecord {
  const before = store.get(goalId);
  if (!before) throw new Error(`Goal ${goalId} not found`);
  const updated = store.repair(goalId, "driver-lease", {
    expectedVersion: before.recordVersion,
  });
  receiptLog?.push({
    goalId,
    eventType: "Recovery:driver-lease",
    fromState: before.state,
    toState: updated.state,
    recordVersion: updated.recordVersion,
    timestamp: new Date().toISOString(),
    transitionId: updated.lastTransitionId,
  });
  return updated;
}

/**
 * Repair a goal with a stale mutation lease through a persistent, audited
 * store repair (same guarantees as repairOrphanedDriverLease).
 */
export function repairStaleMutationLease(
  store: GoalStore,
  goalId: GoalId,
  receiptLog?: ReceiptLog,
): GoalRecord {
  const before = store.get(goalId);
  if (!before) throw new Error(`Goal ${goalId} not found`);
  const updated = store.repair(goalId, "mutation-lease", {
    expectedVersion: before.recordVersion,
  });
  receiptLog?.push({
    goalId,
    eventType: "Recovery:mutation-lease",
    fromState: before.state,
    toState: updated.state,
    recordVersion: updated.recordVersion,
    timestamp: new Date().toISOString(),
    transitionId: updated.lastTransitionId,
  });
  return updated;
}

/**
 * Clear recoveryRequired after successful lease repair (or explicit clear).
 * Uses the CAS-guarded store repair path; throws IgnoredEventError when the
 * flag is already false. continuation.ts canContinue works again afterwards.
 */
export function clearRecoveryRequired(
  store: GoalStore,
  goalId: GoalId,
  receiptLog?: ReceiptLog,
): GoalRecord {
  const before = store.get(goalId);
  if (!before) throw new Error(`Goal ${goalId} not found`);
  const updated = store.repair(goalId, "clear-recovery", {
    expectedVersion: before.recordVersion,
  });
  receiptLog?.push({
    goalId,
    eventType: "Recovery:clear-recovery",
    fromState: before.state,
    toState: updated.state,
    recordVersion: updated.recordVersion,
    timestamp: new Date().toISOString(),
    transitionId: updated.lastTransitionId,
  });
  return updated;
}
