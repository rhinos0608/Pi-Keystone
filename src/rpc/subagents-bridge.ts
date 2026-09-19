// pi-subagents integration bridge — Task 7 (Wave 3a).
//
// Capability ceilings + required child extensions are session-scoped
// registries owned by pi-subagents. Both use Symbol.for global registries:
//   ceiling:  Symbol.for("pi-subagents.capability-ceiling.v1")
//             → Map<sessionId, Map<symbol, { source, ceiling }>>
//   required: Symbol.for("pi-subagents.required-child-extensions.v1")
//             → { version: 1, bySession: Map<sessionId, snapshot> >
//
// This module is a thin typed bridge: it resolves those globals without
// importing pi-subagents (not a dependency) and fails loud with a typed
// error when the registry is absent (pi-subagents not loaded). It never
// creates the registries itself — creation is the runtime's job.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Registry keys (mirror pi-subagents sources) ────────────────────────────

export const CAPABILITY_CEILING_REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";
export const REQUIRED_CHILD_EXTENSIONS_REGISTRY_KEY = "pi-subagents.required-child-extensions.v1";

// ─── Typed error ────────────────────────────────────────────────────────────

export class SubagentsBridgeError extends Error {
  readonly code = "SUBAGENTS_BRIDGE_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SubagentsBridgeError";
  }
}

// ─── Registry shapes (structural mirrors, no pi-subagents import) ──────────

export type CeilingRegistration = {
  source: string;
  ceiling: {
    version: 1;
    allowedTools?: string[];
    allowedAgents?: string[];
    denyExtensions: boolean;
    sources: string[];
  };
};

export type CeilingRegistry = Map<string, Map<symbol, CeilingRegistration>>;

export type RequiredChildExtensionEntry = { id: string; path: string };

export type RequiredChildRegistry = {
  version: 1;
  bySession: Map<string, readonly RequiredChildExtensionEntry[]>;
};

function globalRoot(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

export function resolveCeilingRegistry(): CeilingRegistry {
  const key = Symbol.for(CAPABILITY_CEILING_REGISTRY_KEY);
  const existing = globalRoot()[key];
  if (existing instanceof Map) return existing as CeilingRegistry;
  // Create-on-absent mirrors pi-subagents' own registry() construction
  // (capability-ceiling.ts registry()): the Map is created lazily there, so a
  // fresh session has no registry until someone registers — Keystone must not
  // treat absence as "extension not loaded" or live bridging deadlocks.
  const created: CeilingRegistry = new Map();
  globalRoot()[key] = created;
  return created;
}

export function resolveRequiredChildRegistry(): RequiredChildRegistry {
  const key = Symbol.for(REQUIRED_CHILD_EXTENSIONS_REGISTRY_KEY);
  const existing = globalRoot()[key];
  if (
    existing !== null &&
    typeof existing === "object" &&
    (existing as { version?: unknown }).version === 1 &&
    (existing as { bySession?: unknown }).bySession instanceof Map
  ) {
    return existing as RequiredChildRegistry;
  }
  if (existing !== undefined) {
    throw new SubagentsBridgeError(
      `Required-child-extensions registry malformed (Symbol.for("${REQUIRED_CHILD_EXTENSIONS_REGISTRY_KEY}")).`,
    );
  }
  // Create-on-absent mirrors pi-subagents' own registry() (required-child-extensions.ts).
  const created: RequiredChildRegistry = { version: 1, bySession: new Map() };
  globalRoot()[key] = created;
  return created;
}

// ─── Keystone session policy ────────────────────────────────────────────────

/** Read-only ceiling for readers/planners/auditors: allowlist, never denylist. */
export const KEYSTONE_READER_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "glob"] as const;

/** Mutation ceiling: reader tools + write tools (no bash — textual mode). */
export const KEYSTONE_MUTATION_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "glob", "edit", "write"] as const;

/** Per-spawn ceiling mode. Reader is the session default; mutation is set before a mutation spawn and reset after. */
export type SpawnCeilingMode = "reader" | "mutation";

const SPAWN_CEILING_TOOLS: Record<SpawnCeilingMode, readonly string[]> = {
  reader: KEYSTONE_READER_ALLOWED_TOOLS,
  mutation: KEYSTONE_MUTATION_ALLOWED_TOOLS,
};

export const KEYSTONE_BRIDGE_SOURCE = "keystone";

export const KEYSTONE_CHILD_GUARD_ID = "keystone-child-guard";

/**
 * Absolute path of the child guard extension file. The guard FILE is owned
 * by the Task 8 wave and may be created concurrently — only the path
 * matters here, so this resolves without touching the filesystem.
 */
export function defaultChildGuardPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "child", "keystone-child-guard.ts");
}

export type BridgeHandle = { dispose(): void };

export type EnsureBridgesOptions = {
  source?: string;
  readerAllowedTools?: readonly string[];
  childGuardId?: string;
  childGuardPath?: string;
};

const bridgedSessions = new Set<string>();
/** Own ceiling tokens per session (never touch foreign owners' tokens). */
const ownCeilingTokens = new Map<string, Set<symbol>>();
/** Per-session mutation ceiling nesting depth: reader restores only at zero. */
const mutationNestingDepth = new Map<string, number>();
/** Own required-child snapshot per session (identity-checked before delete). */
const ownRequiredSnapshots = new Map<string, readonly RequiredChildExtensionEntry[]>();

export function isBridged(sessionId: string): boolean {
  return bridgedSessions.has(sessionId);
}

// ─── Input validation (mirrors pi-subagents' own registry guards) ──────────
// Fail LOUD here instead of deferring to a child-load failure.

/** Tool-name shape accepted by pi-subagents ceilings. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_ALLOWED_TOOLS = 64;

/** normalizeCeiling semantics: validate, dedupe, sort. Throws on malformed input. */
export function normalizeAllowedTools(tools: readonly string[]): string[] {
  if (tools.length > MAX_ALLOWED_TOOLS) {
    throw new Error(`keystone bridge: too many ceiling tools (${tools.length} > ${MAX_ALLOWED_TOOLS})`);
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "string" || tool.length === 0) {
      throw new Error("keystone bridge: ceiling tool names must be non-empty strings");
    }
    if (tool.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(tool)) {
      throw new Error(`keystone bridge: malformed ceiling tool name ${JSON.stringify(tool)}`);
    }
    seen.add(tool);
  }
  return [...seen].sort();
}

/** Validate the required child-guard entry: id sane, path absolute + real file. */
export function validateChildGuardEntry(guardId: string, guardPath: string): string {
  if (typeof guardId !== "string" || guardId.length === 0 || /\s/.test(guardId)) {
    throw new Error(`keystone bridge: malformed child-guard id ${JSON.stringify(guardId)}`);
  }
  if (typeof guardPath !== "string" || guardPath.length === 0 || !path.isAbsolute(guardPath)) {
    throw new Error(`keystone bridge: child-guard path must be absolute, got ${JSON.stringify(guardPath)}`);
  }
  let real: string;
  try {
    real = fs.realpathSync(guardPath);
  } catch {
    throw new Error(`keystone bridge: child-guard path does not resolve: ${guardPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new Error(`keystone bridge: child-guard path not statable: ${real}`);
  }
  if (!stat.isFile()) {
    throw new Error(`keystone bridge: child-guard path is not a file: ${real}`);
  }
  return real;
}

/**
 * Register Keystone's pi-subagents session policy once per session:
 * read-only capability ceiling + required child-guard extension.
 * Idempotent per sessionId (second call is a no-op returning fresh
 * dispose handles is avoided — returns no-op handles instead).
 * Required-extensions use dispose-first handling: a pre-existing snapshot
 * for the session is disposed before registering (pi-subagents'
 * registerRequiredChildExtensions throws if a snapshot exists).
 * Disposal removes ONLY keystone's own tokens/entries (identity-checked),
 * mirroring official pi-subagents dispose (own token only).
 */
export function ensureKeystoneSessionBridges(
  sessionId: string,
  options?: EnsureBridgesOptions,
): { ceiling: BridgeHandle; required: BridgeHandle; fresh: boolean } {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("keystone bridge: sessionId must be a non-empty string");
  }
  const source = options?.source ?? KEYSTONE_BRIDGE_SOURCE;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("keystone bridge: source must be a non-empty string");
  }
  // Validate BEFORE touching the registries: malformed input fails loud here.
  const allowedTools = normalizeAllowedTools(options?.readerAllowedTools ?? KEYSTONE_READER_ALLOWED_TOOLS);
  const guardId = options?.childGuardId ?? KEYSTONE_CHILD_GUARD_ID;
  const guardPath = validateChildGuardEntry(guardId, options?.childGuardPath ?? defaultChildGuardPath());
  if (bridgedSessions.has(sessionId)) {
    const noop = { dispose(): void {} };
    return { ceiling: noop, required: noop, fresh: false };
  }

  const ceilings = resolveCeilingRegistry();
  const required = resolveRequiredChildRegistry();

  let session = ceilings.get(sessionId);
  if (!session) {
    session = new Map();
    ceilings.set(sessionId, session);
  }
  const token = Symbol(source);
  const ceilingRecord: CeilingRegistration = {
    source,
    ceiling: { version: 1, allowedTools, denyExtensions: false, sources: [source] },
  };
  session.set(token, ceilingRecord);

  // Dispose-first: pi-subagents throws when a snapshot already exists.
  // Only clear our OWN prior snapshot; never clobber a foreign owner's entry.
  if (required.bySession.get(sessionId) === ownRequiredSnapshots.get(sessionId)) {
    required.bySession.delete(sessionId);
  } else if (required.bySession.has(sessionId)) {
    session.delete(token);
    throw new Error(
      `keystone bridge: required-child snapshot for session ${JSON.stringify(sessionId)} owned by another extension; refusing to clobber`,
    );
  }
  const snapshot = Object.freeze([{ id: guardId, path: guardPath }]);
  required.bySession.set(sessionId, snapshot);

  bridgedSessions.add(sessionId);
  let tokens = ownCeilingTokens.get(sessionId);
  if (!tokens) {
    tokens = new Set();
    ownCeilingTokens.set(sessionId, tokens);
  }
  tokens.add(token);
  ownRequiredSnapshots.set(sessionId, snapshot);
  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    disposeOwnBridges(sessionId);
  };
  return {
    ceiling: { dispose: disposeAll },
    required: { dispose: disposeAll },
    fresh: true,
  };
}

/** Remove ONLY keystone's own tokens/snapshot for a session (identity-checked). */
function disposeOwnBridges(sessionId: string): void {
  const tokens = ownCeilingTokens.get(sessionId);
  if (tokens) {
    try {
      const session = resolveCeilingRegistry().get(sessionId);
      if (session) {
        for (const token of tokens) session.delete(token);
        if (session.size === 0) resolveCeilingRegistry().delete(sessionId);
      }
    } catch {
      // Registry absent — nothing to clean.
    }
    ownCeilingTokens.delete(sessionId);
  }
  const snapshot = ownRequiredSnapshots.get(sessionId);
  if (snapshot !== undefined) {
    try {
      const bySession = resolveRequiredChildRegistry().bySession;
      if (bySession.get(sessionId) === snapshot) bySession.delete(sessionId);
    } catch {
      // Registry absent — nothing to clean.
    }
    ownRequiredSnapshots.delete(sessionId);
  }
  mutationNestingDepth.delete(sessionId);
  bridgedSessions.delete(sessionId);
}

/** Forget bridge state (session_shutdown + tests). Disposes live registrations. */
export function resetSessionBridges(sessionId?: string): void {
  if (sessionId !== undefined) {
    disposeOwnBridges(sessionId);
    return;
  }
  for (const id of [...bridgedSessions]) disposeOwnBridges(id);
}

/**
 * Switch the session ceiling BEFORE a spawn (update-before-spawn).
 *
 * Why: ensureKeystoneSessionBridges installs a session-wide reader ceiling.
 * Once session identity is fixed, mutation children from the same session
 * inherit that ceiling and cannot mutate — so the caller widens to
 * "mutation" before a mutation spawn and resets after.
 *
 * Spawn-time safety (verified in pi-subagents): the executor resolves the
 * ceiling synchronously at spawn dispatch via
 * resolveCurrentSubagentCapabilityCeiling(sessionId), reading the live
 * registry — runs/foreground/subagent-executor.ts (~5206, ~5959, ~7142),
 * runs/background/async-execution.ts (~1306, ~1671),
 * runs/foreground/execution.ts (~1702). An update() before spawn is
 * therefore observed by every spawn dispatched after it.
 *
 * Residual risks: (1) async-chain continuations intersect the SNAPSHOT
 * ceiling stored in the run descriptor with the live registry
 * (subagent-executor.ts ~1388, ~2031, ~2181) — intersection only narrows,
 * so a descriptor built before the widen keeps the old value; (2)
 * concurrent spawns racing the update window may observe either value —
 * serialize ceiling switches against spawns; (3) already-running children
 * are unaffected (ceiling captured in the run descriptor). Caller MUST
 * reset via restoreReaderCeiling (finally block) — a leaked mutation
 * ceiling widens every later spawn in the session.
 *
 * Auto-ensures the reader baseline when the session is not yet bridged.
 */
export function setSpawnCeiling(sessionId: string, mode: SpawnCeilingMode): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new SubagentsBridgeError("sessionId required.");
  }
  if (mode !== "reader" && mode !== "mutation") {
    throw new SubagentsBridgeError(`Unknown spawn ceiling mode: ${String(mode)}.`);
  }
  if (!bridgedSessions.has(sessionId)) {
    ensureKeystoneSessionBridges(sessionId);
  }
  if (mode === "mutation") {
    mutationNestingDepth.set(sessionId, (mutationNestingDepth.get(sessionId) ?? 0) + 1);
  } else {
    const depth = (mutationNestingDepth.get(sessionId) ?? 0) - 1;
    if (depth > 0) {
      mutationNestingDepth.set(sessionId, depth);
      return;
    }
    mutationNestingDepth.delete(sessionId);
  }
  const allowedTools = normalizeAllowedTools(SPAWN_CEILING_TOOLS[mode]);
  const ceilings = resolveCeilingRegistry();
  const session = ceilings.get(sessionId);
  const tokens = ownCeilingTokens.get(sessionId);
  if (!session || !tokens || tokens.size === 0) {
    throw new SubagentsBridgeError(`No keystone ceiling to update for session '${sessionId}'.`);
  }
  let updated = 0;
  for (const token of tokens) {
    const record = session.get(token);
    if (!record) continue;
    record.ceiling.allowedTools = allowedTools;
    updated++;
  }
  if (updated === 0) {
    throw new SubagentsBridgeError(`No keystone ceiling to update for session '${sessionId}'.`);
  }
}

/**
 * Reset the session ceiling to reader after a mutation spawn.
 * Same update-before-spawn semantics as setSpawnCeiling; call in a
 * finally block so the widened ceiling never leaks to later spawns.
 */
export function restoreReaderCeiling(sessionId: string): void {
  setSpawnCeiling(sessionId, "reader");
}
