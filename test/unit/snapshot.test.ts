/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureSnapshot,
  conflictMatrix,
  diffSnapshots,
} from "../../src/baseline/snapshot.js";

let dir: string;

function git(cmd: string): void {
  execSync(`git ${cmd}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  git("init");
  git("config user.email 'test@test.com'");
  git("config user.name 'Test'");
  git("commit --allow-empty -m init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── capture ────────────────────────────────────────────────────────────────

describe("captureSnapshot", () => {
  it("captures clean repo with HEAD revision", async () => {
    const snap = await captureSnapshot(dir);
    expect(snap.revision).toMatch(/^[0-9a-f]{4,40}$/i);
    expect(snap.staged).toEqual([]);
    expect(snap.modified).toEqual([]);
    expect(snap.untracked).toEqual([]);
    expect(typeof snap.dirtySignature).toBe("string");
  });

  it("signature stable across captures with no changes", async () => {
    const a = await captureSnapshot(dir);
    const b = await captureSnapshot(dir);
    expect(a.dirtySignature).toBe(b.dirtySignature);
  });

  it("lists untracked files", async () => {
    writeFileSync(join(dir, "new.txt"), "hello");
    const snap = await captureSnapshot(dir);
    expect(snap.untracked).toContain("new.txt");
  });

  it("lists modified files after commit", async () => {
    writeFileSync(join(dir, "tracked.txt"), "v1");
    git("add tracked.txt");
    git("commit -m add");
    writeFileSync(join(dir, "tracked.txt"), "v2");
    const snap = await captureSnapshot(dir);
    expect(snap.modified).toContain("tracked.txt");
  });

  it("lists staged files distinctly", async () => {
    writeFileSync(join(dir, "staged.txt"), "staged content");
    git("add staged.txt");
    const snap = await captureSnapshot(dir);
    expect(snap.staged).toContain("staged.txt");
  });

  it("parses staged renames without leaking the porcelain score into the path", async () => {
    writeFileSync(join(dir, "before.txt"), "v1");
    git("add before.txt");
    git("commit -m before");
    git("mv before.txt after.txt");
    const snap = await captureSnapshot(dir);
    expect(snap.staged).toContain("before.txt");
    expect(snap.staged).toContain("after.txt");
    expect(snap.staged.some((p) => /^R\d+ /.test(p))).toBe(false);
  });

  it("signature changes on content edit", async () => {
    writeFileSync(join(dir, "f.txt"), "v1");
    const before = await captureSnapshot(dir);
    writeFileSync(join(dir, "f.txt"), "v2");
    const after = await captureSnapshot(dir);
    expect(after.dirtySignature).not.toBe(before.dirtySignature);
  });

  it("excludes Keystone control-plane files from workspace identity", async () => {
    const before = await captureSnapshot(dir);
    mkdirSync(join(dir, ".keystone", "goals"), { recursive: true });
    writeFileSync(join(dir, ".keystone", "goals", "goal.json"), "{\"state\":\"PREPARING\"}");
    writeFileSync(join(dir, ".keystone-lease.json"), "{\"leaseId\":\"x\"}");
    writeFileSync(join(dir, ".keystone-fence-counter.json"), "{\"value\":4}");
    mkdirSync(join(dir, ".keystone-lease.json.lock"), { recursive: true });
    writeFileSync(join(dir, ".keystone-lease.json.lock", "owner.json"), "{}");

    const after = await captureSnapshot(dir);
    expect(after.staged).toEqual([]);
    expect(after.modified).toEqual([]);
    expect(after.untracked).toEqual([]);
    expect(after.dirtySignature).toBe(before.dirtySignature);
  });

  it("does not exclude nested user files merely containing the Keystone name", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", ".keystone-helper.ts"), "export const userCode = true;\n");
    const snap = await captureSnapshot(dir);
    expect(snap.untracked).toContain("src/.keystone-helper.ts");
  });

  it("revision null outside a git repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "snapshot-plain-"));
    try {
      const snap = await captureSnapshot(plain).catch(() => null);
      // Non-git root: gitHead returns null but status throws; accept either
      // null result or an exception — revision must never be fabricated.
      if (snap) expect(snap.revision).toBeNull();
      else expect(snap).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ─── conflict matrix ────────────────────────────────────────────────────────

describe("conflictMatrix", () => {
  it("no-overlap dirt proceeds without approval", async () => {
    writeFileSync(join(dir, "other.txt"), "unrelated dirt");
    const snap = await captureSnapshot(dir);
    const { conflicts, proceeds } = conflictMatrix(snap, ["src/target.ts"]);
    expect(conflicts).toEqual([]);
    expect(proceeds).toBe(true);
  });

  it("untracked collision reported", async () => {
    writeFileSync(join(dir, "target.txt"), "dirt");
    const snap = await captureSnapshot(dir);
    const { conflicts, proceeds } = conflictMatrix(snap, ["target.txt"]);
    expect(proceeds).toBe(false);
    expect(conflicts).toEqual([{ path: "target.txt", kind: "untracked" }]);
  });

  it("staged collision flagged distinctly", async () => {
    writeFileSync(join(dir, "target.txt"), "dirt");
    git("add target.txt");
    const snap = await captureSnapshot(dir);
    const { conflicts, proceeds } = conflictMatrix(snap, ["target.txt"]);
    expect(proceeds).toBe(false);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("staged");
  });

  it("modified collision flagged as modified", async () => {
    writeFileSync(join(dir, "target.txt"), "v1");
    git("add target.txt");
    git("commit -m add");
    writeFileSync(join(dir, "target.txt"), "v2");
    const snap = await captureSnapshot(dir);
    const { conflicts } = conflictMatrix(snap, ["target.txt"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("modified");
  });
});

// ─── diff ───────────────────────────────────────────────────────────────────

describe("diffSnapshots", () => {
  it("detects changed paths between snapshots", async () => {
    const before = await captureSnapshot(dir);
    writeFileSync(join(dir, "changed.txt"), "new");
    const after = await captureSnapshot(dir);
    const diff = diffSnapshots(before, after);
    expect(diff.changedPaths).toContain("changed.txt");
    expect(diff.dirtyConflicts).toEqual([{ path: "changed.txt", kind: "untracked" }]);
  });

  it("empty diff on identical snapshots", async () => {
    const a = await captureSnapshot(dir);
    const b = await captureSnapshot(dir);
    const diff = diffSnapshots(a, b);
    expect(diff.changedPaths).toEqual([]);
    expect(diff.dirtyConflicts).toEqual([]);
  });
});
