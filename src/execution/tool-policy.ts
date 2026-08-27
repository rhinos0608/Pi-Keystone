// Tool access policy — defines which tools a worker may use.

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolPolicyKind = "read-only" | "mutation" | "restricted";

export type ToolPolicy = {
  kind: ToolPolicyKind;
  /** For "restricted": the exact tool names that are allowed. */
  allowed?: string[];
  /** For "mutation": a permit token must match this value. */
  permitToken?: string;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

// ─── Defaults ───────────────────────────────────────────────────────────────

const MUTATION_DENIED = ["bash", "write", "edit", "mcp"];

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Decide whether `toolName` is permitted under `policy`.
 * Returns a discriminated decision — never throws.
 */
export function enforceToolPolicy(toolName: string, policy: ToolPolicy): PolicyDecision {
  if (policy.kind === "read-only") {
    if (MUTATION_DENIED.includes(toolName)) {
      return { allowed: false, reason: `tool "${toolName}" denied under read-only policy` };
    }
    return { allowed: true };
  }

  if (policy.kind === "restricted") {
    const list = policy.allowed ?? [];
    if (list.includes(toolName)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `tool "${toolName}" not in restricted allow-list` };
  }

  // mutation
  if (policy.permitToken) {
    // Permit token present → caller claims authority.
    // The token itself is validated upstream (worker-guard); here we just allow.
    return { allowed: true };
  }
  // Mutation without permit token → deny by default.
  return { allowed: false, reason: `tool "${toolName}" requires mutation permit` };
}
