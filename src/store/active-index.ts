// Active-goal index: JSON file listing all goal IDs for a project.
// Handles CRUD, concurrent append, and corruption repair.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { GoalId, ISO8601 } from "../domain/types.js";

// ─── File format ──────────────────────────────────────────────────────────────

export type ActiveIndexFile = {
  readonly version: 1;
  readonly projectKey: string;
  readonly goalIds: GoalId[];
  readonly updatedAt: ISO8601;
};

export type ActiveIndexResult = {
  readonly index: ActiveIndexFile;
  readonly repaired: boolean;
  readonly repairNote?: string;
};

// ─── Validation ───────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidGoalId(raw: string): boolean {
  return UUID_RE.test(raw);
}

function validateIndexFile(data: unknown): data is ActiveIndexFile {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (typeof obj.projectKey !== "string" || !obj.projectKey) return false;
  if (!Array.isArray(obj.goalIds)) return false;
  if (!obj.goalIds.every((id) => typeof id === "string")) return false;
  return true;
}

function nowISO(): ISO8601 {
  return new Date().toISOString() as ISO8601;
}

// ─── Empty index factory ──────────────────────────────────────────────────────

export function createEmptyIndex(projectKey: string): ActiveIndexFile {
  return {
    version: 1,
    projectKey,
    goalIds: [],
    updatedAt: nowISO(),
  };
}

// ─── Load with corruption repair ──────────────────────────────────────────────

/**
 * Load the active index from disk. If the file is missing, returns an empty
 * index. If the JSON is corrupt, attempts repair by extracting valid goal IDs
 * from the raw text. Returns `repaired: true` when repair was needed.
 */
export function loadIndex(filePath: string, projectKey: string): ActiveIndexResult {
  if (!existsSync(filePath)) {
    return { index: createEmptyIndex(projectKey), repaired: false };
  }

  const raw = readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    return { index: createEmptyIndex(projectKey), repaired: false };
  }

  try {
    const parsed = JSON.parse(raw);
    if (validateIndexFile(parsed)) {
      return { index: parsed, repaired: false };
    }
    // JSON parsed but structure is wrong — fall through to repair
  } catch {
    // JSON parse failed — fall through to repair
  }

  // Repair: extract any valid UUID-like strings from the raw text
  const uuids = raw.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  );
  const goalIds = (uuids ?? []).filter(isValidGoalId) as GoalId[];
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const deduped = goalIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const repaired: ActiveIndexFile = {
    version: 1,
    projectKey,
    goalIds: deduped,
    updatedAt: nowISO(),
  };

  return {
    index: repaired,
    repaired: true,
    repairNote: `Recovered ${deduped.length} goal ID(s) from corrupt file`,
  };
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export function saveIndex(filePath: string, index: ActiveIndexFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const updated: ActiveIndexFile = { ...index, updatedAt: nowISO() };
  writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

/**
 * Add a goal to the index. Creates the file if absent.
 * Deduplicates: adding an existing goal is a no-op.
 */
export function addGoal(
  filePath: string,
  projectKey: string,
  goalId: GoalId,
): ActiveIndexFile {
  const { index } = loadIndex(filePath, projectKey);
  if (index.goalIds.includes(goalId)) return index;
  const updated: ActiveIndexFile = {
    ...index,
    goalIds: [...index.goalIds, goalId],
    updatedAt: nowISO(),
  };
  saveIndex(filePath, updated);
  return updated;
}

/**
 * Remove a goal from the index.
 */
export function removeGoal(
  filePath: string,
  projectKey: string,
  goalId: GoalId,
): ActiveIndexFile {
  const { index } = loadIndex(filePath, projectKey);
  const filtered = index.goalIds.filter((id) => id !== goalId);
  if (filtered.length === index.goalIds.length) return index;
  const updated: ActiveIndexFile = {
    ...index,
    goalIds: filtered,
    updatedAt: nowISO(),
  };
  saveIndex(filePath, updated);
  return updated;
}

/**
 * List all goal IDs in the index. Creates the file if absent.
 */
export function listGoals(
  filePath: string,
  projectKey: string,
): GoalId[] {
  const { index } = loadIndex(filePath, projectKey);
  return [...index.goalIds];
}

/**
 * Append a goal directly (for concurrent-append scenarios).
 * Reads current state, appends, writes back. Caller should retry on conflict.
 */
export function appendGoal(
  filePath: string,
  projectKey: string,
  goalId: GoalId,
): ActiveIndexFile {
  const { index } = loadIndex(filePath, projectKey);
  if (index.goalIds.includes(goalId)) return index;
  const updated: ActiveIndexFile = {
    ...index,
    goalIds: [...index.goalIds, goalId],
    updatedAt: nowISO(),
  };
  saveIndex(filePath, updated);
  return updated;
}
