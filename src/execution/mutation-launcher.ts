// Mutation worker launcher — dispatches assignment to a session with
// mutation tools guarded by worker-guard. Two-phase protocol:
//   1. Acquisition turn (read-only) — reads context, builds plan
//   2. Mutation turn (after authority receipt) — applies changes
//
// Requires a valid MutationLease. Lease validation is performed here;
// worker-guard enforces the policy at tool-call time.

import type { AssignmentId, MutationLease } from "../domain/types.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { ContextView, WorkerDelegation, WorkerReport } from "./read-only-launcher.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Phases of the two-phase mutation protocol. */
export type MutationPhase = "acquisition" | "mutation";

/** The delegation config for a single turn within a mutation session. */
export type MutationTurn = {
  phase: MutationPhase;
  delegation: WorkerDelegation;
};

/** Result of dispatchMutation — two-phase delegations + captured report. */
export type MutationLaunchResult = {
  /** Two delegation configs: acquisition (read-only) then mutation. */
  turns: [acquisition: MutationTurn, mutation: MutationTurn];
  /** The validated lease carried through both turns. */
  lease: MutationLease;
  /** Null until session completes. */
  report: WorkerReport | null;
};

// ─── Lease Validation ───────────────────────────────────────────────────────

export type LeaseValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a MutationLease for dispatch.
 * - Must not be expired
 * - Must be in a launchable phase (ACQUIRED or AUTHORITY_READY)
 */
export function validateMutationLease(
  lease: MutationLease,
  now?: Date,
): LeaseValidation {
  const nowMs = now?.getTime() ?? Date.now();

  if (new Date(lease.expiresAt).getTime() <= nowMs) {
    return { ok: false, reason: "lease expired" };
  }

  if (lease.phase !== "ACQUIRED" && lease.phase !== "AUTHORITY_READY") {
    return { ok: false, reason: `lease phase "${lease.phase}" not launchable (need ACQUIRED or AUTHORITY_READY)` };
  }

  return { ok: true };
}

// ─── API ────────────────────────────────────────────────────────────────────

/** Policy for the acquisition turn — always read-only. */
const ACQUISITION_POLICY: ToolPolicy = { kind: "read-only" };

/**
 * Build the mutation policy that requires a permit token from worker-guard.
 */
function mutationPolicy(lease: MutationLease): ToolPolicy {
  return {
    kind: "mutation",
    permitToken: lease.leaseId,
  };
}

/**
 * Dispatch an assignment to a mutation worker via two-phase protocol.
 *
 * Phase 1 (acquisition): read-only turn. Worker reads context, builds
 * a mutation plan, and signals readiness.
 *
 * Phase 2 (mutation): mutation tools enabled via worker-guard permit.
 * Only runs after authority receipt (lease phase transitions to
 * AUTHORITY_READY). The worker-guard validates the permit token
 * against the lease before allowing bash/write/edit calls.
 *
 * Throws if lease validation fails.
 */
export function dispatchMutation(
  assignment: { id: AssignmentId; description: string; targetFiles: string[] },
  contextView: ContextView,
  lease: MutationLease,
  now?: Date,
): MutationLaunchResult {
  if (!assignment.id) throw new Error("assignment.id required");
  if (!contextView.goalId) throw new Error("contextView.goalId required");
  if (!contextView.task) throw new Error("contextView.task required");

  const validation = validateMutationLease(lease, now);
  if (!validation.ok) {
    throw new Error(`invalid mutation lease: ${validation.reason}`);
  }

  // Verify lease is for this assignment
  if (lease.assignmentId !== assignment.id) {
    throw new Error(
      `lease assignment mismatch: lease=${lease.assignmentId} assignment=${assignment.id}`,
    );
  }

  const baseContext: WorkerDelegation = {
    assignmentId: assignment.id,
    task: assignment.description,
    contextView,
    toolPolicy: ACQUISITION_POLICY,
  };

  return {
    turns: [
      { phase: "acquisition", delegation: { ...baseContext, toolPolicy: ACQUISITION_POLICY } },
      { phase: "mutation", delegation: { ...baseContext, toolPolicy: mutationPolicy(lease) } },
    ],
    lease,
    report: null,
  };
}
