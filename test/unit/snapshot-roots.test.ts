import { describe, it, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalId, SnapshotId } from "../../src/domain/types.js";
import {
  createEmptyRoots,
  loadRoots,
  saveRoots,
  pinSnapshots,
  unpinGoal,
  getActiveRoots,
  canGC,
  goalsPinningSnapshot,
} from "../../src/store/snapshot-roots.js";

function fakeGoalId(suffix: string): GoalId {
  return `00000000-0000-0000-0000-${suffix.padStart(12, "0")}` as GoalId;
}

function fakeSnapId(suffix: string): SnapshotId {
  return `aaaaaaaa-bbbb-cccc-dddd-${suffix.padStart(12, "0")}` as SnapshotId;
}

describe("SnapshotRoots", () => {
  let dir: string;
  let fpath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ki-snap-"));
    fpath = join(dir, "snapshot-roots.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createEmptyRoots returns valid empty data", () => {
    const data = createEmptyRoots();
    expect(data.version).toBe(1);
    expect(data.roots).toEqual({});
  });

  it("loadRoots returns empty when file absent", () => {
    const { data, repaired } = loadRoots(fpath);
    expect(Object.keys(data.roots)).toHaveLength(0);
    expect(repaired).toBe(false);
  });

  // ─── Pin/unpin ──────────────────────────────────────────────────────────────

  it("pinSnapshots adds snapshots for a goal", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const s2 = fakeSnapId("000000000002");
    pinSnapshots(fpath, g, [s1, s2]);
    const roots = getActiveRoots(fpath);
    expect(roots.has(s1)).toBe(true);
    expect(roots.has(s2)).toBe(true);
  });

  it("pinSnapshots merges with existing pins", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const s2 = fakeSnapId("000000000002");
    pinSnapshots(fpath, g, [s1]);
    pinSnapshots(fpath, g, [s2]);
    const roots = getActiveRoots(fpath);
    expect(roots.has(s1)).toBe(true);
    expect(roots.has(s2)).toBe(true);
    const { data } = loadRoots(fpath);
    expect(data.roots[g]).toHaveLength(2);
  });

  it("pinSnapshots deduplicates", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g, [s1, s1, s1]);
    const { data } = loadRoots(fpath);
    expect(data.roots[g]).toHaveLength(1);
  });

  it("unpinGoal removes all pins for a goal", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g, [s1]);
    unpinGoal(fpath, g);
    const roots = getActiveRoots(fpath);
    expect(roots.has(s1)).toBe(false);
  });

  it("unpinGoal is no-op for missing goal", () => {
    const g1 = fakeGoalId("000000000001");
    const g2 = fakeGoalId("000000000002");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g1, [s1]);
    unpinGoal(fpath, g2);
    const roots = getActiveRoots(fpath);
    expect(roots.has(s1)).toBe(true);
  });

  it("multiple goals pin same snapshot", () => {
    const g1 = fakeGoalId("000000000001");
    const g2 = fakeGoalId("000000000002");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g1, [s1]);
    pinSnapshots(fpath, g2, [s1]);
    const pinners = goalsPinningSnapshot(fpath, s1);
    expect(pinners).toHaveLength(2);
    expect(pinners).toContain(g1);
    expect(pinners).toContain(g2);
  });

  // ─── GC-safe behavior ───────────────────────────────────────────────────────

  it("canGC returns false for pinned snapshot", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g, [s1]);
    expect(canGC(fpath, s1)).toBe(false);
  });

  it("canGC returns true for unpinned snapshot", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const s2 = fakeSnapId("000000000002");
    pinSnapshots(fpath, g, [s1]);
    expect(canGC(fpath, s2)).toBe(true);
  });

  it("canGC returns true after goal unpinned", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g, [s1]);
    expect(canGC(fpath, s1)).toBe(false);
    unpinGoal(fpath, g);
    expect(canGC(fpath, s1)).toBe(true);
  });

  it("snapshot only GC-safe after ALL pinners removed", () => {
    const g1 = fakeGoalId("000000000001");
    const g2 = fakeGoalId("000000000002");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g1, [s1]);
    pinSnapshots(fpath, g2, [s1]);
    expect(canGC(fpath, s1)).toBe(false);
    unpinGoal(fpath, g1);
    expect(canGC(fpath, s1)).toBe(false);
    unpinGoal(fpath, g2);
    expect(canGC(fpath, s1)).toBe(true);
  });

  it("getActiveRoots returns empty set when all goals unpinned", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    pinSnapshots(fpath, g, [s1]);
    unpinGoal(fpath, g);
    const roots = getActiveRoots(fpath);
    expect(roots.size).toBe(0);
  });

  // ─── Corruption repair ──────────────────────────────────────────────────────

  it("repair: truncated JSON recovers root mappings", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const s2 = fakeSnapId("000000000002");
    const corrupt = `{"version":1,"roots":{"${g}":["${s1}","${s2}"`;
    writeFileSync(fpath, corrupt, "utf-8");
    const { data, repaired } = loadRoots(fpath);
    expect(repaired).toBe(true);
    expect(data.roots[g]).toBeDefined();
  });

  it("repair: invalid JSON extracts goal-snapshot pairs via regex", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const corrupt = `GARBAGE "${g}": ["${s1}"] MORE GARBAGE`;
    writeFileSync(fpath, corrupt, "utf-8");
    const { data, repaired } = loadRoots(fpath);
    expect(repaired).toBe(true);
    expect(data.roots[g]).toBeDefined();
    expect(data.roots[g]).toContain(s1);
  });

  it("repair: empty file returns empty data", () => {
    writeFileSync(fpath, "", "utf-8");
    const { data, repaired } = loadRoots(fpath);
    expect(repaired).toBe(false);
    expect(data.roots).toEqual({});
  });

  it("round-trip: pin → save → load → same roots", () => {
    const g = fakeGoalId("000000000001");
    const s1 = fakeSnapId("000000000001");
    const s2 = fakeSnapId("000000000002");
    pinSnapshots(fpath, g, [s1, s2]);
    const { data } = loadRoots(fpath);
    expect(data.roots[g]).toEqual([s1, s2]);
  });
});
