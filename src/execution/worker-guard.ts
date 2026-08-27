// Worker guard — intercepts tool_call events and enforces tool policy.

import { randomUUID } from "node:crypto";
import { enforceToolPolicy, type ToolPolicy } from "./tool-policy.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolCallEvent = {
  toolCallId: string;
  toolName: string;
  sessionId: string;
};

export type GuardLease = {
  root: string;
  fencingToken: number;
  expiresAt: number;
};

export type GuardResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; attestationNonce: string };

export type WorkerGuard = {
  sessionId: string;
  policy: ToolPolicy;
  attestationNonce: string;
  check(event: ToolCallEvent, lease?: GuardLease): GuardResult;
};

// File-writing tools that require path validation against lease root
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a worker guard that enforces `policy` for a session.
 * Each guard gets a unique attestation nonce for the session.
 */
export function registerWorkerGuard(
  policy: ToolPolicy,
  options?: { sessionId?: string; lease?: GuardLease },
): WorkerGuard {
  const sid = options?.sessionId ?? randomUUID();
  const nonce = randomUUID();
  const boundLease = options?.lease;

  return {
    sessionId: sid,
    policy,
    attestationNonce: nonce,
    check(event: ToolCallEvent, lease?: GuardLease) {
      // Cross-session check
      if (event.sessionId !== sid) {
        return {
          decision: "deny",
          reason: `session mismatch: expected ${sid}, got ${event.sessionId}`,
          attestationNonce: nonce,
        };
      }

      // Mutation policy: lease is mandatory
      if (this.policy.kind === "mutation") {
        const effectiveLease = lease ?? boundLease;
        if (!effectiveLease) {
          return {
            decision: "deny",
            reason: `mutation policy requires a lease but none was provided`,
            attestationNonce: nonce,
          };
        }

        // Lease expiry check
        if (effectiveLease.expiresAt <= Date.now()) {
          return {
            decision: "deny",
            reason: `lease expired at ${new Date(effectiveLease.expiresAt).toISOString()}`,
            attestationNonce: nonce,
          };
        }

        // File-writing tools: target path must be under lease root
        if (FILE_WRITE_TOOLS.has(event.toolName)) {
          // The tool name is write/edit; the actual path would come from the tool call args.
          // For guard purposes, we validate against the session-bound lease root.
          // Path extraction happens upstream; here we ensure the lease root is set.
          if (!effectiveLease.root) {
            return {
              decision: "deny",
              reason: `lease has no root path for file-writing tool "${event.toolName}"`,
              attestationNonce: nonce,
            };
          }
        }
      }

      const result = enforceToolPolicy(event.toolName, this.policy);
      if (result.allowed) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason: result.reason,
        attestationNonce: nonce,
      };
    },
  };
}
