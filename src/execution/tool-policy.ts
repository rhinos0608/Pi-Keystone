// Tool access policy — allowlist-only. There is no denylist: read-only mode
// names the exact tools allowed and denies everything else by default.
//
// Mutation mode requires a structural permit bound to a lease: the permit
// embeds leaseId + fencingToken and is validated against the lease record
// passed in. Even with a valid permit, only mode-appropriate tools pass:
// [read, grep, find, ls, glob, edit, write], plus bash only under the
// exact-match approvedCommands rule (command-capable mode + nonempty
// approved list + normalized full-command equality).

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolPolicyKind = "read-only" | "mutation" | "restricted";

/** Structural mutation permit: bound to one lease acquisition. */
export type MutationPermit = {
  leaseId: string;
  fencingToken: number;
};

/** Lease identity presented for permit validation. */
export type LeaseBinding = {
  leaseId: string;
  fencingToken: number;
};

export type ToolPolicy = {
  kind: ToolPolicyKind;
  /** For "restricted": the exact tool names that are allowed. */
  allowed?: string[];
  /**
   * For "mutation": structural permit, validated against the lease record.
   */
  permit?: MutationPermit;
  /**
   * For "mutation": mutation mode governing bash. Only "generated",
   * "dependency", or "migration" may use bash, and only via exact-match
   * approvedCommands. Defaults to "textual" (no bash).
   */
  mutationMode?: string;
  /**
   * For "mutation": exact full commands permitted for bash. Compared by
   * normalized (whitespace-collapsed) full-string equality; the first token
   * must also match a listed binary. Bash command-level inspection is
   * imperfect, so prefix/substring matching is never used.
   */
  approvedCommands?: string[];
  /**
   * For "mutation": extra read-only mcp tool names (`mcp__...`) permitted.
   * mcp tools are denied unless the lease names them here (nonempty list).
   */
  allowedMcpTools?: string[];
  /**
   * Legacy leaseId-only claim. RETAINED as an ignored field so older
   * launchers still compile; it is NEVER honored — a bare leaseId claim
   * grants nothing. New code must use `permit`.
   */
  permitToken?: string;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Bash command context for exact-match evaluation (tool input). */
export type BashCommandContext = {
  command?: string;
};

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Read-only allowlist: read/grep/find/ls plus glob (read-only query) and structured_output. */
const READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "glob", "structured_output"]);

/** Mutation allowlist: read tools plus edit/write. Bash handled separately. */
const MUTATION_ALLOWLIST: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "edit",
  "write",
]);

const COMMAND_CAPABLE_MODES: ReadonlySet<string> = new Set(["generated", "dependency", "migration"]);

// ─── API ────────────────────────────────────────────────────────────────────

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Decide whether `toolName` is permitted under `policy`.
 * For mutation policies pass the active lease as `lease` so the permit is
 * validated against it (leaseId + fencingToken must both match).
 * For bash under a mutation policy pass the requested command as
 * `bash.command` for exact-match approvedCommands evaluation.
 * Returns a discriminated decision — never throws.
 */
export function enforceToolPolicy(
  toolName: string,
  policy: ToolPolicy,
  lease?: LeaseBinding,
  bash?: BashCommandContext,
): PolicyDecision {
  if (policy.kind === "read-only") {
    if (READ_ONLY_ALLOWLIST.has(toolName)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `tool "${toolName}" denied under read-only policy (not in allowlist)` };
  }

  if (policy.kind === "restricted") {
    const list = policy.allowed ?? [];
    if (list.includes(toolName)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `tool "${toolName}" not in restricted allow-list` };
  }

  // mutation — structural binding required (`permitToken` is never honored).
  const permit = policy.permit;
  if (!permit) {
    return { allowed: false, reason: `tool "${toolName}" requires mutation permit` };
  }
  if (!lease) {
    return { allowed: false, reason: `tool "${toolName}" requires a bound lease for mutation permit validation` };
  }
  if (lease.leaseId !== permit.leaseId) {
    return { allowed: false, reason: `mutation permit lease mismatch for tool "${toolName}"` };
  }
  if (lease.fencingToken !== permit.fencingToken) {
    return { allowed: false, reason: `mutation permit fencing-token mismatch for tool "${toolName}"` };
  }

  // Bound permit valid — still restricted to mode-appropriate tools.
  // mcp tools pass only when the lease explicitly names them (nonempty list).
  if (toolName === "mcp" || toolName.startsWith("mcp__")) {
    const allowed = policy.allowedMcpTools ?? [];
    if (allowed.length > 0 && allowed.includes(toolName)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `tool "${toolName}" denied — not in lease read-only mcp allowlist` };
  }
  if (toolName === "bash") {
    const mode = policy.mutationMode ?? "textual";
    if (!COMMAND_CAPABLE_MODES.has(mode)) {
      return { allowed: false, reason: `tool "bash" denied under '${mode}' mutation mode` };
    }
    const approved = policy.approvedCommands ?? [];
    if (approved.length === 0) {
      return { allowed: false, reason: `tool "bash" denied — no approved commands on policy` };
    }
    const raw = bash?.command;
    if (typeof raw !== "string" || raw.length === 0) {
      return { allowed: false, reason: `tool "bash" command not resolvable — blocked` };
    }
    const want = normalizeCommand(raw);
    const allowed = new Set(approved.map(normalizeCommand));
    if (!allowed.has(want)) {
      return { allowed: false, reason: `tool "bash" command not in approved commands — blocked` };
    }
    return { allowed: true };
  }
  if (MUTATION_ALLOWLIST.has(toolName)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `tool "${toolName}" denied under mutation policy (not in allowlist)` };
}
