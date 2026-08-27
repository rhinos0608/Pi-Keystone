// Cancellation settlement, quarantine, and startup recovery
// Phase 4 — P4-W7

import type {
  GoalRecord,
  GoalEvent,
  MutationLease,
  DriverLease,
  ArtifactRef,
  ISO8601,
} from "../domain/types.js";

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
    return {
      outcome: "ROLLED_BACK",
      event: {
        type: "CancellationSettled",
        cleanupRef: "" as ArtifactRef,
        mutationOutcome: "ROLLED_BACK",
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
  | { kind: "stale_mutation_lease"; goalId: string; leaseId: string }
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
 * Repair a goal with an orphaned driver lease by clearing the stale lease
 * and incrementing the record version.
 * Returns the patched record (mutated in place for simplicity).
 */
export function repairOrphanedDriverLease(
  record: GoalRecord,
): GoalRecord {
  record.activeDriverLease = undefined;
  record.recoveryRequired = true;
  record.recordVersion += 1;
  return record;
}

/**
 * Repair a goal with a stale mutation lease by clearing it.
 */
export function repairStaleMutationLease(
  record: GoalRecord,
): GoalRecord {
  record.activeMutationLease = undefined;
  record.recoveryRequired = true;
  record.recordVersion += 1;
  return record;
}
