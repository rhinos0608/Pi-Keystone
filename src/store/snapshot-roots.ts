// Snapshot-root management: track which snapshot IDs are pinned by active goals.
// Roots of active goals are never GC'd.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import type { GoalId, SnapshotId, ISO8601 } from "../domain/types.js";

// ─── File format ──────────────────────────────────────────────────────────────

export type SnapshotRootsFile = {
  readonly version: 1;
  readonly roots: Record<string, SnapshotId[]>; // goalId → snapshot IDs
  readonly updatedAt: ISO8601;
};

export type SnapshotRootsResult = {
  readonly data: SnapshotRootsFile;
  readonly repaired: boolean;
  readonly repairNote?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): ISO8601 {
  return new Date().toISOString() as ISO8601;
}

function validateRootsFile(data: unknown): data is SnapshotRootsFile {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (typeof obj.roots !== "object" || obj.roots === null) return false;
  const roots = obj.roots as Record<string, unknown>;
  for (const val of Object.values(roots)) {
    if (!Array.isArray(val)) return false;
    if (!val.every((v) => typeof v === "string")) return false;
  }
  return true;
}

// ─── Empty factory ────────────────────────────────────────────────────────────

export function createEmptyRoots(): SnapshotRootsFile {
  return {
    version: 1,
    roots: {},
    updatedAt: nowISO(),
  };
}

// ─── Load with corruption repair ──────────────────────────────────────────────

/**
 * Load snapshot roots from disk. Repairs corrupt files by extracting any
 * valid goal→snapshot mappings found in the raw text.
 */
export function loadRoots(filePath: string): SnapshotRootsResult {
  if (!existsSync(filePath)) {
    return { data: createEmptyRoots(), repaired: false };
  }

  const raw = readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    return { data: createEmptyRoots(), repaired: false };
  }

  try {
    const parsed = JSON.parse(raw);
    if (validateRootsFile(parsed)) {
      return { data: parsed, repaired: false };
    }
  } catch {
    // fall through to repair
  }

  // Repair: extract any valid goal→snapshot mappings
  const repaired = repairRoots(raw);
  return {
    data: repaired,
    repaired: true,
    repairNote: `Recovered ${Object.keys(repaired.roots).length} goal root mapping(s)`,
  };
}

function repairRoots(raw: string): SnapshotRootsFile {
  const result: Record<string, SnapshotId[]> = {};

  // Strategy 1: try truncating at last } and parse
  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace >= 0) {
    const truncated = raw.substring(0, lastBrace + 1);
    if (tryParseRoots(truncated, result)) {
      return { version: 1, roots: result, updatedAt: nowISO() };
    }
  }

  // Strategy 2: try appending closing chars for common truncation points
  const closers = ["]}", "]}}", "]}]}", "]}]}}"];
  for (const closer of closers) {
    if (tryParseRoots(raw + closer, result)) {
      return { version: 1, roots: result, updatedAt: nowISO() };
    }
  }

  // Strategy 3: regex extraction as last resort
  if (Object.keys(result).length === 0) {
    const pairRe = /"([0-9a-f-]{36})":\s*\[([^\]]*)\]/gi;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(raw)) !== null) {
      const goalId = m[1];
      const snapIds =
        m[2].match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        ) ?? [];
      if (goalId && snapIds.length > 0) {
        result[goalId] = snapIds.map((s) => s as SnapshotId);
      }
    }
  }

  return { version: 1, roots: result, updatedAt: nowISO() };
}

function tryParseRoots(
  json: string,
  out: Record<string, SnapshotId[]>,
): boolean {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.roots === "object" && parsed.roots !== null) {
      let found = false;
      for (const [k, v] of Object.entries(parsed.roots)) {
        if (typeof k === "string" && Array.isArray(v)) {
          const valid = v.filter(
            (x: unknown) => typeof x === "string",
          ) as SnapshotId[];
          if (valid.length > 0) {
            out[k] = valid;
            found = true;
          }
        }
      }
      return found;
    }
  } catch {
    /* not parseable */
  }
  return false;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export function saveRoots(filePath: string, data: SnapshotRootsFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const updated: SnapshotRootsFile = { ...data, updatedAt: nowISO() };
  writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

// ─── Pin/unpin ────────────────────────────────────────────────────────────────

/**
 * Pin snapshot IDs to a goal. Merges with existing pins for the goal.
 */
export function pinSnapshots(
  filePath: string,
  goalId: GoalId,
  snapshotIds: SnapshotId[],
): SnapshotRootsFile {
  const { data } = loadRoots(filePath);
  const existing = data.roots[goalId] ?? [];
  const merged = [...new Set([...existing, ...snapshotIds])];
  const updated: SnapshotRootsFile = {
    ...data,
    roots: { ...data.roots, [goalId]: merged },
    updatedAt: nowISO(),
  };
  saveRoots(filePath, updated);
  return updated;
}

/**
 * Remove all pins for a goal.
 */
export function unpinGoal(filePath: string, goalId: GoalId): SnapshotRootsFile {
  const { data } = loadRoots(filePath);
  if (!(goalId in data.roots)) return data;
  const { [goalId]: _, ...rest } = data.roots;
  const updated: SnapshotRootsFile = {
    ...data,
    roots: rest,
    updatedAt: nowISO(),
  };
  saveRoots(filePath, updated);
  return updated;
}

/**
 * Get the union of all snapshot IDs pinned by any goal.
 * These are GC-safe (must not be garbage collected).
 */
export function getActiveRoots(filePath: string): Set<SnapshotId> {
  const { data } = loadRoots(filePath);
  const roots = new Set<SnapshotId>();
  for (const snaps of Object.values(data.roots)) {
    for (const s of snaps) roots.add(s);
  }
  return roots;
}

/**
 * Check whether a specific snapshot ID can be GC'd.
 * Returns false if it's pinned by any active goal.
 */
export function canGC(filePath: string, snapshotId: SnapshotId): boolean {
  const roots = getActiveRoots(filePath);
  return !roots.has(snapshotId);
}

/**
 * List all goals that pin a given snapshot.
 */
export function goalsPinningSnapshot(
  filePath: string,
  snapshotId: SnapshotId,
): GoalId[] {
  const { data } = loadRoots(filePath);
  const result: GoalId[] = [];
  for (const [goalId, snaps] of Object.entries(data.roots)) {
    if (snaps.includes(snapshotId)) {
      result.push(goalId as GoalId);
    }
  }
  return result;
}
