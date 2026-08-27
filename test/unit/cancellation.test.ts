import { describe, it, expect } from "vitest";
import type { GoalRecord, GoalId, MutationLease, RevisionRef, WorkspaceIdentity } from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { cancelGoal } from "../../src/ui/cancellation.js";
import { createQuarantine } from "../../src/runtime/recovery.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test",
  canonicalRoot: "/tmp/test",
  projectKey: "abc",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-1" as any,
  observedAt: iso() as any,
  gitHead: "abc",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "sig",
  capabilityDigest: "cap",
};

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  const base = createGoalRecord("goal-1" as GoalId, "test task", WORKSPACE, REVISION);
  return { ...base, ...overrides };
}

function makeMutationLease(overrides: Partial<MutationLease> = {}): MutationLease {
  return {
    leaseId: "mut-1",
    fencingToken: 1,
    assignmentId: "asgn-1" as any,
    sessionId: "sess-1",
    workerProcessIdentity: "pid-1",
    canonicalWorkspaceRoot: "/tmp/test",
    allowedCanonicalPaths: [],
    baseDirtySignature: "sig",
    phase: "MUTATING",
    acquiredAt: iso() as any,
    heartbeatAt: iso() as any,
    expiresAt: iso(60_000) as any,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("cancelGoal", () => {
  it("returns settled for terminal DONE goal", () => {
    const goal = makeGoal({ state: "DONE" });
    const result = cancelGoal(goal, iso());
    expect(result.settled).toBe(true);
    expect(result.outcome).toBe("SETTLED");
    expect(result.quarantined).toBe(false);
  });

  it("returns settled for terminal CANCELLED goal", () => {
    const goal = makeGoal({ state: "CANCELLED" });
    expect(cancelGoal(goal, iso()).settled).toBe(true);
  });

  it("returns not-settled for non-CANCELLING active state", () => {
    const goal = makeGoal({ state: "EXECUTING" });
    const result = cancelGoal(goal, iso());
    expect(result.settled).toBe(false);
    expect(result.outcome).toBe("INDETERMINATE");
  });

  it("settles CANCELLING goal with no mutation lease", () => {
    const goal = makeGoal({ state: "CANCELLING", activeMutationLease: undefined });
    const result = cancelGoal(goal, iso());
    expect(result.settled).toBe(true);
    expect(result.outcome).toBe("SETTLED");
  });

  it("settles CANCELLING with SETTLING mutation", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "SETTLING" }),
    });
    const result = cancelGoal(goal, iso());
    expect(result.settled).toBe(true);
    expect(result.outcome).toBe("SETTLED");
  });

  it("rolls back CANCELLING with active MUTATING mutation", () => {
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({ phase: "MUTATING" }),
    });
    const result = cancelGoal(goal, iso());
    expect(result.settled).toBe(true);
    expect(result.outcome).toBe("ROLLED_BACK");
  });

  it("quarantines indeterminate mutation when lease outlasts timeout", () => {
    const quarantine = createQuarantine();
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({
        phase: "ACQUIRED",
        expiresAt: iso(120_000) as any, // expires in 2 min
      }),
    });
    const result = cancelGoal(goal, iso(), {
      settlementTimeoutMs: 30_000,
      quarantine,
    });
    expect(result.settled).toBe(false);
    expect(result.outcome).toBe("INDETERMINATE");
    expect(result.quarantined).toBe(true);
    expect(quarantine.entries.length).toBe(1);
    expect(quarantine.entries[0].goalId).toBe("goal-1");
  });

  it("does not quarantine when lease expires within timeout", () => {
    const quarantine = createQuarantine();
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({
        phase: "ACQUIRED",
        expiresAt: iso(10_000) as any, // expires in 10s, within 30s timeout
      }),
    });
    const result = cancelGoal(goal, iso(), {
      settlementTimeoutMs: 30_000,
      quarantine,
    });
    expect(result.settled).toBe(false);
    expect(result.quarantined).toBe(false);
    expect(quarantine.entries.length).toBe(0);
  });

  it("returns correct goalId", () => {
    const goal = makeGoal({ goalId: "g-special" as GoalId, state: "BLOCKED" });
    expect(cancelGoal(goal, iso()).goalId).toBe("g-special");
  });

  it("uses default timeout when not specified", () => {
    const quarantine = createQuarantine();
    const goal = makeGoal({
      state: "CANCELLING",
      activeMutationLease: makeMutationLease({
        phase: "ACQUIRED",
        expiresAt: iso(60_000) as any,
      }),
    });
    // Default timeout is 30s. Lease expires in 60s > 30s → quarantined
    const result = cancelGoal(goal, iso(), { quarantine });
    expect(result.quarantined).toBe(true);
  });
});
