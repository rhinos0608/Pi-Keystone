/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureSnapshot } from "../../src/baseline/snapshot.js";
import { createApproval, evaluateApproval } from "../../src/execution/approval.js";

let dir: string;

function git(cmd: string): void {
  execSync(`git ${cmd}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approval-test-"));
  git("init");
  git("config user.email 'test@test.com'");
  git("config user.name 'Test'");
  git("commit --allow-empty -m init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  goalId: "goal-001",
  planEpoch: 3,
  assignmentId: "asgn-001",
};

// ─── APPROVED ───────────────────────────────────────────────────────────────

describe("evaluateApproval APPROVED", () => {
  it("approves clean write-set against unchanged snapshot", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result).toEqual({ status: "APPROVED" });
  });

  it("unrelated dirt does not block approval", async () => {
    writeFileSync(join(dir, "unrelated.txt"), "dirt elsewhere");
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result.status).toBe("APPROVED");
  });

  it("subset of intended write-set is approved", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({
      ...BASE,
      snapshot: snap,
      intendedWriteSet: ["src/a.ts", "src/b.ts"],
    });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result.status).toBe("APPROVED");
  });
});

// ─── STALE ──────────────────────────────────────────────────────────────────

describe("evaluateApproval STALE", () => {
  it("stale on dirtySignature drift", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    writeFileSync(join(dir, "drift.txt"), "changed after approval");
    const current = await captureSnapshot(dir);
    const result = evaluateApproval(approval, current, 3, ["src/a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result.status).toBe("STALE");
    if (result.status === "STALE") expect(result.reason).toContain("dirtySignature");
  });

  it("stale on planEpoch drift", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 4, ["src/a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result.status).toBe("STALE");
    if (result.status === "STALE") expect(result.reason).toContain("planEpoch");
  });
});

// ─── CONFLICT ───────────────────────────────────────────────────────────────

describe("evaluateApproval CONFLICT", () => {
  it("conflict when actual write-set exceeds intent", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts", "src/extra.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result.status).toBe("CONFLICT");
  });

  it("approves pre-existing dirty collision when the approved snapshot is unchanged", async () => {
    writeFileSync(join(dir, "src-a.ts"), "someone else touched this");
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src-a.ts"] });
    expect(approval.conflicts).toHaveLength(1);
    const result = evaluateApproval(approval, snap, 3, ["src-a.ts"], { goalId: BASE.goalId, assignmentId: BASE.assignmentId });
    expect(result).toEqual({ status: "APPROVED" });
  });
});

// ─── binding + expiry + normalization ───────────────────────────────────────

describe("evaluateApproval binding/expiry/normalization", () => {
  it("stale on goalId mismatch (anti-replay)", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], {
      goalId: "goal-other",
      assignmentId: BASE.assignmentId,
    });
    expect(result.status).toBe("STALE");
    if (result.status === "STALE") expect(result.reason).toContain("goalId");
  });

  it("stale on assignmentId mismatch (anti-replay)", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], {
      goalId: BASE.goalId,
      assignmentId: "asgn-other",
    });
    expect(result.status).toBe("STALE");
    if (result.status === "STALE") expect(result.reason).toContain("assignmentId");
  });

  it("stale after expiry (15min default)", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: ["src/a.ts"] });
    expect(typeof approval.expiresAt).toBe("string");
    const after = Date.parse(approval.expiresAt) + 1;
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], {
      goalId: BASE.goalId,
      assignmentId: BASE.assignmentId,
      nowMs: after,
    });
    expect(result.status).toBe("STALE");
    if (result.status === "STALE") expect(result.reason).toContain("expired");
  });

  it("absolute and relative entries naming the same file compare equal", async () => {
    const snap = await captureSnapshot(dir);
    const approval = createApproval({ ...BASE, snapshot: snap, intendedWriteSet: [`${dir}/src/a.ts`] });
    const result = evaluateApproval(approval, snap, 3, ["src/a.ts"], {
      goalId: BASE.goalId,
      assignmentId: BASE.assignmentId,
      workspaceRoot: dir,
    });
    expect(result).toEqual({ status: "APPROVED" });
  });
});
