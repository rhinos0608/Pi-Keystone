/**
 * AssignmentIndex — append-only log of assignment launches.
 *
 * Launcher-written only. Stores identity metadata used to verify
 * auditor identity and enforce write permissions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

/** Load index from disk; returns empty index when file is absent. */
export function loadIndex(filePath: string): AssignmentIndex {
  if (!existsSync(filePath)) {
    return createEmptyIndex();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      Array.isArray(parsed.entries)
    ) {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // corrupt file → return empty, caller can decide policy
  }
  return createEmptyIndex();
}

/** Save index to disk. Creates parent dirs. */
export function saveIndex(filePath: string, index: AssignmentIndex): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

/** Atomic append: load → append → save. Returns new index. */
export function appendAndSave(
  filePath: string,
  entry: Omit<AssignmentIndexEntry, "appendedAt">,
): AssignmentIndex {
  const current = loadIndex(filePath);
  const next = appendEntry(current, entry);
  saveIndex(filePath, next);
  return next;
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
 * Append only if sessionId is a registered launcher.
 * Throws if not authorised.
 */
export function launcherAppend(
  filePath: string,
  entry: Omit<AssignmentIndexEntry, "appendedAt">,
): AssignmentIndex {
  if (!isLauncher(entry.sessionId)) {
    throw new Error(`Session "${entry.sessionId}" is not a registered launcher`);
  }
  return appendAndSave(filePath, entry);
}
