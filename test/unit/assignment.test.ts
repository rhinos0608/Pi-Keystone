import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssignmentId, ArtifactRef } from "../../src/domain/types.js";
import {
  createAssignment,
  validateAssignment,
  type AssignmentRole,
} from "../../src/execution/assignment.js";
import {
  createEmptyIndex,
  appendEntry,
  appendAndSave,
  loadIndex,
  saveIndex,
  findBySession,
  findByRole,
  findByRunId,
  registerLauncher,
  revokeLauncher,
  isLauncher,
  launcherAppend,
} from "../../src/execution/assignment-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aid(suffix: string): AssignmentId {
  return `asgn-${suffix}` as AssignmentId;
}

function aref(suffix: string): ArtifactRef {
  return `ref-${suffix}` as ArtifactRef;
}

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "ki-test-"));
}

// ---------------------------------------------------------------------------
// Tests: assignment.ts
// ---------------------------------------------------------------------------

describe("Assignment — createAssignment", () => {
  const base = {
    role: "implementer" as AssignmentRole,
    targetFiles: ["src/foo.ts"],
    acceptanceCriteria: ["compiles"],
    contractRef: aref("c1"),
  };

  it("creates assignment with auto-generated id", () => {
    const result = createAssignment(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.id).toBeTruthy();
      expect(result.assignment.role).toBe("implementer");
      expect(result.assignment.targetFiles).toEqual(["src/foo.ts"]);
      expect(result.assignment.acceptanceCriteria).toEqual(["compiles"]);
      expect(result.assignment.contractRef).toBe(aref("c1"));
    }
  });

  it("creates assignment with explicit id", () => {
    const id = aid("explicit-01");
    const result = createAssignment({ ...base, id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assignment.id).toBe(id);
    }
  });

  it("freezes arrays (immutable)", () => {
    const result = createAssignment(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.assignment.targetFiles)).toBe(true);
      expect(Object.isFrozen(result.assignment.acceptanceCriteria)).toBe(true);
    }
  });
});

describe("Assignment — validateAssignment", () => {
  const valid = {
    id: aid("v1"),
    role: "auditor" as AssignmentRole,
    targetFiles: ["src/bar.ts"],
    acceptanceCriteria: ["passes tests"],
    contractRef: aref("c2"),
  };

  it("returns empty for valid input", () => {
    expect(validateAssignment(valid)).toEqual([]);
  });

  it("errors on empty targetFiles", () => {
    const errors = validateAssignment({ ...valid, targetFiles: [] });
    expect(errors).toEqual([{ kind: "EMPTY_TARGET_FILES" }]);
  });

  it("errors on empty acceptanceCriteria", () => {
    const errors = validateAssignment({ ...valid, acceptanceCriteria: [] });
    expect(errors).toEqual([{ kind: "EMPTY_ACCEPTANCE_CRITERIA" }]);
  });

  it("errors on empty contractRef", () => {
    const errors = validateAssignment({ ...valid, contractRef: "" as ArtifactRef });
    expect(errors).toEqual([{ kind: "EMPTY_CONTRACT_REF" }]);
  });

  it("errors on missing fields", () => {
    const errors = validateAssignment({});
    expect(errors).toHaveLength(3);
  });

  it("errors on empty id when id is provided", () => {
    const errors = validateAssignment({ ...valid, id: "" as AssignmentId });
    expect(errors).toContainEqual({ kind: "EMPTY_ID" });
  });
});

// ---------------------------------------------------------------------------
// Tests: assignment-index.ts
// ---------------------------------------------------------------------------

describe("AssignmentIndex — core (in-memory)", () => {
  it("createEmptyIndex returns valid empty index", () => {
    const idx = createEmptyIndex();
    expect(idx.version).toBe(1);
    expect(idx.entries).toEqual([]);
  });

  it("appendEntry returns new index with entry", () => {
    const idx = createEmptyIndex();
    const next = appendEntry(idx, {
      runId: "run-1",
      sessionId: "sess-1",
      role: "implementer",
      planEpoch: 0,
      mutationCapable: true,
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].runId).toBe("run-1");
    expect(next.entries[0].appendedAt).toBeTruthy();
    expect(idx.entries).toHaveLength(0);
  });

  it("multiple appends accumulate", () => {
    let idx = createEmptyIndex();
    for (let i = 0; i < 5; i++) {
      idx = appendEntry(idx, {
        runId: `run-${i}`,
        sessionId: "sess-1",
        role: "verifier",
        planEpoch: i,
        mutationCapable: false,
      });
    }
    expect(idx.entries).toHaveLength(5);
  });
});

describe("AssignmentIndex — persistence (file)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtemp();
  });

  it("saveIndex + loadIndex round-trips", () => {
    const fpath = join(dir, "index.json");
    let idx = createEmptyIndex();
    idx = appendEntry(idx, {
      runId: "run-1",
      sessionId: "s1",
      role: "auditor",
      planEpoch: 2,
      mutationCapable: false,
    });
    saveIndex(fpath, idx);
    const loaded = loadIndex(fpath);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].runId).toBe("run-1");
  });

  it("loadIndex returns empty when file absent", () => {
    const loaded = loadIndex(join(dir, "nonexistent.json"));
    expect(loaded.entries).toHaveLength(0);
  });

  it("appendAndSave accumulates across calls", () => {
    const fpath = join(dir, "atomic.json");
    const idx1 = appendAndSave(fpath, {
      runId: "r1",
      sessionId: "s1",
      role: "implementer",
      planEpoch: 0,
      mutationCapable: true,
    });
    expect(idx1.entries).toHaveLength(1);

    const idx2 = appendAndSave(fpath, {
      runId: "r2",
      sessionId: "s2",
      role: "verifier",
      planEpoch: 1,
      mutationCapable: false,
    });
    expect(idx2.entries).toHaveLength(2);

    const reloaded = loadIndex(fpath);
    expect(reloaded.entries).toHaveLength(2);
  });
});

describe("AssignmentIndex — identity lookup", () => {
  it("findBySession filters correctly", () => {
    let idx = createEmptyIndex();
    idx = appendEntry(idx, { runId: "r1", sessionId: "s1", role: "a", planEpoch: 0, mutationCapable: false });
    idx = appendEntry(idx, { runId: "r2", sessionId: "s2", role: "b", planEpoch: 0, mutationCapable: false });
    idx = appendEntry(idx, { runId: "r3", sessionId: "s1", role: "c", planEpoch: 0, mutationCapable: false });

    expect(findBySession(idx, "s1")).toHaveLength(2);
    expect(findBySession(idx, "s2")).toHaveLength(1);
    expect(findBySession(idx, "unknown")).toHaveLength(0);
  });

  it("findByRole filters correctly", () => {
    let idx = createEmptyIndex();
    idx = appendEntry(idx, { runId: "r1", sessionId: "s1", role: "auditor", planEpoch: 0, mutationCapable: false });
    idx = appendEntry(idx, { runId: "r2", sessionId: "s1", role: "implementer", planEpoch: 0, mutationCapable: false });

    expect(findByRole(idx, "auditor")).toHaveLength(1);
    expect(findByRole(idx, "implementer")).toHaveLength(1);
    expect(findByRole(idx, "verifier")).toHaveLength(0);
  });

  it("findByRunId returns exact match", () => {
    let idx = createEmptyIndex();
    idx = appendEntry(idx, { runId: "r1", sessionId: "s1", role: "a", planEpoch: 0, mutationCapable: false });
    idx = appendEntry(idx, { runId: "r2", sessionId: "s1", role: "b", planEpoch: 0, mutationCapable: false });

    expect(findByRunId(idx, "r1")?.runId).toBe("r1");
    expect(findByRunId(idx, "nope")).toBeUndefined();
  });
});

describe("AssignmentIndex — launcher-only write enforcement", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtemp();
    revokeLauncher("s1");
    revokeLauncher("s2");
  });

  it("registerLauncher + isLauncher", () => {
    expect(isLauncher("s1")).toBe(false);
    registerLauncher("s1");
    expect(isLauncher("s1")).toBe(true);
    revokeLauncher("s1");
    expect(isLauncher("s1")).toBe(false);
  });

  it("launcherAppend succeeds for registered launcher", () => {
    const fpath = join(dir, "ok.json");
    registerLauncher("s1");
    const idx = launcherAppend(fpath, {
      runId: "r1",
      sessionId: "s1",
      role: "auditor",
      planEpoch: 0,
      mutationCapable: true,
    });
    expect(idx.entries).toHaveLength(1);
  });

  it("launcherAppend throws for unregistered session", () => {
    const fpath = join(dir, "fail.json");
    expect(() =>
      launcherAppend(fpath, {
        runId: "r1",
        sessionId: "unknown",
        role: "auditor",
        planEpoch: 0,
        mutationCapable: true,
      }),
    ).toThrow("not a registered launcher");
  });

  it("revoked launcher cannot append", () => {
    const fpath = join(dir, "revoked.json");
    registerLauncher("s2");
    revokeLauncher("s2");
    expect(() =>
      launcherAppend(fpath, {
        runId: "r1",
        sessionId: "s2",
        role: "auditor",
        planEpoch: 0,
        mutationCapable: true,
      }),
    ).toThrow("not a registered launcher");
  });
});
