import { describe, it, expect, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GoalId } from "../../src/domain/types.js";
import {
  createEmptyIndex,
  loadIndex,
  saveIndex,
  addGoal,
  removeGoal,
  listGoals,
  appendGoal,
} from "../../src/store/active-index.js";

function fakeId(suffix: string): GoalId {
  return `00000000-0000-0000-0000-${suffix.padStart(12, "0")}` as GoalId;
}

describe("ActiveIndex", () => {
  let dir: string;
  let fpath: string;
  const PK = "test-project";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ki-idx-"));
    fpath = join(dir, "active-index.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createEmptyIndex returns valid empty index", () => {
    const idx = createEmptyIndex(PK);
    expect(idx.version).toBe(1);
    expect(idx.projectKey).toBe(PK);
    expect(idx.goalIds).toEqual([]);
  });

  it("loadIndex returns empty when file absent", () => {
    const { index, repaired } = loadIndex(fpath, PK);
    expect(index.goalIds).toHaveLength(0);
    expect(repaired).toBe(false);
  });

  it("saveIndex + loadIndex round-trips", () => {
    const idx = createEmptyIndex(PK);
    saveIndex(fpath, idx);
    const { index, repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(false);
    expect(index.projectKey).toBe(PK);
    expect(index.version).toBe(1);
  });

  it("addGoal creates file and adds ID", () => {
    const id = fakeId("000000000001");
    addGoal(fpath, PK, id);
    const goals = listGoals(fpath, PK);
    expect(goals).toEqual([id]);
  });

  it("addGoal deduplicates", () => {
    const id = fakeId("000000000001");
    addGoal(fpath, PK, id);
    addGoal(fpath, PK, id);
    const goals = listGoals(fpath, PK);
    expect(goals).toHaveLength(1);
  });

  it("removeGoal removes the ID", () => {
    const a = fakeId("000000000001");
    const b = fakeId("000000000002");
    addGoal(fpath, PK, a);
    addGoal(fpath, PK, b);
    removeGoal(fpath, PK, a);
    const goals = listGoals(fpath, PK);
    expect(goals).toEqual([b]);
  });

  it("removeGoal is no-op for missing ID", () => {
    const a = fakeId("000000000001");
    const b = fakeId("000000000002");
    addGoal(fpath, PK, a);
    removeGoal(fpath, PK, b);
    const goals = listGoals(fpath, PK);
    expect(goals).toEqual([a]);
  });

  it("concurrent append handles multiple sequential appends", () => {
    const ids = Array.from({ length: 20 }, (_, i) =>
      fakeId(String(i + 1).padStart(12, "0")),
    );
    for (const id of ids) {
      appendGoal(fpath, PK, id);
    }
    const goals = listGoals(fpath, PK);
    expect(goals).toHaveLength(20);
    for (const id of ids) {
      expect(goals).toContain(id);
    }
  });

  it("concurrent append deduplicates under rapid write", () => {
    const id = fakeId("000000000001");
    for (let i = 0; i < 50; i++) {
      appendGoal(fpath, PK, id);
    }
    const goals = listGoals(fpath, PK);
    expect(goals).toHaveLength(1);
  });

  // ─── Corruption repair ──────────────────────────────────────────────────────

  it("repair: truncated JSON recovers valid goal IDs", () => {
    const g1 = fakeId("000000000001");
    const g2 = fakeId("000000000002");
    const corrupt = `{"version":1,"projectKey":"${PK}","goalIds":["${g1}","${g2}`;
    writeFileSync(fpath, corrupt, "utf-8");
    const { index, repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(true);
    expect(index.goalIds.length).toBeGreaterThanOrEqual(1);
  });

  it("repair: completely invalid JSON recovers via regex", () => {
    const g1 = fakeId("000000000001");
    const g2 = fakeId("000000000099");
    const corrupt = `NOT JSON AT ALL ${g1} and also ${g2} are goal IDs`;
    writeFileSync(fpath, corrupt, "utf-8");
    const { index, repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(true);
    expect(index.goalIds).toContain(g1);
    expect(index.goalIds).toContain(g2);
    expect(index.projectKey).toBe(PK);
    expect(index.version).toBe(1);
  });

  it("repair: empty file returns empty index, not repaired", () => {
    writeFileSync(fpath, "", "utf-8");
    const { index, repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(false);
    expect(index.goalIds).toHaveLength(0);
  });

  it("repair: wrong structure (missing fields) triggers repair", () => {
    const g1 = fakeId("000000000001");
    writeFileSync(fpath, JSON.stringify({ version: 1, goalIds: [g1] }), "utf-8");
    const { repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(true);
  });

  it("repair deduplicates recovered IDs", () => {
    const g1 = fakeId("000000000001");
    writeFileSync(fpath, `${g1} ${g1} ${g1}`, "utf-8");
    const { index, repaired } = loadIndex(fpath, PK);
    expect(repaired).toBe(true);
    expect(index.goalIds).toHaveLength(1);
  });
});
