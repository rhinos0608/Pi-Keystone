/**
 * AssignmentIndex — append-only log of assignment launches.
 *
 * Launcher-written only. Stores identity metadata used to verify
 * auditor identity and enforce write permissions.
 */

import { readFileSync, existsSync } from "node:fs";
import { writeAtomicJson } from "../store/atomic-json.js";
import { withLock } from "../store/directory-lock.js";

/** Index file exists but cannot be trusted: parse failure or schema mismatch. */
export class AssignmentIndexCorruptionError extends Error {
  readonly code = "ASSIGNMENT_INDEX_CORRUPTION" as const;
  readonly filePath: string;
  constructor(filePath: string, reason: string) {
    super(`Assignment index at ${filePath} is corrupt: ${reason}`);
    this.name = "AssignmentIndexCorruptionError";
    this.filePath = filePath;
  }
}

// ---------------------------------------------------------------------------
// IndexEntry
// ---------------------------------------------------------------------------

/** Single entry in the append-only assignment index. */
export type AssignmentIndexEntry = {
  readonly runId: string;
  readonly sessionId: string;
  readonly role: string;
  readonly planEpoch: number;
  readonly mutationCapable: boolean;
  readonly appendedAt: string; // ISO-8601
};

// ---------------------------------------------------------------------------
// AssignmentIndex
// ---------------------------------------------------------------------------

export type AssignmentIndex = {
  readonly version: 1;
  readonly entries: readonly AssignmentIndexEntry[];
};

/** Create an empty in-memory index. */
export function createEmptyIndex(): AssignmentIndex {
  return { version: 1, entries: [] };
}

/** Append an entry (returns new index; original is immutable). */
export function appendEntry(
  index: AssignmentIndex,
  entry: Omit<AssignmentIndexEntry, "appendedAt">,
): AssignmentIndex {
  const full: AssignmentIndexEntry = {
    ...entry,
    appendedAt: new Date().toISOString(),
  };
  return { version: 1, entries: [...index.entries, full] };
}

// ---------------------------------------------------------------------------
// Persistence (JSON file)
// ---------------------------------------------------------------------------

/** Load index from disk; returns empty index only when file is absent. */
export function loadIndex(filePath: string): AssignmentIndex {
  if (!existsSync(filePath)) {
    return createEmptyIndex();
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    throw new AssignmentIndexCorruptionError(
      filePath,
      `unreadable file: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new AssignmentIndexCorruptionError(
      filePath,
      `unparseable JSON: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as AssignmentIndex).version === 1 &&
    Array.isArray((parsed as AssignmentIndex).entries)
  ) {
    return { version: 1, entries: (parsed as AssignmentIndex).entries };
  }
  throw new AssignmentIndexCorruptionError(
    filePath,
    "schema mismatch: expected { version: 1, entries: [] }",
  );
}

/** Save index to disk atomically (tmp + rename; crash never corrupts target). */
export function saveIndex(filePath: string, index: AssignmentIndex): void {
  writeAtomicJson(filePath, { version: 1, entries: [...index.entries] });
}

/**
 * Atomic append: load → append → save. Runs inside a directory-lock
 * critical section on the index file, so concurrent processes cannot
 * interleave read-modify-write cycles and lose entries. Returns new index.
 */
export function appendAndSave(
  filePath: string,
  entry: Omit<AssignmentIndexEntry, "appendedAt">,
): AssignmentIndex {
  return withLock(filePath, () => {
    const current = loadIndex(filePath);
    const next = appendEntry(current, entry);
    saveIndex(filePath, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Identity lookup
// ---------------------------------------------------------------------------

/** Find all entries matching a sessionId. */
export function findBySession(
  index: AssignmentIndex,
  sessionId: string,
): AssignmentIndexEntry[] {
  return index.entries.filter((e) => e.sessionId === sessionId);
}

/** Find all entries matching a role. */
export function findByRole(
  index: AssignmentIndex,
  role: string,
): AssignmentIndexEntry[] {
  return index.entries.filter((e) => e.role === role);
}

/** Find a specific entry by runId. */
export function findByRunId(
  index: AssignmentIndex,
  runId: string,
): AssignmentIndexEntry | undefined {
  return index.entries.find((e) => e.runId === runId);
}

// ---------------------------------------------------------------------------
// Launcher-only write enforcement
// ---------------------------------------------------------------------------

/** The set of session IDs authorised to append to the index. */
const launcherSessions = new Set<string>();

/** Register a session as launcher-eligible. */
export function registerLauncher(sessionId: string): void {
  launcherSessions.add(sessionId);
}

/** Remove a session from the launcher set. */
export function revokeLauncher(sessionId: string): void {
  launcherSessions.delete(sessionId);
}

/** Check whether a session is a registered launcher. */
export function isLauncher(sessionId: string): boolean {
  return launcherSessions.has(sessionId);
}

/**
 * Append only if the CALLER is a registered launcher.
 * Authorizes `callerSessionId` (the parent launcher identity) — never the
 * session id claimed inside the entry, which is caller-supplied data.
 * The stored entry is stamped with the caller identity. `callerSessionId`
 * is REQUIRED: there is no self-claim fallback.
 * Throws if not authorised.
 */
export function launcherAppend(
  filePath: string,
  entry: Omit<AssignmentIndexEntry, "appendedAt">,
  callerSessionId: string,
): AssignmentIndex {
  if (!isLauncher(callerSessionId)) {
    throw new Error(`Session "${callerSessionId}" is not a registered launcher`);
  }
  return appendAndSave(filePath, { ...entry, sessionId: callerSessionId });
}
