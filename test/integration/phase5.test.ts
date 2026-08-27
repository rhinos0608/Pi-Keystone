// Integration test: Phase 5 orchestrators
// Tests worktree capture, baseline, planning, and contract draft pipelines.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorktreeState } from "../../src/baseline/worktree.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "keystone-phase5-"));
  execSync("git init", { cwd: testDir });
  execSync("git config user.email 'test@test.com'", { cwd: testDir });
  execSync("git config user.name 'Test'", { cwd: testDir });
  execSync("git commit --allow-empty -m 'init'", { cwd: testDir });
});

describe("Phase 5 orchestrator integration", () => {
  it("getWorktreeState captures git metadata", () => {
    const state = getWorktreeState(testDir);
    expect(state.gitRoot).toBeTruthy();
    expect(typeof state.branch).toBe("string");
    expect(state.headCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Array.isArray(state.dirtyPaths)).toBe(true);
  });

  it("contentHashBudget is a number", () => {
    const state = getWorktreeState(testDir);
    expect(typeof state.contentHashBudget).toBe("number");
  });

  it("dirty paths populated after touching a file", () => {
    writeFileSync(join(testDir, "dirty.txt"), "hello");
    const state = getWorktreeState(testDir);
    expect(state.dirtyPaths.some((d: any) => d.path === "dirty.txt")).toBe(true);
  });
});
