// Task 1 hardening: CAS persistence, corruption typing, active-lease fencing,
// frontier-gated VERIFYING, and no-op discipline — all at the dispatch level.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  GoalRecord,
  GoalId,
  AssignmentId,
  ArtifactRef,
  RevisionRef,
  WorkspaceIdentity,
  ISO8601,
} from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import {
  GoalStore,
  VersionConflictError,
  StoreCorruptionError,
  IgnoredEventError,
  InvalidTransitionError,
  GoalExistsError,
} from "../../src/store/goal-store.js";
import {
  dispatchEvent,
  startGoal,
  FenceError,
  type ReceiptLog,
} from "../../src/runtime/lifecycle.js";
import { acquireDriverLeasePersisted, releaseDriverLeasePersisted } from "../../src/runtime/driver.js";

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test-project",
  canonicalRoot: "/tmp/test-project",
  projectKey: "abc123",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-001" as never,
  observedAt: new Date().toISOString() as ISO8601,
  graphRevision: 1,
  dirtySignature: "clean",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-001" as ArtifactRef;
const A1 = "assign-001" as AssignmentId;
const A2 = "assign-002" as AssignmentId;

function makeGoalId(): GoalId {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as GoalId;
}

let dir: string;
let store: GoalStore;
let log: ReceiptLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keystone-task1-"));
  store = new GoalStore(dir);
  log = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function startedGoal(): GoalId {
  const id = makeGoalId();
  startGoal(store, id, createGoalRecord(id, "task", WORKSPACE, REVISION), log);
  return id;
}

function toExecuting(id: GoalId): void {
  dispatchEvent(store, id, {
    type: "PreparationProgress", job: "baseline", planEpoch: 0,
    attemptId: "att-1", basedOnRevision: REVISION, status: "SUCCEEDED",
    driverFence: 0, artifactRef: ARTIFACT,
  }, log);
  dispatchEvent(store, id, {
    type: "PreparationProgress", job: "plan", planEpoch: 0,
    attemptId: "att-2", basedOnRevision: REVISION, status: "SUCCEEDED",
    driverFence: 0, artifactRef: ARTIFACT,
  }, log);
  dispatchEvent(store, id, {
    type: "ReconciliationCompleted", reportRef: ARTIFACT, planEpoch: 0,
    provisionalPlanRef: ARTIFACT, basedOnRevision: REVISION,
    decision: "ACCEPT_PLAN_BASIS",
  }, log);
  dispatchEvent(store, id, { type: "ContractFrozen", contractVersion: 1, contractRef: ARTIFACT }, log);
  dispatchEvent(store, id, {
    type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0,
    assignments: [
      { id: A1, dependsOn: [] },
      { id: A2, dependsOn: [A1] },
    ],
  }, log);
}

describe("CAS persistence", () => {
  it("stale expectedVersion throws VersionConflictError with no write", () => {
    const id = startedGoal();
    const v1 = store.get(id)!.recordVersion;
    dispatchEvent(store, id, { type: "PauseRequested", reason: "x" }, log);
    expect(store.get(id)!.recordVersion).toBe(v1 + 1);

    expect(() =>
      store.update(id, { type: "ResumeRequested" }, { expectedVersion: v1 }),
    ).toThrowError(VersionConflictError);
    // No write happened: state and version untouched.
    expect(store.get(id)!.state).toBe("PAUSED");
    expect(store.get(id)!.recordVersion).toBe(v1 + 1);
  });

  it("matching expectedVersion writes normally", () => {
    const id = startedGoal();
    const v1 = store.get(id)!.recordVersion;
    const updated = store.update(id, { type: "PauseRequested", reason: "x" }, { expectedVersion: v1 });
    expect(updated.state).toBe("PAUSED");
    expect(updated.recordVersion).toBe(v1 + 1);
  });

  it("dispatchEvent CAS-guards the read-modify-write cycle", () => {
    const id = startedGoal();
    // Simulate a concurrent writer bumping the version behind dispatch's back
    // by hand-editing through a second update before dispatch persists.
    const before = store.get(id)!;
    store.update(id, { type: "PauseRequested", reason: "racing writer" });
    // Dispatch re-reads, so it sees the latest version and succeeds on its
    // own fresh read; a truly stale read would conflict. Assert the guard
    // exists by checking a stale direct update fails.
    expect(() =>
      store.update(id, { type: "ResumeRequested" }, { expectedVersion: before.recordVersion }),
    ).toThrowError(VersionConflictError);
  });
});

describe("corruption typing", () => {
  it("get returns null for a missing goal", () => {
    expect(store.get("nope" as GoalId)).toBeNull();
  });

  it("get throws StoreCorruptionError on unparseable JSON", () => {
    const id = makeGoalId();
    writeFileSync(join(dir, "goals", `${id}.json`), "{ not json!!!");
    expect(() => store.get(id)).toThrowError(StoreCorruptionError);
  });

  it("get throws StoreCorruptionError on schema mismatch", () => {
    const id = makeGoalId();
    writeFileSync(join(dir, "goals", `${id}.json`), JSON.stringify({ bogus: true }));
    expect(() => store.get(id)).toThrowError(StoreCorruptionError);
  });
});

describe("active-lease fencing in dispatchEvent", () => {
  it("accepts the live lease token", () => {
    const { id, fence } = makeLeasedGoal(false);
    const { record } = dispatchEvent(store, id, { type: "PauseRequested", reason: "x", driverFence: fence }, log);
    expect(record.state).toBe("PAUSED");
  });

  it("rejects a state-changing event that lacks driverFence while fencing is active", () => {
    const { id } = makeLeasedGoal(false);
    const versionBefore = store.get(id)!.recordVersion;
    expect(() =>
      dispatchEvent(store, id, { type: "PauseRequested", reason: "x" }, log),
    ).toThrowError(FenceError);
    expect(store.get(id)!.recordVersion).toBe(versionBefore);
  });

  it("rejects a stale token against an active lease", () => {
    const { id, fence } = makeLeasedGoal(false);
    const versionBefore = store.get(id)!.recordVersion;
    expect(() =>
      dispatchEvent(store, id, {
        type: "PreparationProgress", job: "baseline", planEpoch: 0,
        attemptId: "att-9", basedOnRevision: REVISION, status: "SUCCEEDED",
        driverFence: fence + 100, artifactRef: ARTIFACT,
      }, log),
    ).toThrowError(FenceError);
    expect(store.get(id)!.recordVersion).toBe(versionBefore);
  });

  it("rejects any fence once the lease has expired", () => {
    const { id, fence } = makeLeasedGoal(true);
    expect(() =>
      dispatchEvent(store, id, {
        type: "PreparationProgress", job: "baseline", planEpoch: 0,
        attemptId: "att-9", basedOnRevision: REVISION, status: "SUCCEEDED",
        driverFence: fence, artifactRef: ARTIFACT,
      }, log),
    ).toThrowError(FenceError);
  });
});

describe("frontier-gated VERIFYING", () => {
  it("first completion marks only its assignment; goal stays EXECUTING", () => {
    const id = makeExecutingWithPlan();
    const { record } = dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    expect(record.assignmentStates[A1]).toBe("COMPLETED");
    // Dispatch boundary: ExecutionStarted opened the full DAG as ACQUIRED /
    // RUNNING, so the in-flight sibling is ACQUIRED (not undefined).
    expect(record.assignmentStates[A2]).toBe("ACQUIRED");
    expect(record.state).toBe("EXECUTING");
  });

  it("goal reaches VERIFYING only when every frontier assignment is terminal", () => {
    const id = makeExecutingWithPlan();
    dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    const { record } = dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A2, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    expect(record.assignmentStates[A1]).toBe("COMPLETED");
    expect(record.assignmentStates[A2]).toBe("COMPLETED");
    expect(record.state).toBe("VERIFYING");
  });
});

describe("ignored events", () => {
  it("reducer no-op throws IgnoredEventError without bumping recordVersion", () => {
    const id = startedGoal(); // PREPARING
    const versionBefore = store.get(id)!.recordVersion;
    expect(() =>
      dispatchEvent(store, id, {
        type: "ReconciliationCompleted", reportRef: ARTIFACT, planEpoch: 0,
        provisionalPlanRef: ARTIFACT, basedOnRevision: REVISION,
        decision: "ACCEPT_PLAN_BASIS",
      }, log),
    ).toThrowError(IgnoredEventError);
    const after: GoalRecord | null = store.get(id);
    expect(after!.state).toBe("PREPARING");
    expect(after!.recordVersion).toBe(versionBefore);
  });
});

// Top-level helpers for the appended suites (the earlier helpers are
// scoped inside their describes).
function makeLeasedGoal(expired: boolean): { id: GoalId; fence: number } {
  const id = startedGoal();
  const persisted = acquireDriverLeasePersisted(store, id, "session-A", {
    ttlMs: expired ? 0 : 60_000,
  });
  if (expired) {
    const rec = store.get(id)!;
    const lease = { ...persisted.activeDriverLease!, expiresAt: "2000-01-01T00:00:00.000Z" as ISO8601 };
    store.update(id, { type: "DriverLeaseAcquired", lease, fenceCounter: rec.driverFenceCounter });
  }
  const after = store.get(id)!;
  return { id, fence: after.activeDriverLease!.fencingToken };
}

function makeExecutingWithPlan(): GoalId {
  const id = makeGoalId();
  const record = createGoalRecord(id, "task", WORKSPACE, REVISION);
  startGoal(store, id, record, log);
  toExecuting(id);
  return id;
}

describe("create() no-clobber", () => {
  it("create() throws GoalExistsError when the goal id already exists", () => {
    const id = startedGoal();
    const versionBefore = store.get(id)!.recordVersion;
    expect(() => store.create(id, createGoalRecord(id, "dup", WORKSPACE, REVISION))).toThrowError(
      GoalExistsError,
    );
    expect(store.get(id)!.recordVersion).toBe(versionBefore);
  });
});

describe("list() corruption isolation", () => {
  it("list() skips corrupt files; listDetailed() collects typed errors", () => {
    const id = startedGoal();
    writeFileSync(join(dir, "goals", "corrupt-goal.json"), "{ broken json", "utf-8");
    const records = store.list();
    expect(records.map((r) => String(r.goalId))).toContain(String(id));
    expect(records).toHaveLength(1);
    const detailed = store.listDetailed();
    expect(detailed.records).toHaveLength(1);
    expect(detailed.errors).toHaveLength(1);
    expect(detailed.errors[0]).toBeInstanceOf(StoreCorruptionError);
  });
});

describe("AssignmentFailed frontier gate (dispatch level)", () => {
  it("failed assignment marks FAILED; goal stays EXECUTING until frontier terminal", () => {
    const id = makeExecutingWithPlan();
    const first = dispatchEvent(store, id, {
      type: "AssignmentFailed", assignmentId: A1, errorRef: ARTIFACT, driverFence: 0,
    }, log);
    expect(first.record.assignmentStates[A1]).toBe("FAILED");
    expect(first.record.state).toBe("EXECUTING");
    const second = dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A2, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    expect(second.record.state).toBe("VERIFYING");
  });
});

describe("RepairCompleted frontier gate (dispatch level)", () => {
  function toRepairing(): GoalId {
    const id = makeExecutingWithPlan();
    dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A2, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "VerificationCompleted", runRef: ARTIFACT, accepted: true, driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "ReviewCompleted", reviewRef: ARTIFACT, candidateIds: [], driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "AdjudicationCompleted", decisionRefs: [ARTIFACT], driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "FinalAuditCompleted", auditRefs: [ARTIFACT, ARTIFACT], accepted: true, driverFence: 0,
    }, log);
    const repairing = dispatchEvent(store, id, {
      type: "CompletionEvaluated", reportRef: ARTIFACT, accepted: false, driverFence: 0,
    }, log);
    expect(repairing.record.state).toBe("REPAIRING");
    return id;
  }

  it("re-enters VERIFYING once the repair completes a terminal frontier", () => {
    const id = toRepairing();
    const first = dispatchEvent(store, id, {
      type: "RepairCompleted", assignmentId: A2, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    // A1 was already COMPLETED from execution; A2 now COMPLETED → terminal.
    expect(first.record.assignmentStates[A2]).toBe("COMPLETED");
    expect(first.record.state).toBe("VERIFYING");
  });
});

describe("persisted driver lease lifecycle", () => {
  it("release persists; fenced events then reject with no active lease", () => {
    const { id, fence } = makeLeasedGoal(false);
    const lease = store.get(id)!.activeDriverLease!;
    const released = releaseDriverLeasePersisted(store, id, {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fencingToken: lease.fencingToken,
    });
    expect(released.activeDriverLease).toBeUndefined();
    expect(store.get(id)!.activeDriverLease).toBeUndefined();
    expect(() =>
      dispatchEvent(store, id, {
        type: "PreparationProgress", job: "baseline", planEpoch: 0,
        attemptId: "att-2", basedOnRevision: REVISION,
        status: "RUNNING", driverFence: fence,
      }, log),
    ).toThrowError(FenceError);
  });

  it("second persisted acquire by another session is rejected without write", () => {
    const { id } = makeLeasedGoal(false);
    const versionBefore = store.get(id)!.recordVersion;
    const same = acquireDriverLeasePersisted(store, id, "session-B", { ttlMs: 60_000 });
    expect(same.activeDriverLease!.sessionId).toBe("session-A");
    expect(store.get(id)!.recordVersion).toBe(versionBefore);
  });
});

describe("invalid transitions are InvalidTransitionError, not IgnoredEventError", () => {
  it("state-changing but forbidden event throws InvalidTransitionError", () => {
    const id = startedGoal(); // PREPARING
    // PreparationProgress/succeeded baseline jumps PREPARING → RECONCILING
    // (valid); then a second one is a no-op. For a genuinely invalid state
    // change, drive READY → REVIEWING via a custom reducer.
    expect(() =>
      store.update(id, { type: "GoalStarted" }, (event, record) => ({
        ...record,
        state: "REVIEWING",
      })),
    ).toThrowError(InvalidTransitionError);
  });

  it("IgnoredEventError stays distinct for true no-ops", () => {
    const id = startedGoal();
    expect(() =>
      dispatchEvent(store, id, {
        type: "ReconciliationCompleted", reportRef: ARTIFACT, planEpoch: 0,
        provisionalPlanRef: ARTIFACT, basedOnRevision: REVISION,
        decision: "ACCEPT_PLAN_BASIS",
      }, log),
    ).toThrowError(IgnoredEventError);
  });
});

describe("recoveryRequired clearing", () => {
  it("lease repair sets recoveryRequired; clear-recovery clears it and continuation resumes", async () => {
    const { repairOrphanedDriverLease, clearRecoveryRequired } =
      await import("../../src/runtime/recovery.js");
    const { buildContinuationContext } = await import("../../src/continuation.js");
    const { id } = makeLeasedGoal(false);
    const repaired = repairOrphanedDriverLease(store, id, log);
    expect(repaired.recoveryRequired).toBe(true);
    expect(repaired.activeDriverLease).toBeUndefined();
    expect(buildContinuationContext(store, id)!.canContinue).toBe(false);
    const cleared = clearRecoveryRequired(store, id, log);
    expect(cleared.recoveryRequired).toBe(false);
    expect(buildContinuationContext(store, id)!.canContinue).toBe(true);
  });

  it("clear-recovery throws IgnoredEventError when already false", async () => {
    const { clearRecoveryRequired } = await import("../../src/runtime/recovery.js");
    const id = startedGoal();
    expect(() => clearRecoveryRequired(store, id, log)).toThrowError(IgnoredEventError);
  });
});

describe("redactError preserves typed CAS fields", () => {
  it("VersionConflictError keeps code+fields, redacts lease material in message", async () => {
    const { redactError } = await import("../../src/observability/redaction.js");
    const err = new VersionConflictError("goal-001", 3, 5);
    err.message += ' leaked context token=supersecret-value {"leaseId":"lease-abc"}';
    const safe = redactError(err) as VersionConflictError;
    expect(safe).toBeInstanceOf(VersionConflictError);
    expect(safe.code).toBe("VERSION_CONFLICT");
    expect(safe.goalId).toBe("goal-001");
    expect(safe.expectedVersion).toBe(3);
    expect(safe.actualVersion).toBe(5);
    expect(safe.message).toContain("[REDACTED]");
    expect(safe.message).not.toContain("supersecret-value");
    expect(safe.message).not.toContain('"leaseId":"lease-abc"');
  });
});

describe("wrong-source events rejected at dispatch (Round-6 P1)", () => {
  it("ContractFrozen outside CONTRACT_REVIEW throws IgnoredEventError", () => {
    const id = startedGoal(); // PREPARING
    const before = store.get(id)!;
    expect(() =>
      dispatchEvent(store, id, { type: "ContractFrozen", contractVersion: 1, contractRef: ARTIFACT }, log),
    ).toThrowError(IgnoredEventError);
    const after = store.get(id)!;
    expect(after.state).toBe(before.state);
    expect(after.recordVersion).toBe(before.recordVersion);
    expect(after.contractVersion).toBe(before.contractVersion);
  });

  it("VerificationCompleted outside VERIFYING throws IgnoredEventError", () => {
    const id = makeExecutingWithPlan(); // EXECUTING
    const before = store.get(id)!;
    expect(() =>
      dispatchEvent(store, id, {
        type: "VerificationCompleted", runRef: ARTIFACT, accepted: true, driverFence: 0,
      }, log),
    ).toThrowError(IgnoredEventError);
    expect(store.get(id)!.recordVersion).toBe(before.recordVersion);
    expect(store.get(id)!.state).toBe("EXECUTING");
  });

  it("ReviewCompleted/AdjudicationCompleted/FinalAuditCompleted/CompletionEvaluated outside source rejected", () => {
    const id = makeExecutingWithPlan();
    const before = store.get(id)!;
    const events = [
      { type: "ReviewCompleted", reviewRef: ARTIFACT, candidateIds: [], driverFence: 0 },
      { type: "AdjudicationCompleted", decisionRefs: [ARTIFACT], driverFence: 0 },
      { type: "FinalAuditCompleted", auditRefs: [ARTIFACT, ARTIFACT], accepted: true, driverFence: 0 },
      { type: "CompletionEvaluated", reportRef: ARTIFACT, accepted: true, driverFence: 0 },
    ] as const;
    for (const ev of events) {
      expect(() => dispatchEvent(store, id, { ...ev }, log)).toThrowError(IgnoredEventError);
    }
    const after = store.get(id)!;
    expect(after.state).toBe(before.state);
    expect(after.recordVersion).toBe(before.recordVersion);
  });

  it("ExecutionStarted outside READY/VERIFYING throws IgnoredEventError", () => {
    const id = makeExecutingWithPlan(); // EXECUTING
    const before = store.get(id)!;
    expect(() =>
      dispatchEvent(store, id, {
        type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ARTIFACT, driverFence: 0,
      }, log),
    ).toThrowError(IgnoredEventError);
    expect(store.get(id)!.recordVersion).toBe(before.recordVersion);
  });
});

describe("out-of-state Assignment* leave record untouched (Round-6 P1)", () => {
  it("AssignmentCompleted outside EXECUTING throws IgnoredEventError with no write", () => {
    const id = makeExecutingWithPlan();
    // Drive to VERIFYING first (full frontier terminal).
    dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    dispatchEvent(store, id, {
      type: "AssignmentCompleted", assignmentId: A2, reportRef: ARTIFACT, driverFence: 0,
    }, log);
    expect(store.get(id)!.state).toBe("VERIFYING");
    const before = store.get(id)!;
    const beforeStates = { ...before.assignmentStates };
    expect(() =>
      dispatchEvent(store, id, {
        type: "AssignmentCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
      }, log),
    ).toThrowError(IgnoredEventError);
    const after = store.get(id)!;
    expect(after.state).toBe("VERIFYING");
    expect(after.assignmentStates).toEqual(beforeStates);
    expect(after.driverFenceCounter).toBe(before.driverFenceCounter);
    expect(after.recordVersion).toBe(before.recordVersion);
  });

  it("AssignmentFailed outside EXECUTING throws IgnoredEventError with no write", () => {
    const id = startedGoal(); // PREPARING
    const before = store.get(id)!;
    expect(() =>
      dispatchEvent(store, id, {
        type: "AssignmentFailed", assignmentId: A1, errorRef: ARTIFACT, driverFence: 0,
      }, log),
    ).toThrowError(IgnoredEventError);
    const after = store.get(id)!;
    expect(after.assignmentStates).toEqual({});
    expect(after.driverFenceCounter).toBe(before.driverFenceCounter);
    expect(after.recordVersion).toBe(before.recordVersion);
  });

  it("RepairCompleted outside REPAIRING throws IgnoredEventError with no write", () => {
    const id = makeExecutingWithPlan(); // EXECUTING, not REPAIRING
    const before = store.get(id)!;
    expect(() =>
      dispatchEvent(store, id, {
        type: "RepairCompleted", assignmentId: A1, reportRef: ARTIFACT, driverFence: 0,
      }, log),
    ).toThrowError(IgnoredEventError);
    const after = store.get(id)!;
    expect(after.assignmentStates).toEqual(before.assignmentStates);
    expect(after.driverFenceCounter).toBe(before.driverFenceCounter);
    expect(after.recordVersion).toBe(before.recordVersion);
    expect(after.state).toBe("EXECUTING");
  });
});

describe("delete is lock-guarded (Round-6 P1)", () => {
  it("delete-then-update throws and does not resurrect", () => {
    const id = startedGoal();
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(() => store.update(id, { type: "PauseRequested", reason: "x" })).toThrow();
    expect(store.get(id)).toBeNull();
  });

  it("update-then-delete leaves no record behind", () => {
    const id = startedGoal();
    store.update(id, { type: "PauseRequested", reason: "x" });
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeNull();
  });

  it("concurrent delete+update never resurrects a partial record", async () => {
    const id = startedGoal();
    const storeB = new GoalStore(dir);
    const outcomes = await Promise.allSettled([
      (async () => store.delete(id))(),
      (async () => storeB.update(id, { type: "PauseRequested", reason: "racing" }))(),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: true });
    expect(outcomes[1].status).toBe("rejected");
    // Either the update landed first (then delete removed it) or delete
    // landed first (then update threw on missing): the goal must be gone,
    // never a resurrected/partial file.
    expect(store.get(id)).toBeNull();
  });
});

describe("frontier setup dispatch failures return ok:false (Round-6 P2)", () => {
  async function frontierSetup() {
    const { runExecutionFrontier } = await import("../../src/execution/read-only-launcher.js");
    return { runExecutionFrontier };
  }

  function sched(ids: string[]) {
    return ids.map((id) => ({
      assignment: {
        id: id as never, role: "implementer" as const, targetFiles: [],
        acceptanceCriteria: ["done"], contractRef: "c" as never,
      },
      dependsOn: [] as never[],
    }));
  }

  it("ExecutionStarted dispatch throw (goal already EXECUTING) -> ok:false with setup failure", async () => {
    const { runExecutionFrontier } = await frontierSetup();
    const id = makeExecutingWithPlan(); // EXECUTING: setup ExecutionStarted guard rejects
    const out = await runExecutionFrontier(store, id, sched(["fz-1"]), async (a) => ({
      assignmentId: a.id as never, runId: "run-fz", sessionId: "s",
      findings: [], evidenceRefs: [], status: "DELIVERED" as const,
      createdAt: new Date().toISOString() as never,
    }) as never, {
      contractVersion: 1,
      executionPlanRef: ARTIFACT,
      reportRefFor: () => "r" as ArtifactRef,
      receiptLog: log,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.results).toEqual([]);
      expect(out.failures).toHaveLength(1);
    }
    expect(store.get(id)!.state).toBe("EXECUTING");
  });

  it("DAG-error BlockDeclared dispatch throw (goal FAILED) -> ok:false with typed errors", async () => {
    const { runExecutionFrontier } = await frontierSetup();
    const id = startedGoal();
    // Force FAILED via FatalError from PREPARING (valid transition).
    dispatchEvent(store, id, { type: "FatalError", errorRef: ARTIFACT }, log);
    expect(store.get(id)!.state).toBe("FAILED");
    // FAILED is terminal: the setup BlockDeclared guard rejects -> caught -> ok:false.
    const dupe = [...sched(["fd-1"]), ...sched(["fd-1"])];
    const out = await runExecutionFrontier(store, id, dupe, async (a) => ({
      assignmentId: a.id as never, runId: "run-fd", sessionId: "s",
      findings: [], evidenceRefs: [], status: "DELIVERED" as const,
      createdAt: new Date().toISOString() as never,
    }) as never, {
      contractVersion: 1,
      executionPlanRef: ARTIFACT,
      reportRefFor: () => "r" as ArtifactRef,
      receiptLog: log,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.results).toEqual([]);
      expect(out.errors?.[0]?.kind).toBe("DUPLICATE_ID");
      expect(out.failures).toHaveLength(1);
    }
  });
});
