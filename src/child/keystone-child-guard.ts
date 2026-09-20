// Keystone child guard — standalone Pi extension that runs INSIDE the child
// process (registered as a required child extension) and enforces the
// mutation lease at tool_call time.
//
// Authority transport contract (LOAD-BEARING): the lease reaches this guard
// ONLY via machine channels — never via model-visible task text (a sentinel
// block in task text is forgeable by the model, so sentinel parsing was
// deleted):
//
// 1. KEYSTONE_AUTHORITY_BLOB env: lease JSON placed by the runner host from
//    the spawn `extensionBindings` (`keystone/1` namespace). Read first.
// 2. PI_SUBAGENT_EXTENSION_BINDINGS env: raw bindings map on the detached
//    runner path; scanned for a `keystone*` namespace holding the lease.
// 3. Explicit `lease` option: injected authority for tests only.
//
// Missing/unreadable lease is fail-closed: ALL write/bash tools block; only
// the conservative read-only allowlist passes without a lease.
//
// LOAD-BEARING bash note: bash command-level inspection is imperfect — the
// guard sees a `command` string, not the shell's argv after expansion, so
// prefix/substring matching is bypassable (e.g. `allowlisted$(evil)` or
// `allowlisted; evil`). approvedCommands is therefore EXACT-MATCH-ONLY:
// the normalized full command must equal a listed entry. Anything else blocks.
//
// Blocking contract: violations and missing/expired leases return
// `{ block: true, reason: "keystone: ..." }`; allowed calls return undefined.
// Reasons name the tool and a capped (200-char) target echo only — never
// lease contents (no tokens, IDs, or signatures).

import * as fs from "node:fs";
import * as path from "node:path";
import type { MutationLeaseRecord } from "../execution/mutation-lease.js";

/** Env var carrying the lease JSON placed by the runner host. */
export const AUTHORITY_BLOB_ENV = "KEYSTONE_AUTHORITY_BLOB";

/** Env var carrying encoded spawn extensionBindings on the runner path. */
export const EXTENSION_BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";

/** Max lease JSON bytes accepted from any transport (fail closed above). */
const MAX_LEASE_BYTES = 64 * 1024;

/** Max attacker-controlled path characters echoed in a block reason. */
const MAX_PATH_ECHO = 200;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChildMutationMode = "textual" | "generated" | "dependency" | "migration";

/** Canonical lease family, extended with child-visible policy fields. */
export type ChildGuardLease = MutationLeaseRecord & {
  mutationMode?: ChildMutationMode | string;
  /** Exact full commands permitted for bash (exact-match-only, see note above). */
  approvedCommands?: string[];
  /** Extra read-only mcp tool names (`mcp__...`) permitted without a lease gate. */
  allowedMcpTools?: string[];
};

export type ChildToolCallEvent = {
  toolName?: unknown;
  input?: unknown;
};

export type ChildGuardBlock = { block: true; reason: string };

/** Minimal structural Pi surface used by this extension (duck-typed). */
export type MinimalPi = {
  on(event: string, handler: (event: ChildToolCallEvent) => unknown): unknown;
};

export type KeystoneChildGuardOptions = {
  /** Injected lease authority (tests only — never from task text). */
  lease?: ChildGuardLease;
  /** Environment source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Extra file-mutating tool names beyond the built-in edit/write set. */
  mutatingTools?: readonly string[];
  /** Extra shell-like tool names beyond the built-in bash set. */
  bashTools?: readonly string[];
  /** Clock override (tests). */
  now?: () => number;
};

// ─── Tool classification ────────────────────────────────────────────────────

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const BASH_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * Conservative read-only allowlist: tools that pass unblocked (no lease
 * required). Everything else is either enforced (write/bash) or denied as
 * unknown. `mcp__*` tools are NOT listed here — they pass only when the
 * lease names them in `allowedMcpTools`.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "glob", "structured_output"]);

function toolNameOf(event: ChildToolCallEvent): string | null {
  return typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : null;
}

/** Cap attacker-controlled echo in block reasons. */
function capEcho(raw: string): string {
  return raw.length > MAX_PATH_ECHO ? `${raw.slice(0, MAX_PATH_ECHO)}…` : raw;
}

/** Recursively collect every string value in an input payload. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/** Keys whose values are file paths (case-insensitive match). */
const PATH_KEYS: ReadonlySet<string> = new Set(
  [
    "path",
    "paths",
    "file",
    "files",
    "filepath",
    "file_path",
    "target",
    "targets",
    "filename",
    "absPath",
    "abspath",
    "absolutePath",
    "dest",
    "destination",
    "dir",
    "directory",
    "folder",
    "location",
    "outfile",
    "outputFile",
    "outputPath",
    "output_path",
  ].map((k) => k.toLowerCase()),
);

/** Keys whose values are file CONTENT, never paths — excluded from fallback. */
const CONTENT_KEYS: ReadonlySet<string> = new Set(
  ["content", "text", "data", "body", "diff", "patch", "oldText", "newText", "old_string", "new_string"].map(
    (k) => k.toLowerCase(),
  ),
);

/** Collect values held under known path-shaped keys (arrays/objects included). */
function collectPathKeyValues(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPathKeyValues(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_KEYS.has(k.toLowerCase())) {
        collectStrings(v, out);
      } else {
        collectPathKeyValues(v, out);
      }
    }
  }
}

/** Deep-walk fallback: every string EXCEPT values under content keys. */
function collectNonContentStrings(value: unknown, out: string[], underContentKey = false): void {
  if (typeof value === "string") {
    if (!underContentKey) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNonContentStrings(item, out, underContentKey);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectNonContentStrings(v, out, underContentKey || CONTENT_KEYS.has(k.toLowerCase()));
    }
  }
}

/** A string is path-shaped when it contains a separator or looks like a path. */
function isPathShaped(s: string): boolean {
  if (s.includes("\0")) return false;
  if (s.includes("/") || s.includes("\\")) return true;
  if (/^(~|\.{1,2})[\\/]/.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  return false;
}

/** Extract the bash command from tool input (deep search for command keys). */
function extractCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "fullCommand"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  // Nested fallback: first non-empty string under a command-named key.
  let found: string | null = null;
  const walk = (value: unknown): void => {
    if (found !== null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if ((k === "command" || k === "cmd" || k === "script") && typeof v === "string" && v.length > 0) {
          found = v;
          return;
        }
        walk(v);
      }
    }
  };
  walk(record);
  return found;
}

/** Collapse whitespace for exact-match comparison. */
function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** Command-capable modes may use bash; textual (and unknown) may not. */
function isCommandCapable(mode: unknown): boolean {
  return mode === "generated" || mode === "dependency" || mode === "migration";
}

// ─── Lease parsing ──────────────────────────────────────────────────────────

function isGuardLease(value: unknown): value is ChildGuardLease {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.leaseId === "string" &&
    typeof v.fencingToken === "number" &&
    typeof v.canonicalWorkspaceRoot === "string" &&
    Array.isArray(v.allowedCanonicalPaths) &&
    (v.allowedCanonicalPaths as unknown[]).every((p) => typeof p === "string") &&
    typeof v.expiresAt === "string"
  );
}

function parseLeaseJson(raw: string): ChildGuardLease | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_LEASE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isGuardLease(parsed) ? parsed : null;
}

/** Lease JSON placed by the runner host (from spawn extensionBindings). */
export function parseLeaseFromAuthorityBlob(env: NodeJS.ProcessEnv = process.env): ChildGuardLease | null {
  const raw = env[AUTHORITY_BLOB_ENV];
  if (!raw) return null;
  return parseLeaseJson(raw);
}

/** Best-effort lease read from a `keystone*` bindings namespace (runner path). */
export function parseLeaseFromBindingsEnv(env: NodeJS.ProcessEnv = process.env): ChildGuardLease | null {
  const raw = env[EXTENSION_BINDINGS_ENV];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  for (const [namespace, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!namespace.toLowerCase().includes("keystone")) continue;
    if (isGuardLease(value)) return value;
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (isGuardLease(nested)) return nested;
      }
    }
  }
  return null;
}

// ─── Path scope ─────────────────────────────────────────────────────────────

function normalizeAllowed(root: string, entry: string): string {
  const trimmed = entry.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.normalize(path.join(root, trimmed));
}

/** Resolve a tool target against the lease root; null when it escapes. */
function resolveTarget(root: string, raw: string): string | null {
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.join(root, raw);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

function isWithin(scope: string, target: string): boolean {
  if (target === scope) return true;
  const rel = path.relative(scope, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Realpath of an existing path, or null when it does not exist. */
function realpathIfExists(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Symlink containment: resolve the nearest EXISTING ancestor of the target
 * (walk up until realpath succeeds — a missing leaf under a symlinked
 * parent must not bypass the check), plus the root realpath, and require
 * containment of the resolved target within the resolved root.
 */
function passesSymlinkContainment(root: string, target: string): boolean {
  const realRoot = realpathIfExists(root) ?? root;
  // Walk up from the target to the nearest existing ancestor so a
  // non-existent leaf (e.g. allowed/link/newfile where link -> /etc)
  // still resolves through the symlinked parent.
  let probe = target;
  let realTarget: string | null = null;
  for (;;) {
    const real = realpathIfExists(probe);
    if (real !== null) {
      const remainder = path.relative(probe, target);
      realTarget = remainder === "" ? real : path.join(real, remainder);
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return true; // nothing on disk at all — lexical check rules
    probe = parent;
  }
  if (realTarget === null) return true;
  return realTarget === realRoot || isWithin(realRoot, realTarget);
}

// ─── Decision ───────────────────────────────────────────────────────────────

/**
 * Pure tool_call decision. Returns a block verdict or undefined (allow).
 * `nowMs` defaults to Date.now(); inject in tests for expiry edges.
 */
export function decideToolCall(
  event: ChildToolCallEvent,
  lease: ChildGuardLease | null,
  options?: { mutatingTools?: readonly string[]; bashTools?: readonly string[] },
  nowMs?: number,
): ChildGuardBlock | undefined {
  const name = toolNameOf(event);
  if (name === null) return { block: true, reason: "keystone: unknown tool denied" };
  const writeTools = options?.mutatingTools ? new Set([...WRITE_TOOLS, ...options.mutatingTools]) : WRITE_TOOLS;
  const bashTools = options?.bashTools ? new Set([...BASH_TOOLS, ...options.bashTools]) : BASH_TOOLS;
  const isWrite = writeTools.has(name);
  const isBash = bashTools.has(name);
  const isReadOnly = READ_ONLY_TOOLS.has(name);
  const isMcp = name === "mcp" || name.startsWith("mcp__");

  // Fail-closed default: anything not classified above is an unknown tool.
  if (!isWrite && !isBash && !isReadOnly && !isMcp) {
    return { block: true, reason: "keystone: unknown tool denied" };
  }

  // Read-only allowlist passes unblocked (no lease required).
  if (isReadOnly) return undefined;

  // MCP passes only when the lease explicitly names the tool.
  if (isMcp && !isWrite && !isBash) {
    if (lease && (lease.allowedMcpTools ?? []).includes(name)) return undefined;
    return { block: true, reason: `keystone: ${name} denied — not in lease read-only mcp allowlist` };
  }

  // Enforced tools require a live lease (fail-closed when absent).
  const now = nowMs ?? Date.now();
  if (!lease) {
    return { block: true, reason: `keystone: no authority lease held — ${name} blocked` };
  }
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    return { block: true, reason: `keystone: authority lease expired — ${name} blocked` };
  }

  if (isBash) {
    // LOAD-BEARING: bash command-level inspection is imperfect (no shell
    // argv visibility), so approvedCommands is exact-match-only: the full
    // normalized command must equal a listed entry. Textual-mode leases
    // never get bash.
    if (!isCommandCapable(lease.mutationMode)) {
      const mode = typeof lease.mutationMode === "string" ? lease.mutationMode : "textual";
      return { block: true, reason: `keystone: ${name} denied under '${mode}' mutation mode` };
    }
    const approved = lease.approvedCommands ?? [];
    if (approved.length === 0) {
      return { block: true, reason: `keystone: ${name} denied — no approved commands on lease` };
    }
    const raw = extractCommand(event.input);
    if (raw === null) {
      return { block: true, reason: `keystone: ${name} command not resolvable — blocked` };
    }
    const want = normalizeCommand(raw);
    const allowed = new Set(approved.map(normalizeCommand));
    if (!allowed.has(want)) {
      return { block: true, reason: `keystone: ${name} command '${capEcho(want)}' not in approved commands — blocked` };
    }
    return undefined;
  }

  // Write path: path-keyed values are scope-checked UNCONDITIONALLY — a bare
  // filename under a path key (e.g. outputPath: "evil.sh") resolves against
  // the root and may land outside the subdir scope, so the isPathShaped
  // filter applies ONLY to the deep-walk fallback. Fallback union is an
  // availability tradeoff: any non-content string containing "/" is
  // scope-checked, so slash gibberish fail-closed (deny) rather than bypass.
  // A decoy in-scope `path` key must not mask an out-of-scope
  // `outputPath`/nested value. Fail-closed: no resolvable target blocks.
  const keyed: string[] = [];
  collectPathKeyValues(event.input, keyed);
  const fallback: string[] = [];
  collectNonContentStrings(event.input, fallback);
  const candidates = [...keyed, ...fallback.filter(isPathShaped)];
  if (candidates.length === 0) {
    return { block: true, reason: `keystone: ${name} target not resolvable — no path key found — blocked` };
  }
  const root = path.normalize(lease.canonicalWorkspaceRoot);
  const scopes = lease.allowedCanonicalPaths.map((entry) => normalizeAllowed(root, entry));
  for (const raw of candidates) {
    const target = resolveTarget(root, raw);
    if (target === null) {
      return { block: true, reason: `keystone: ${name} target '${capEcho(raw)}' escapes workspace root — blocked` };
    }
    if (!passesSymlinkContainment(root, target)) {
      return { block: true, reason: `keystone: ${name} target '${capEcho(raw)}' escapes via symlink — blocked` };
    }
    // allowedCanonicalPaths is an exact acquired write-set, not a directory
    // prefix allowlist. Treating an allowed path as a subtree would silently
    // widen a lease for a non-existent path (or an acquisition mistake).
    if (!scopes.some((scope) => target === scope)) {
      return { block: true, reason: `keystone: ${name} target '${capEcho(raw)}' outside lease scope (exact write-set) — blocked` };
    }
  }
  return undefined;
}

// ─── Extension entrypoint ───────────────────────────────────────────────────

function loadLease(options?: KeystoneChildGuardOptions): ChildGuardLease | null {
  if (options?.lease && isGuardLease(options.lease)) return options.lease;
  const env = options?.env ?? process.env;
  return parseLeaseFromAuthorityBlob(env) ?? parseLeaseFromBindingsEnv(env);
}

/**
 * Re-read the authoritative filesystem lease for an env-transported child.
 * Heartbeats update this file, while the launch-time env snapshot is immutable.
 * Policy-only fields (mutationMode/approvedCommands/allowedMcpTools) remain
 * launch-bound, but authority identity/scope/phase/expiry come from disk.
 * Missing, corrupt, replaced, or non-MUTATING leases revoke mutation access.
 */
function refreshPersistedLease(seed: ChildGuardLease): ChildGuardLease | null {
  const leaseFile = path.join(seed.canonicalWorkspaceRoot, ".keystone-lease.json");
  let raw: string;
  try {
    const stat = fs.statSync(leaseFile);
    if (stat.size <= 0 || stat.size > MAX_LEASE_BYTES) return null;
    raw = fs.readFileSync(leaseFile, "utf8");
  } catch {
    return null;
  }
  const persisted = parseLeaseJson(raw);
  if (!persisted) return null;
  if (
    persisted.leaseId !== seed.leaseId ||
    persisted.fencingToken !== seed.fencingToken ||
    persisted.assignmentId !== seed.assignmentId ||
    persisted.sessionId !== seed.sessionId ||
    persisted.canonicalWorkspaceRoot !== seed.canonicalWorkspaceRoot ||
    persisted.phase !== "MUTATING"
  ) {
    return null;
  }
  return {
    ...seed,
    ...persisted,
    mutationMode: seed.mutationMode,
    approvedCommands: seed.approvedCommands,
    allowedMcpTools: seed.allowedMcpTools,
  };
}

/** Build a tool_call handler bound to the given lease resolver. */
export function createToolCallHandler(
  resolveLease: () => ChildGuardLease | null,
  options?: { mutatingTools?: readonly string[]; bashTools?: readonly string[]; now?: () => number },
): (event: ChildToolCallEvent) => ChildGuardBlock | undefined {
  return (event: ChildToolCallEvent) => decideToolCall(event, resolveLease(), options, options?.now?.());
}

/**
 * Standalone Pi extension factory. Registered by absolute path as a required
 * child extension; Pi loads it inside the child process.
 */
export default async function keystoneChildGuard(pi: MinimalPi, options?: KeystoneChildGuardOptions): Promise<void> {
  // Explicit lease injection is a test seam and remains self-contained.
  // Real runner children receive immutable env bindings, so cache only that
  // seed identity/policy and refresh the authoritative lease file per call.
  const injected = options?.lease && isGuardLease(options.lease) ? options.lease : null;
  let transported: ChildGuardLease | null | undefined;
  const resolveLease = (): ChildGuardLease | null => {
    if (injected) return injected;
    if (transported === undefined) transported = loadLease(options);
    if (!transported) return null;
    return refreshPersistedLease(transported);
  };
  pi.on("tool_call", createToolCallHandler(resolveLease, options));
}
