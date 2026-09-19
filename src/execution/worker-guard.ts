// Worker guard — parent-side receipt bookkeeping for tool_call events.
//
// Path confinement is NOT enforced here. Write-scope validation belongs to
// the Keystone child guard extension (src/child/keystone-child-guard.ts),
// which runs inside the child process and sees the real tool arguments.
// This guard only records per-call receipts (GuardReceipt: toolCallId,
// toolName, sessionId, decision, reason, and at), stamped with an
// attestation nonce.

import { randomUUID } from "node:crypto";
import { enforceToolPolicy, type LeaseBinding, type ToolPolicy } from "./tool-policy.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolCallEvent = {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  /** Assignment this call claims to serve (checked when the guard binds one). */
  assignmentId?: string;
  /** Requested bash command (exact-match evaluation under mutation policy). */
  command?: string;
};

export type GuardLease = {
  /** Lease identity for structural permit binding; absent on legacy leases. */
  leaseId?: string;
  root: string;
  fencingToken: number;
  expiresAt: number;
  /** Assignment the lease was acquired for (checked when the guard binds one). */
  assignmentId?: string;
};

export type GuardReceipt = {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  decision: "allow" | "deny";
  reason?: string;
  at: string;
};

export type GuardResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; attestationNonce: string };

export type WorkerGuard = {
  sessionId: string;
  policy: ToolPolicy;
  attestationNonce: string;
  /** Append-only bookkeeping of every checked call, in check order. */
  receipts: GuardReceipt[];
  check(event: ToolCallEvent, lease?: GuardLease): GuardResult;
};

// ─── Factory ────────────────────────────────────────────────────────────────

function bindingOf(lease: GuardLease | undefined): LeaseBinding | undefined {
  if (!lease || lease.leaseId === undefined) return undefined;
  return { leaseId: lease.leaseId, fencingToken: lease.fencingToken };
}

/**
 * Create a worker guard that enforces `policy` for a session.
 * Each guard gets a unique attestation nonce for the session.
 */
export function registerWorkerGuard(
  policy: ToolPolicy,
  options?: { sessionId?: string; lease?: GuardLease; assignmentId?: string },
): WorkerGuard {
  const sid = options?.sessionId ?? randomUUID();
  const nonce = randomUUID();
  const boundLease = options?.lease;
  const expectedAssignment = options?.assignmentId ?? boundLease?.assignmentId;
  const receipts: GuardReceipt[] = [];

  function record(
    event: ToolCallEvent,
    decision: "allow" | "deny",
    reason?: string,
  ): void {
    receipts.push({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      sessionId: event.sessionId,
      decision,
      ...(reason !== undefined ? { reason } : {}),
      at: new Date().toISOString(),
    });
  }

  function deny(event: ToolCallEvent, reason: string): GuardResult {
    record(event, "deny", reason);
    return { decision: "deny", reason, attestationNonce: nonce };
  }

  return {
    sessionId: sid,
    policy,
    attestationNonce: nonce,
    receipts,
    check(event: ToolCallEvent, lease?: GuardLease) {
      // Cross-session check
      if (event.sessionId !== sid) {
        return deny(event, `session mismatch: expected ${sid}, got ${event.sessionId}`);
      }

      // Mutation policy: lease is mandatory and must be live.
      const effectiveLease = lease ?? boundLease;
      if (policy.kind === "mutation") {
        if (!effectiveLease) {
          return deny(event, `mutation policy requires a lease but none was provided`);
        }
        // Lease root must be a non-empty binding — an empty root would make
        // reduced-scope checks vacuous, so deny before reaching the policy.
        if (typeof effectiveLease.root !== "string" || effectiveLease.root.length === 0) {
          return deny(event, `mutation policy requires a non-empty lease root`);
        }
        if (effectiveLease.expiresAt <= Date.now()) {
          return deny(
            event,
            `lease expired at ${new Date(effectiveLease.expiresAt).toISOString()}`,
          );
        }
        // Assignment binding: when the guard knows the expected assignment,
        // the event and lease must agree with it — keeps reduced scope honest.
        if (expectedAssignment !== undefined) {
          const leaseAssignment = effectiveLease.assignmentId;
          if (leaseAssignment !== undefined && leaseAssignment !== expectedAssignment) {
            return deny(
              event,
              `lease assignment mismatch: expected ${expectedAssignment}, got ${leaseAssignment}`,
            );
          }
          if (event.assignmentId !== undefined && event.assignmentId !== expectedAssignment) {
            return deny(
              event,
              `event assignment mismatch: expected ${expectedAssignment}, got ${event.assignmentId}`,
            );
          }
        }
      }

      const result = enforceToolPolicy(event.toolName, policy, bindingOf(effectiveLease), {
        command: event.command,
      });
      if (result.allowed) {
        record(event, "allow");
        return { decision: "allow" };
      }
      return deny(event, result.reason);
    },
  };
}
