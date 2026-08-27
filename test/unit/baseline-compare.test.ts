import { describe, it, expect } from "vitest";
import { compareBaseline, type BaselineDelta } from "../../src/baseline/compare.js";
import {
  CheckOutcome,
  type BaselineRecord,
  type CheckRecord,
} from "../../src/baseline/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeCheck(overrides: Partial<CheckRecord>): CheckRecord {
  return {
    command: "test-command",
    cwd: "/workspace",
    outcome: CheckOutcome.PASS,
    exitCode: 0,
    stdout: "",
    stderr: "",
    duration: 100,
    retried: false,
    fingerprint: null,
    ...overrides,
  };
}

function makeBaseline(checks: CheckRecord[]): BaselineRecord {
  return {
    goalId: "goal-1",
    workspace: "/workspace",
    worktree: {
      gitRoot: "/workspace",
      headCommit: "abc123",
      dirtyPaths: [],
      contentHashBudget: 1024,
    },
    checks,
    environment: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("compareBaseline", () => {
  // ─── Clean disposition ─────────────────────────────────────────────

  it("returns clean when all checks match", () => {
    const checks = [
      makeCheck({ command: "lint" }),
      makeCheck({ command: "typecheck" }),
    ];
    const delta = compareBaseline(makeBaseline(checks), makeBaseline(checks));
    expect(delta.disposition).toBe("clean");
    expect(delta.regressions).toHaveLength(0);
    expect(delta.improvements).toHaveLength(0);
    expect(delta.unchanged).toHaveLength(2);
  });

  it("returns clean when both baselines are empty", () => {
    const delta = compareBaseline(makeBaseline([]), makeBaseline([]));
    expect(delta.disposition).toBe("clean");
    expect(delta.regressions).toHaveLength(0);
    expect(delta.improvements).toHaveLength(0);
    expect(delta.unchanged).toHaveLength(0);
  });

  // ─── Regression detection ─────────────────────────────────────────

  it("detects PASS→FAIL as regression", () => {
    const before = [makeCheck({ command: "test", outcome: CheckOutcome.PASS })];
    const after = [makeCheck({ command: "test", outcome: CheckOutcome.FAIL, exitCode: 1 })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("regression");
    expect(delta.regressions).toHaveLength(1);
    expect(delta.regressions[0].command).toBe("test");
    expect(delta.regressions[0].beforeOutcome).toBe(CheckOutcome.PASS);
    expect(delta.regressions[0].afterOutcome).toBe(CheckOutcome.FAIL);
  });

  it("detects PASS→TIMEOUT as regression", () => {
    const before = [makeCheck({ command: "slow-test" })];
    const after = [makeCheck({ command: "slow-test", outcome: CheckOutcome.TIMEOUT })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("regression");
    expect(delta.regressions).toHaveLength(1);
  });

  it("detects missing check as regression when it was passing", () => {
    const before = [makeCheck({ command: "unit-test" }), makeCheck({ command: "lint" })];
    const after = [makeCheck({ command: "lint" })]; // unit-test gone
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("regression");
    expect(delta.regressions).toHaveLength(1);
    expect(delta.regressions[0].command).toBe("unit-test");
    expect(delta.regressions[0].afterOutcome).toBe(CheckOutcome.SKIPPED);
  });

  // ─── Improvement detection ────────────────────────────────────────

  it("detects FAIL→PASS as improvement", () => {
    const before = [makeCheck({ command: "test", outcome: CheckOutcome.FAIL, exitCode: 1 })];
    const after = [makeCheck({ command: "test", outcome: CheckOutcome.PASS })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("clean");
    expect(delta.improvements).toHaveLength(1);
    expect(delta.improvements[0].command).toBe("test");
  });

  // ─── Fingerprint matching ─────────────────────────────────────────

  it("matches failures by fingerprint across different commands", () => {
    const fp = "abc123def456";
    const before = [makeCheck({
      command: "old-command",
      outcome: CheckOutcome.FAIL,
      exitCode: 1,
      fingerprint: fp,
    })];
    const after = [makeCheck({
      command: "renamed-command",
      outcome: CheckOutcome.FAIL,
      exitCode: 1,
      fingerprint: fp,
    })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("clean");
    expect(delta.unchanged).toHaveLength(1);
    expect(delta.unchanged[0].command).toBe("renamed-command");
    expect(delta.unchanged[0].fingerprint).toBe(fp);
  });

  it("does not match failures without shared fingerprint", () => {
    const before = [makeCheck({
      command: "test",
      outcome: CheckOutcome.FAIL,
      fingerprint: "aaa",
    })];
    const after = [makeCheck({
      command: "test",
      outcome: CheckOutcome.FAIL,
      fingerprint: "bbb",
    })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    // Same command, different fingerprint → matched by command, not fingerprint
    // FAIL→FAIL = unchanged
    expect(delta.unchanged).toHaveLength(1);
  });

  // ─── Mixed disposition ────────────────────────────────────────────

  it("returns mixed when both regressions and improvements exist", () => {
    const before = [
      makeCheck({ command: "test-a", outcome: CheckOutcome.PASS }),
      makeCheck({ command: "test-b", outcome: CheckOutcome.FAIL, exitCode: 1 }),
    ];
    const after = [
      makeCheck({ command: "test-a", outcome: CheckOutcome.FAIL, exitCode: 1 }),
      makeCheck({ command: "test-b", outcome: CheckOutcome.PASS }),
    ];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("mixed");
    expect(delta.regressions).toHaveLength(1);
    expect(delta.improvements).toHaveLength(1);
  });

  // ─── New checks in after ──────────────────────────────────────────

  it("treats new failing checks as regressions", () => {
    const before: CheckRecord[] = [];
    const after = [makeCheck({ command: "new-check", outcome: CheckOutcome.FAIL, exitCode: 1 })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("regression");
    expect(delta.regressions).toHaveLength(1);
    expect(delta.regressions[0].beforeOutcome).toBe(CheckOutcome.SKIPPED);
  });

  it("treats new passing checks as unchanged", () => {
    const before: CheckRecord[] = [];
    const after = [makeCheck({ command: "new-check" })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.disposition).toBe("clean");
    expect(delta.unchanged).toHaveLength(1);
  });

  // ─── Fingerprint on regressions ───────────────────────────────────

  it("carries fingerprint in regression deltas", () => {
    const fp = "deadbeef123";
    const before = [makeCheck({ command: "test", outcome: CheckOutcome.PASS })];
    const after = [makeCheck({
      command: "test",
      outcome: CheckOutcome.FAIL,
      fingerprint: fp,
    })];
    const delta = compareBaseline(makeBaseline(before), makeBaseline(after));
    expect(delta.regressions[0].fingerprint).toBe(fp);
  });
});
