import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ArtifactRef, AssignmentId, GoalEvent, GoalId } from "../../src/domain/types.js";
import {
  dispatchReadOnly,
  executeReadOnly,
  watchLiveCompletion,
  completionStatusOf,
  READ_ONLY_POLICY,
  type ContextView,
} from "../../src/execution/read-only-launcher.js";
import {
  dispatchMutation,
  executeMutation,
  acquireAuthority,
  AuthorityNotReadyError,
  AuthorityGateError,
  validateMutationLease,
  KEYSTONE_BINDING_NAMESPACE,
  authorityBindings,
  type MutationLaunchResult,
} from "../../src/execution/mutation-launcher.js";
import { acquireLease, releaseLease } from "../../src/execution/mutation-lease.js";
import { createApproval } from "../../src/execution/approval.js";
import type { WorkspaceSnapshot } from "../../src/baseline/snapshot.js";
import type { MutationLease } from "../../src/domain/types.js";
import { RunRegistry } from "../../src/rpc/run-registry.js";
import type { SubagentRpcClient } from "../../src/rpc/subagent-rpc-client.js";
import type { AsyncCompletePayload, SpawnResult } from "../../src/rpc/types.js";
import {
  ensureKeystoneSessionBridges,
  setSpawnCeiling,
  restoreReaderCeiling,
  resetSessionBridges,
  defaultChildGuardPath,
  SubagentsBridgeError,
  CAPABILITY_CEILING_REGISTRY_KEY,
  REQUIRED_CHILD_EXTENSIONS_REGISTRY_KEY,
} from "../../src/rpc/subagents-bridge.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const ASSIGNMENT = {
  id: "asgn-001" as AssignmentId,
  description: "Fix the auth middleware bug",
  targetFiles: ["src/auth.ts"],
};

const CONTEXT: ContextView = {
  goalId: "goal-001",
  task: "Fix authentication",
  workspace: "/tmp/test",
  targetFiles: ["src/auth.ts"],
};

const WRITE_SET = { writeSet: ["src/auth.ts"] };

function makeLease(overrides: Partial<MutationLease> = {}): MutationLease {
  return {
    leaseId: "lease-001",
    fencingToken: 1,
    assignmentId: "asgn-001" as AssignmentId,
    sessionId: "sess-001",
    workerProcessIdentity: "pid-001",
    canonicalWorkspaceRoot: "/tmp/test",
    allowedCanonicalPaths: ["src/auth.ts"],
    baseDirtySignature: "sig-001",
    phase: "ACQUIRED",
    acquiredAt: iso() as any,
    heartbeatAt: iso() as any,
    expiresAt: iso(60_000) as any,
    ...overrides,
  };
}

// ─── Read-only launcher ─────────────────────────────────────────────────────

describe("dispatchReadOnly", () => {
  it("returns read-only policy in delegation", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.delegation.toolPolicy).toEqual(READ_ONLY_POLICY);
  });

  it("report starts null", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.report).toEqual(null);
  });

  it("carries assignment id and context", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.delegation.assignmentId).toEqual("asgn-001");
    expect(result.delegation.contextView.goalId).toEqual("goal-001");
    expect(result.delegation.task).toEqual(ASSIGNMENT.description);
  });

  it("read-only policy denies mutation tools", () => {
    // The policy kind is "read-only" which tool-policy enforces
    expect(READ_ONLY_POLICY.kind).toEqual("read-only");
  });

  it("throws on missing assignment id", () => {
    expect(() =>
      dispatchReadOnly({ ...ASSIGNMENT, id: "" as AssignmentId }, CONTEXT),
    ).toThrow("assignment.id required");
  });

  it("throws on missing goalId", () => {
    expect(() =>
      dispatchReadOnly(ASSIGNMENT, { ...CONTEXT, goalId: "" }),
    ).toThrow("contextView.goalId required");
  });

  it("throws on missing task", () => {
    expect(() =>
      dispatchReadOnly(ASSIGNMENT, { ...CONTEXT, task: "" }),
    ).toThrow("contextView.task required");
  });
});

// ─── Lease validation ───────────────────────────────────────────────────────

describe("validateMutationLease", () => {
  it("accepts valid ACQUIRED lease", () => {
    const lease = makeLease({ phase: "ACQUIRED" });
    expect(validateMutationLease(lease)).toEqual({ ok: true });
  });

  it("accepts valid AUTHORITY_READY lease", () => {
    const lease = makeLease({ phase: "AUTHORITY_READY" });
    expect(validateMutationLease(lease)).toEqual({ ok: true });
  });

  it("rejects expired lease", () => {
    const lease = makeLease({ expiresAt: iso(-1_000) as any });
    expect(validateMutationLease(lease)).toEqual({ ok: false, reason: "lease expired" });
  });

  it("rejects MUTATING phase lease", () => {
    const lease = makeLease({ phase: "MUTATING" });
    const result = validateMutationLease(lease);
    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.reason).toContain("MUTATING");
    }
  });

  it("rejects SETTLING phase lease", () => {
    const lease = makeLease({ phase: "SETTLING" });
    const result = validateMutationLease(lease);
    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.reason).toContain("SETTLING");
    }
  });
});

// ─── Mutation launcher ──────────────────────────────────────────────────────

describe("dispatchMutation", () => {
  it("returns two turns: acquisition then mutation", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, WRITE_SET);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].phase).toEqual("acquisition");
    expect(result.turns[1].phase).toEqual("mutation");
  });

  it("acquisition turn uses read-only policy", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, WRITE_SET);
    expect(result.turns[0].delegation.toolPolicy.kind).toEqual("read-only");
  });

  it("mutation turn uses mutation policy with structural lease permit", () => {
    const lease = makeLease({ leaseId: "lease-xyz", fencingToken: 7 });
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, lease, undefined, WRITE_SET);
    const mutationPolicy = result.turns[1].delegation.toolPolicy;
    expect(mutationPolicy.kind).toEqual("mutation");
    expect(mutationPolicy.permit).toEqual({ leaseId: "lease-xyz", fencingToken: 7 });
    expect(mutationPolicy.approvedCommands).toEqual([]);
  });

  it("mutation requires valid lease", () => {
    const expired = makeLease({ expiresAt: iso(-1_000) as any });
    expect(() => dispatchMutation(ASSIGNMENT, CONTEXT, expired, undefined, WRITE_SET)).toThrow("lease expired");
  });

  it("mutation rejects lease for wrong assignment", () => {
    const lease = makeLease({
      assignmentId: "asgn-999" as AssignmentId,
    });
    expect(() => dispatchMutation(ASSIGNMENT, CONTEXT, lease, undefined, WRITE_SET)).toThrow(
      "lease assignment mismatch",
    );
  });

  it("report starts null", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, WRITE_SET);
    expect(result.report).toEqual(null);
  });

  it("two-phase authority: acquisition always read-only regardless of lease phase", () => {
    const lease = makeLease({ phase: "AUTHORITY_READY" });
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, lease, undefined, WRITE_SET);
    expect(result.turns[0].delegation.toolPolicy.kind).toEqual("read-only");
    expect(result.turns[1].delegation.toolPolicy.kind).toEqual("mutation");
  });

  it("throws when acquisition writeSet missing (never planner targetFiles alone)", () => {
    expect(() => dispatchMutation(ASSIGNMENT, CONTEXT, makeLease())).toThrow(
      "acquisition writeSet required",
    );
  });

  it("throws when write-set does not match lease scope", () => {
    expect(() =>
      dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, { writeSet: ["src/other.ts"] }),
    ).toThrow("does not match lease");
  });

  it("throws when write-set escapes workspace root", () => {
    expect(() =>
      dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, { writeSet: ["../escape.ts"] }),
    ).toThrow("escapes workspace root");
  });

  it("ignores planner targetFiles for scope (write-set binds)", () => {
    const wide = { ...ASSIGNMENT, targetFiles: ["src/auth.ts", "src/unscoped.ts"] };
    const result = dispatchMutation(wide, CONTEXT, makeLease(), undefined, WRITE_SET);
    expect(result.turns).toHaveLength(2);
  });

  it("throws on missing inputs", () => {
    const lease = makeLease();
    expect(() =>
      dispatchMutation({ ...ASSIGNMENT, id: "" as AssignmentId }, CONTEXT, lease),
    ).toThrow("assignment.id required");
  });
});

// ─── Authority sentinel block (Task 7) ──────────────────────────────────────

// Task-text sentinel transport removed (Round-1 P2): lease JSON travels ONLY
// via extensionBindings. No sentinel consts remain to test.

describe("authorityBindings", () => {
  it("uses a pi-subagents-valid binding namespace and stays under the size cap", () => {
    // Mirrors pi-subagents EXTENSION_BINDING_NAMESPACE + MAX_EXTENSION_BINDINGS_BYTES.
    expect(KEYSTONE_BINDING_NAMESPACE).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/);
    const bindings = authorityBindings({ leaseId: "l1", fencingToken: 7 } as never);
    expect(bindings[KEYSTONE_BINDING_NAMESPACE]).toMatchObject({
      leaseId: "l1",
      fencingToken: 7,
      approvedCommands: [],
      allowedMcpTools: [],
    });
    expect(Buffer.byteLength(JSON.stringify(bindings), "utf8")).toBeLessThan(16 * 1024);
  });
});

describe("completionStatusOf", () => {
  it("SUCCEEDED on complete results, FAILED otherwise", () => {
    const ok = { runId: "r", results: [{ agent: "a", status: "complete", summary: "s", index: 0 }] } as AsyncCompletePayload;
    expect(completionStatusOf(ok)).toEqual("SUCCEEDED");
    expect(completionStatusOf({ runId: "r", results: [] })).toEqual("FAILED");
    const bad = { runId: "r", results: [{ agent: "a", status: "error", summary: "s", index: 0 }] } as AsyncCompletePayload;
    expect(completionStatusOf(bad)).toEqual("FAILED");
  });

  it("FAILED fail-closed on absent results (live single-child emits conditionally)", () => {
    expect(completionStatusOf({ runId: "r" })).toEqual("FAILED");
    expect(completionStatusOf({ runId: "r", results: undefined })).toEqual("FAILED");
  });
});

// ─── Live execution paths (Task 7) ──────────────────────────────────────────

function fakeSpawnResult(runId: string): SpawnResult {
  return { text: "spawned", details: { mode: "async", asyncId: "a", asyncDir: "d", runId } };
}

type FakeClient = {
  spawned: unknown[];
  handlers: Array<(p: AsyncCompletePayload) => void>;
  client: SubagentRpcClient;
};

function fakeClient(runId: string): FakeClient {
  const spawned: unknown[] = [];
  const handlers: Array<(p: AsyncCompletePayload) => void> = [];
  const client = {
    spawn: async (params: unknown) => { spawned.push(params); return fakeSpawnResult(runId); },
    onAsyncComplete: (h: (p: AsyncCompletePayload) => void) => {
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  } as unknown as SubagentRpcClient;
  return { spawned, handlers, client };
}

function asyncPayload(runId: string, status = "complete"): AsyncCompletePayload {
  return { runId, results: [{ agent: "reader", status, summary: "done", index: 0 }] };
}

describe("executeReadOnly", () => {
  it("spawns configured-role-compatible scout without pinning a model, registers run, bridges once, dispatches completion", async () => {
    const fake = fakeClient("run-ro-1");
    const registry = new RunRegistry();
    const bridged: string[] = [];
    const dispatched: GoalEvent[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    const { runId } = await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      registry,
      ensureBridges: (sid: string) => { bridged.push(sid); },
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: 7,
        reportRefFor: () => "ref-ro-1" as ArtifactRef,
        dispatch: (event: GoalEvent) => { dispatched.push(event); },
      },
    });
    expect(runId).toEqual("run-ro-1");
    expect(bridged).toEqual(["sess-live"]);
    expect(fake.spawned).toEqual([{ agent: "scout", task: delegation.task, context: "fresh" }]);
    expect((fake.spawned[0] as Record<string, unknown>).model).toBeUndefined();
    expect(registry.lookupByRunId("run-ro-1")?.record.status).toEqual("RUNNING");
    expect(fake.handlers).toHaveLength(1);
    fake.handlers[0]!(asyncPayload("run-ro-1"));
    expect(dispatched).toEqual([
      { type: "AssignmentCompleted", assignmentId: delegation.assignmentId, reportRef: "ref-ro-1", driverFence: 7 },
    ]);
    // Terminally consumed: listener one-shot unwatched + run removed from registry.
    expect(fake.handlers).toHaveLength(0);
    expect(registry.lookupByRunId("run-ro-1")).toBeUndefined();
    expect(registry.size).toEqual(0);
  });

  it("failed child dispatches AssignmentFailed (not AssignmentCompleted)", async () => {
    const fake = fakeClient("run-ro-fail");
    const dispatched: GoalEvent[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: 7,
        reportRefFor: () => "ref-should-be-ignored" as ArtifactRef,
        errorRefFor: () => "err-ro-fail" as ArtifactRef,
        dispatch: (event: GoalEvent) => { dispatched.push(event); },
      },
    });
    fake.handlers[0]!(asyncPayload("run-ro-fail", "error"));
    expect(dispatched).toEqual([
      { type: "AssignmentFailed", assignmentId: delegation.assignmentId, errorRef: "err-ro-fail", driverFence: 7 },
    ]);
  });

  it("failed child without errorRefFor still dispatches AssignmentFailed (errorRef optional)", async () => {
    const fake = fakeClient("run-ro-fail2");
    const dispatched: GoalEvent[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: 7,
        reportRefFor: () => "ref-x" as ArtifactRef,
        dispatch: (event: GoalEvent) => { dispatched.push(event); },
      },
    });
    fake.handlers[0]!({ runId: "run-ro-fail2" });
    expect(dispatched).toEqual([
      { type: "AssignmentFailed", assignmentId: delegation.assignmentId, driverFence: 7 },
    ]);
  });

  it("sink with no dispatch target throws typed CompletionSinkError", async () => {
    const { CompletionSinkError } = await import("../../src/execution/read-only-launcher.js");
    const fake = fakeClient("run-ro-notarget");
    const seen: unknown[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: 7,
        reportRefFor: () => "ref-x" as ArtifactRef,
        onError: (err) => { seen.push(err); },
      },
    });
    fake.handlers[0]!(asyncPayload("run-ro-notarget"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(CompletionSinkError);
  });

  it("failed child advances the goal frontier: FAILED slot still reaches VERIFYING when terminal", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { GoalStore } = await import("../../src/store/goal-store.js");
    const { createGoalRecord } = await import("../../src/domain/goal-record.js");
    const { startGoal, dispatchEvent } = await import("../../src/runtime/lifecycle.js");
    const dir = mkdtempSync(join(tmpdir(), "keystone-launcher-frontier-"));
    try {
    const store = new GoalStore(dir);
    const log: GoalEvent[] = [];
    const goalId = "goal-frontier" as GoalId;
    const rev = {
      snapshotId: "s" as never, observedAt: new Date().toISOString() as never,
      graphRevision: 1, dirtySignature: "", capabilityDigest: "",
    };
    const ws = { requestedRoot: "/tmp", canonicalRoot: "/tmp", projectKey: "k", vcs: "git" } as never;
    startGoal(store, goalId, createGoalRecord(goalId, "t", ws, rev), log as never);
    const ART0 = "art" as ArtifactRef;
    for (const job of ["baseline", "plan"] as const) {
      dispatchEvent(store, goalId, {
        type: "PreparationProgress", job, planEpoch: 0, attemptId: `a-${job}`,
        basedOnRevision: rev as never, status: "SUCCEEDED", driverFence: 0, artifactRef: ART0,
      }, log as never);
    }
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted", reportRef: ART0, planEpoch: 0,
      provisionalPlanRef: ART0, basedOnRevision: rev as never, decision: "ACCEPT_PLAN_BASIS",
    }, log as never);
    dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ART0 }, log as never);
    const { dispatchReadOnly: dispatchRO } = await import("../../src/execution/read-only-launcher.js");
    const delegation = dispatchRO(
      { id: "asgn-001" as never, description: "frontier probe", targetFiles: [] },
      { goalId: goalId as string, task: "frontier probe", workspace: "/tmp", targetFiles: [] },
    ).delegation;
    const A2 = "asgn-002" as typeof delegation.assignmentId;
    dispatchEvent(store, goalId, {
      type: "ExecutionStarted", contractVersion: 1, executionPlanRef: "ep" as never,
      driverFence: 0, assignments: [{ id: delegation.assignmentId, dependsOn: [] }, { id: A2, dependsOn: [] }],
    }, log as never);
    // Failed child #1 -> AssignmentFailed through the sink (store path).
    const fake = fakeClient("run-ro-frontier");
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId, assignmentId: delegation.assignmentId, driverFence: 0,
        reportRefFor: () => "ref-x" as ArtifactRef,
        errorRefFor: () => "err-1" as ArtifactRef,
        store, receiptLog: log as never,
      },
    });
    fake.handlers[0]!(asyncPayload("run-ro-frontier", "error"));
    expect(store.get(goalId)!.assignmentStates[delegation.assignmentId]).toBe("FAILED");
    expect(store.get(goalId)!.state).toBe("EXECUTING");
    // Second slot completes -> frontier terminal -> VERIFYING.
    dispatchEvent(store, goalId, {
      type: "AssignmentCompleted", assignmentId: A2, reportRef: "r2" as never, driverFence: 0,
    }, log as never);
    expect(store.get(goalId)!.state).toBe("VERIFYING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watchLiveCompletion rethrows dispatch failure when no onError provided", async () => {
    const fake = fakeClient("run-ro-3");
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    const unwatch = watchLiveCompletion(fake.client, "run-ro-3", undefined, {
      goalId: "goal-001" as GoalId,
      assignmentId: delegation.assignmentId,
      driverFence: 1,
      reportRefFor: () => "ref-ro-3" as ArtifactRef,
      dispatch: () => { throw new Error("store down"); },
    });
    expect(() => fake.handlers[0]!(asyncPayload("run-ro-3"))).toThrow("store down");
    unwatch();
  });

  it("watchLiveCompletion routes dispatch failure to onError when provided", async () => {
    const fake = fakeClient("run-ro-4");
    const seen: unknown[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    watchLiveCompletion(fake.client, "run-ro-4", undefined, {
      goalId: "goal-001" as GoalId,
      assignmentId: delegation.assignmentId,
      driverFence: 1,
      reportRefFor: () => "ref-ro-4" as ArtifactRef,
      dispatch: () => { throw new Error("store down"); },
      onError: (err) => { seen.push(err); },
    });
    fake.handlers[0]!(asyncPayload("run-ro-4"));
    expect(seen).toHaveLength(1);
    expect(String((seen[0] as Error).message)).toContain("store down");
  });

  it("pins the spawn-captured fence: store drift never re-resolves the token", async () => {
    // Goal counter is 0; the sink carries a stale spawn fence (7). The pinned
    // fence must dispatch AS-IS and fail typed (FenceError) — the old
    // fresh-read path would have re-resolved fence 0 and silently succeeded.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { GoalStore } = await import("../../src/store/goal-store.js");
    const { createGoalRecord } = await import("../../src/domain/goal-record.js");
    const { startGoal } = await import("../../src/runtime/lifecycle.js");
    const dir = mkdtempSync(join(tmpdir(), "keystone-pinned-fence-"));
    try {
    const store = new GoalStore(dir);
    const log: GoalEvent[] = [];
    const goalId = "goal-pinned" as GoalId;
    const rev = {
      snapshotId: "s" as never, observedAt: new Date().toISOString() as never,
      graphRevision: 1, dirtySignature: "", capabilityDigest: "",
    };
    const ws = { requestedRoot: "/tmp", canonicalRoot: "/tmp", projectKey: "k", vcs: "git" } as never;
    startGoal(store, goalId, createGoalRecord(goalId, "t", ws, rev), log as never);
    const fake = fakeClient("run-ro-pinned");
    const seen: unknown[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId,
        assignmentId: delegation.assignmentId,
        driverFence: 7,
        reportRefFor: () => "ref-pinned" as ArtifactRef,
        store,
        receiptLog: log as never,
        onError: (err) => { seen.push(err); },
      },
    });
    fake.handlers[0]!(asyncPayload("run-ro-pinned"));
    expect(seen).toHaveLength(1);
    expect(String((seen[0] as Error).message)).toContain("Driver fence rejected");
    expect(store.get(goalId)!.assignmentStates[delegation.assignmentId]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores async-complete for other runs", async () => {
    const fake = fakeClient("run-ro-2");
    const dispatched: GoalEvent[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: 1,
        reportRefFor: () => "ref-x" as ArtifactRef,
        dispatch: (event: GoalEvent) => { dispatched.push(event); },
      },
    });
    fake.handlers[0]!(asyncPayload("some-other-run"));
    expect(dispatched).toHaveLength(0);
  });

  it("seam dispatch without a pinned fence fails typed (no unfenced completion)", async () => {
    const { CompletionSinkError } = await import("../../src/execution/read-only-launcher.js");
    const fake = fakeClient("run-ro-nofence");
    const seen: unknown[] = [];
    const delegation = dispatchReadOnly(ASSIGNMENT, CONTEXT).delegation;
    await executeReadOnly(delegation, fake.client, {
      sessionId: "sess-live",
      ensureBridges: () => {},
      completion: {
        goalId: "goal-001" as GoalId,
        assignmentId: delegation.assignmentId,
        driverFence: undefined as never,
        reportRefFor: () => "ref-x" as ArtifactRef,
        dispatch: () => { throw new Error("must not dispatch unfenced"); },
        onError: (err) => { seen.push(err); },
      },
    });
    fake.handlers[0]!(asyncPayload("run-ro-nofence"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(CompletionSinkError);
  });
});

describe("executeMutation", () => {
  it("spawn carries bindings-only lease transport (no task-text sentinel), bridges once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher-live-lease-"));
    try {
      const acquired = acquireLease({
        goalId: "goal-001",
        assignmentId: ASSIGNMENT.id,
        sessionId: "sess-mu",
        root: dir,
        writeSet: ["src/auth.ts"],
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;
      const gated = acquireAuthority({
        root: dir,
        leaseId: acquired.lease.leaseId,
        sessionId: "sess-mu",
        goalId: "goal-001",
        assignmentId: ASSIGNMENT.id,
        planEpoch: 0,
        currentSnapshot: {
          revision: null,
          staged: [],
          modified: [],
          untracked: [],
          dirtySignature: "",
          contentHashes: {},
        },
        actualWriteSet: ["src/auth.ts"],
      });
      expect(gated.ok).toBe(true);
      if (!gated.ok) return;
      const fake = fakeClient("run-mu-1");
      const registry = new RunRegistry();
      const bridged: string[] = [];
      const delegation = dispatchMutation(
        ASSIGNMENT,
        { ...CONTEXT, workspace: dir },
        gated.lease,
        undefined,
        { writeSet: ["src/auth.ts"] },
      ).turns[1]!.delegation;
      const { runId } = await executeMutation(gated.lease, delegation, fake.client, {
        sessionId: "sess-mu",
        registry,
        ensureBridges: (sid: string) => { bridged.push(sid); },
      });
      expect(runId).toEqual("run-mu-1");
      expect(bridged).toEqual(["sess-mu"]);
      expect(fake.spawned).toHaveLength(1);
      const params = fake.spawned[0] as { agent: string; task: string; context?: string; model?: string; cwd: string; extensionBindings: Record<string, unknown> };
      expect(params.agent).toEqual("worker");
      expect(params.context).toEqual("fresh");
      expect(params.model).toBeUndefined();
      expect(params.cwd).toEqual(gated.lease.canonicalWorkspaceRoot);
      expect(params.task).toEqual(delegation.task);
      expect(params.task).not.toContain("KEYSTONE-AUTHORITY");
      expect(params.extensionBindings[KEYSTONE_BINDING_NAMESPACE]).toMatchObject({
        leaseId: gated.lease.leaseId,
        fencingToken: gated.lease.fencingToken,
        canonicalWorkspaceRoot: gated.lease.canonicalWorkspaceRoot,
        phase: "MUTATING",
        approvedCommands: [],
        allowedMcpTools: [],
      });
      expect(registry.lookupByRunId("run-mu-1")?.record.status).toEqual("RUNNING");
      // Mutation launch always watches completion so it can stop heartbeats
      // and advance the durable lease to SETTLING even without a caller callback.
      expect(fake.handlers).toHaveLength(1);
    } finally {
      releaseLease(dir, "unknown");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects expired lease before spawn", async () => {
    const fake = fakeClient("run-mu-x");
    const lease = makeLease({ expiresAt: iso(-1_000) as unknown as MutationLease["expiresAt"] });
    const delegation = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease(), undefined, WRITE_SET).turns[1]!.delegation;
    await expect(executeMutation(lease, delegation, fake.client, {
      ensureBridges: () => {},
    })).rejects.toThrow("invalid mutation lease");
    expect(fake.spawned).toHaveLength(0);
  });

  it("rejects lease/assignment mismatch", async () => {
    const fake = fakeClient("run-mu-y");
    const lease = makeLease();
    const delegation = dispatchMutation(ASSIGNMENT, CONTEXT, lease, undefined, WRITE_SET).turns[1]!.delegation;
    const other = { ...delegation, assignmentId: "other" as AssignmentId };
    await expect(executeMutation(lease, other, fake.client, { ensureBridges: () => {} })).rejects.toThrow(
      "lease assignment mismatch",
    );
  });
});

// ─── AUTHORITY_READY gate (P1: approval enforced) ──────────────────────────

describe("acquireAuthority / AUTHORITY_READY gate", () => {
  const snap = (
    dirtySignature: string,
    dirty: { staged?: string[]; modified?: string[]; untracked?: string[] } = {},
  ): WorkspaceSnapshot => ({
    revision: null,
    staged: dirty.staged ?? [],
    modified: dirty.modified ?? [],
    untracked: dirty.untracked ?? [],
    dirtySignature,
    contentHashes: {},
  });

  it("ACQUIRED-only launch rejected: acquisition turn required first", async () => {
    const fake = fakeClient("run-mu-acq");
    const lease = makeLease({ phase: "ACQUIRED" });
    const delegation = dispatchMutation(ASSIGNMENT, CONTEXT, lease, undefined, WRITE_SET).turns[1]!.delegation;
    await expect(
      executeMutation(lease, delegation, fake.client, { ensureBridges: () => {} }),
    ).rejects.toThrow("acquisition turn required first");
    await expect(
      executeMutation(lease, delegation, fake.client, { ensureBridges: () => {} }),
    ).rejects.toThrow(AuthorityNotReadyError);
    expect(fake.spawned).toHaveLength(0);
  });

  it("detects dirty collisions when the acquired write-set uses absolute paths", () => {
    const result = acquireAuthority({
      root: "/tmp/authority-test",
      leaseId: "lease-x",
      sessionId: "sess-001",
      goalId: "goal-001",
      assignmentId: "asgn-001" as AssignmentId,
      planEpoch: 0,
      currentSnapshot: snap("sig-dirty", { modified: ["src/auth.ts"] }),
      actualWriteSet: ["/tmp/authority-test/src/auth.ts"],
      workspaceRoot: "/tmp/authority-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("CONFLICT");
      expect(result.reason).toContain("modified:src/auth.ts");
    }
  });

  it("conflict without approval rejected", () => {
    const result = acquireAuthority({
      root: "/tmp/authority-test",
      leaseId: "lease-x",
      sessionId: "sess-001",
      goalId: "goal-001",
      assignmentId: "asgn-001" as AssignmentId,
      planEpoch: 0,
      currentSnapshot: snap("sig-dirty", { modified: ["src/auth.ts"] }),
      actualWriteSet: ["src/auth.ts"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("CONFLICT");
      expect(result.reason).toContain("require approval");
    }
  });

  it("approval STALE rejected", () => {
    const base = snap("sig-a");
    const approval = createApproval({
      goalId: "goal-001",
      planEpoch: 0,
      assignmentId: "asgn-001",
      snapshot: base,
      intendedWriteSet: ["src/auth.ts"],
    });
    const drifted = snap("sig-b", { modified: ["src/auth.ts"] });
    const result = acquireAuthority({
      root: "/tmp/authority-test",
      leaseId: "lease-x",
      sessionId: "sess-001",
      goalId: "goal-001",
      assignmentId: "asgn-001" as AssignmentId,
      planEpoch: 0,
      currentSnapshot: drifted,
      actualWriteSet: ["src/auth.ts"],
      approval,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("STALE");
      expect(result.reason).toContain("dirtySignature");
    }
  });

  it("conflict-with-valid-approval advances to AUTHORITY_READY and launches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launcher-authority-"));
    try {
      const acquired = acquireLease({
        goalId: "goal-001",
        assignmentId: "asgn-001",
        sessionId: "sess-mu",
        root: dir,
        writeSet: ["src/auth.ts"],
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;
      // Live dirt collides with part of the intended set; the actual
      // write-set stays clean and the approval covers the wider intent.
      const current = snap("sig-1", { modified: ["src/b.ts"] });
      const approval = createApproval({
        goalId: "goal-001",
        planEpoch: 0,
        assignmentId: "asgn-001",
        snapshot: current,
        intendedWriteSet: ["src/auth.ts", "src/b.ts"],
      });
      expect(approval.conflicts).toHaveLength(1);
      const gated = acquireAuthority({
        root: dir,
        leaseId: acquired.lease.leaseId,
        sessionId: "sess-mu",
        goalId: "goal-001",
        assignmentId: "asgn-001" as AssignmentId,
        planEpoch: 0,
        currentSnapshot: current,
        actualWriteSet: ["src/auth.ts"],
        approval,
      });
      expect(gated.ok).toBe(true);
      if (!gated.ok) return;
      expect(gated.via).toBe("approval");
      expect(gated.lease.phase).toBe("AUTHORITY_READY");
      expect(typeof gated.receiptRef).toBe("string");
      expect(gated.lease.authorityReceiptRef).toBe(gated.receiptRef);
      // Advance persisted to disk with the receipt ref.
      const onDisk = JSON.parse(
        readFileSync(join(gated.lease.canonicalWorkspaceRoot, ".keystone-lease.json"), "utf-8"),
      ) as { phase: string; authorityReceiptRef: string };
      expect(onDisk.phase).toBe("AUTHORITY_READY");
      expect(onDisk.authorityReceiptRef).toBe(gated.receiptRef);
      // ...and the advanced lease launches through executeMutation's gate.
      const absAuth = acquired.lease.allowedCanonicalPaths.find((p) => p.endsWith("src/auth.ts"));
      expect(absAuth).toBeDefined();
      const delegation = dispatchMutation(
        ASSIGNMENT,
        CONTEXT,
        gated.lease,
        undefined,
        { writeSet: [absAuth as string] },
      ).turns[1]!.delegation;
      const fake = fakeClient("run-mu-auth");
      const { runId } = await executeMutation(gated.lease, delegation, fake.client, {
        ensureBridges: () => {},
      });
      expect(runId).toBe("run-mu-auth");
      expect(fake.spawned).toHaveLength(1);
      // A gated lease that fails the gate still rejects at the live callsite.
      const staleApproval = { ...approval, planEpoch: 99 };
      await expect(
        executeMutation(acquired.lease, delegation, fake.client, {
          ensureBridges: () => {},
          authority: {
            goalId: "goal-001",
            planEpoch: 0,
            currentSnapshot: current,
            writeSet: ["src/auth.ts"],
            approval: staleApproval,
          },
        }),
      ).rejects.toThrow(AuthorityGateError);
    } finally {
      releaseLease(dir, "unknown");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── pi-subagents bridge (Task 7) ───────────────────────────────────────────

describe("subagents-bridge", () => {
  const ceilKey = Symbol.for(CAPABILITY_CEILING_REGISTRY_KEY);
  const reqKey = Symbol.for(REQUIRED_CHILD_EXTENSIONS_REGISTRY_KEY);
  const root = globalThis as Record<PropertyKey, unknown>;
  let savedCeil: unknown;
  let savedReq: unknown;

  beforeEach(() => {
    savedCeil = root[ceilKey];
    savedReq = root[reqKey];
    root[ceilKey] = new Map();
    root[reqKey] = { version: 1, bySession: new Map() };
  });

  afterEach(() => {
    resetSessionBridges("sess-b1");
    resetSessionBridges("sess-b2");
    if (savedCeil === undefined) delete root[ceilKey]; else root[ceilKey] = savedCeil;
    if (savedReq === undefined) delete root[reqKey]; else root[reqKey] = savedReq;
  });

  it("registers ceiling allowlist + guard path once per session", () => {
    const first = ensureKeystoneSessionBridges("sess-b1");
    expect(first.fresh).toBe(true);
    const ceilings = root[ceilKey] as Map<string, Map<symbol, { source: string; ceiling: { allowedTools?: string[] } }>>;
    const session = ceilings.get("sess-b1");
    expect(session?.size).toEqual(1);
    const record = [...session!.values()][0]!;
    expect(record.source).toEqual("keystone");
    expect(record.ceiling.allowedTools).toEqual(["find", "glob", "grep", "ls", "read"]);
    const required = root[reqKey] as { bySession: Map<string, readonly { id: string; path: string }[]> };
    expect(required.bySession.get("sess-b1")).toEqual([{ id: "keystone-child-guard", path: defaultChildGuardPath() }]);
    const second = ensureKeystoneSessionBridges("sess-b1");
    expect(second.fresh).toBe(false);
    expect(ceilings.get("sess-b1")?.size).toEqual(1);
  });

  it("dispose-first replaces keystone's OWN prior snapshot", () => {
    const first = ensureKeystoneSessionBridges("sess-b2");
    expect(first.fresh).toBe(true);
    first.ceiling.dispose();
    const required = root[reqKey] as { bySession: Map<string, unknown> };
    expect(required.bySession.has("sess-b2")).toBe(false);
    const res = ensureKeystoneSessionBridges("sess-b2");
    expect(res.fresh).toBe(true);
    expect((required.bySession.get("sess-b2") as { id: string }[])[0]?.id).toEqual("keystone-child-guard");
  });

  it("refuses to clobber a foreign owner's required snapshot", () => {
    const required = root[reqKey] as { bySession: Map<string, unknown> };
    required.bySession.set("sess-b2", [{ id: "foreign-guard", path: "/foreign/guard.ts" }]);
    expect(() => ensureKeystoneSessionBridges("sess-b2")).toThrow(/another extension|clobber/);
    expect(required.bySession.get("sess-b2")).toEqual([{ id: "foreign-guard", path: "/foreign/guard.ts" }]);
  });

  it("reset removes ONLY keystone's own ceiling token, preserving foreign tokens", () => {
    ensureKeystoneSessionBridges("sess-b1");
    const ceilings = root[ceilKey] as Map<string, Map<symbol, unknown>>;
    const foreign = Symbol("foreign");
    ceilings.get("sess-b1")!.set(foreign, { source: "foreign" });
    resetSessionBridges("sess-b1");
    expect(ceilings.get("sess-b1")?.size).toEqual(1);
    expect(ceilings.get("sess-b1")?.has(foreign)).toBe(true);
    ceilings.delete("sess-b1");
  });

  it("reset preserves a foreign required snapshot (identity check)", () => {
    const required = root[reqKey] as { bySession: Map<string, unknown> };
    const foreignSnap = [{ id: "foreign-guard", path: "/foreign/guard.ts" }];
    required.bySession.set("sess-b9", foreignSnap);
    resetSessionBridges("sess-b9");
    expect(required.bySession.get("sess-b9")).toBe(foreignSnap);
    required.bySession.delete("sess-b9");
  });

  it("fails loud on malformed ceiling tools", () => {
    expect(() => ensureKeystoneSessionBridges("sess-bad", { readerAllowedTools: [""] })).toThrow(/tool/);
    expect(() => ensureKeystoneSessionBridges("sess-bad", { readerAllowedTools: ["has space"] })).toThrow(/malformed/);
    const ceilings = root[ceilKey] as Map<string, unknown>;
    expect(ceilings.has("sess-bad")).toBe(false);
  });

  it("fails loud on non-absolute guard path", () => {
    expect(() => ensureKeystoneSessionBridges("sess-bad2", { childGuardPath: "relative/guard.ts" })).toThrow(/absolute/);
  });

  it("creates compatible lazy registries when pi-subagents has not touched them yet", () => {
    delete root[ceilKey];
    delete root[reqKey];
    const result = ensureKeystoneSessionBridges("sess-gone");
    expect(result.fresh).toBe(true);
    expect(root[ceilKey]).toBeInstanceOf(Map);
    expect((root[reqKey] as { version: number; bySession: Map<string, unknown> }).version).toBe(1);
    resetSessionBridges("sess-gone");
  });

  it("defaultChildGuardPath is absolute and names the guard file", () => {
    const p = defaultChildGuardPath();
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("child/keystone-child-guard.ts")).toBe(true);
  });

  it("setSpawnCeiling switches reader->mutation and restoreReaderCeiling resets", () => {
    ensureKeystoneSessionBridges("sess-b1");
    const toolsOf = () => {
      const ceilings = root[ceilKey] as Map<string, Map<symbol, { source: string; ceiling: { allowedTools?: string[] } }>>;
      return [...ceilings.get("sess-b1")!.values()].map((v) => v.ceiling.allowedTools);
    };
    expect(toolsOf()[0]).toEqual(["find", "glob", "grep", "ls", "read"]);
    setSpawnCeiling("sess-b1", "mutation");
    expect(toolsOf()[0]).toEqual(["edit", "find", "glob", "grep", "ls", "read", "write"]);
    restoreReaderCeiling("sess-b1");
    expect(toolsOf()[0]).toEqual(["find", "glob", "grep", "ls", "read"]);
  });

  it("setSpawnCeiling auto-ensures an unbridged session with the mutation ceiling", () => {
    setSpawnCeiling("sess-b2", "mutation");
    const ceilings = root[ceilKey] as Map<string, Map<symbol, { source: string; ceiling: { allowedTools?: string[] } }>>;
    const record = [...ceilings.get("sess-b2")!.values()][0]!;
    expect(record.source).toEqual("keystone");
    expect(record.ceiling.allowedTools).toEqual(["edit", "find", "glob", "grep", "ls", "read", "write"]);
  });

  it("setSpawnCeiling rejects unknown mode without touching the registry", () => {
    ensureKeystoneSessionBridges("sess-b1");
    expect(() => setSpawnCeiling("sess-b1", "admin" as never)).toThrow(/mode/);
    const ceilings = root[ceilKey] as Map<string, Map<symbol, { source: string; ceiling: { allowedTools?: string[] } }>>;
    expect([...ceilings.get("sess-b1")!.values()][0]!.ceiling.allowedTools).toEqual([
      "find",
      "glob",
      "grep",
      "ls",
      "read",
    ]);
  });
});

// ─── Orchestrated frontier execution (prod wiring) ──────────────────────────

describe("runExecutionFrontier", () => {
  async function setup() {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { GoalStore } = await import("../../src/store/goal-store.js");
    const { createGoalRecord } = await import("../../src/domain/goal-record.js");
    const { startGoal, dispatchEvent } = await import("../../src/runtime/lifecycle.js");
    const { runExecutionFrontier } = await import("../../src/execution/read-only-launcher.js");
    const dir = mkdtempSync(join(tmpdir(), "keystone-frontier-"));
    const store = new GoalStore(dir);
    const log: never[] = [];
    const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` as GoalId;
    const rev = {
      snapshotId: "s" as never, observedAt: new Date().toISOString() as never,
      graphRevision: 1, dirtySignature: "", capabilityDigest: "",
    };
    const ws = { requestedRoot: "/tmp", canonicalRoot: "/tmp", projectKey: "k", vcs: "git" } as never;
    startGoal(store, goalId, createGoalRecord(goalId, "t", ws, rev), log);
    // PREPARING → READY (no fence: fencing inactive).
    const ART = "art" as ArtifactRef;
    for (const job of ["baseline", "plan"] as const) {
      dispatchEvent(store, goalId, {
        type: "PreparationProgress", job, planEpoch: 0, attemptId: `a-${job}`,
        basedOnRevision: rev as never, status: "SUCCEEDED", driverFence: 0, artifactRef: ART,
      }, log);
    }
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted", reportRef: ART, planEpoch: 0,
      provisionalPlanRef: ART, basedOnRevision: rev as never, decision: "ACCEPT_PLAN_BASIS",
    }, log);
    dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ART }, log);
    return { store, log, goalId, ART, runExecutionFrontier };
  }

  function sched(ids: string[], deps: Record<string, string[]> = {}) {
    return ids.map((id) => ({
      assignment: {
        id: id as never, role: "implementer" as const, targetFiles: [],
        acceptanceCriteria: ["done"], contractRef: "c" as never,
      },
      dependsOn: (deps[id] ?? []) as never[],
    }));
  }

  function envelope(id: string) {
    return {
      assignmentId: id as never, runId: `run-${id}`, sessionId: "s",
      findings: [], evidenceRefs: [], status: "DELIVERED" as const,
      createdAt: new Date().toISOString() as never,
    };
  }

  it("dispatches the full DAG, runs the schedule, and reaches VERIFYING on success", async () => {
    const { store, log, goalId, ART, runExecutionFrontier } = await setup();
    const scheduled = sched(["fa-1", "fa-2"]);
    const out = await runExecutionFrontier(store, goalId, scheduled, async (a) => envelope(a.id as string) as never, {
      contractVersion: 1,
      executionPlanRef: ART,
      reportRefFor: (assignmentId, report) => `${(report as unknown as { runId: string }).runId}-ref` as ArtifactRef,
      receiptLog: log as never,
    });
    expect(out.ok).toBe(true);
    const record = store.get(goalId)!;
    expect(record.state).toBe("VERIFYING");
    expect(record.executionPlan!.assignments).toHaveLength(2);
    expect(record.assignmentStates["fa-1" as never]).toBe("COMPLETED");
    // RUNNING runs opened at the dispatch boundary are closed with refs.
    expect(record.activeRuns["fa-1" as never]?.status).toBe("SUCCEEDED");
  });

  it("invalid DAG blocks the goal instead of hanging in EXECUTING", async () => {
    const { store, log, goalId, ART, runExecutionFrontier } = await setup();
    const dupe = sched(["fd-1", "fd-1"]);
    const out = await runExecutionFrontier(store, goalId, dupe, async (a) => envelope(a.id as string) as never, {
      contractVersion: 1,
      executionPlanRef: ART,
      reportRefFor: () => "r" as ArtifactRef,
      receiptLog: log as never,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors?.[0]?.kind).toBe("DUPLICATE_ID");
    expect(store.get(goalId)!.state).toBe("BLOCKED");
  });

  it("keeps executeSchedule ok:false semantics: failure dispatches AssignmentFailed, goal advances on terminal frontier", async () => {
    const { store, log, goalId, ART, runExecutionFrontier } = await setup();
    const scheduled = sched(["fb-1", "fb-2"]);
    const out = await runExecutionFrontier(store, goalId, scheduled, async (a) => {
      if ((a.id as string) === "fb-1") throw new Error("child blew up");
      return envelope(a.id as string) as never;
    }, {
      contractVersion: 1,
      executionPlanRef: ART,
      reportRefFor: () => "r" as ArtifactRef,
      errorRefFor: () => "e" as ArtifactRef,
      receiptLog: log as never,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failures).toHaveLength(1);
    const record = store.get(goalId)!;
    expect(record.assignmentStates["fb-1" as never]).toBe("FAILED");
    expect(record.assignmentStates["fb-2" as never]).toBe("COMPLETED");
    expect(record.state).toBe("VERIFYING");
  });

  it("continues past a per-result dispatch throw: sibling still dispatched, ok:false, failure recorded (no wedge)", async () => {
    // First per-result dispatch throws (same catch path as a stale-fence
    // FenceError); the loop must CONTINUE so the sibling still dispatches
    // and the throw is recorded as a failure instead of wedging the goal
    // with a silent ACQUIRED slot.
    const { store, log, goalId, ART, runExecutionFrontier } = await setup();
    const scheduled = sched(["fc-1", "fc-2"]);
    const out = await runExecutionFrontier(store, goalId, scheduled, async (a) => envelope(a.id as string) as never, {
      contractVersion: 1,
      executionPlanRef: ART,
      reportRefFor: (assignmentId) => {
        if ((assignmentId as string) === "fc-1") throw new Error("stale fence");
        return "r-ok" as ArtifactRef;
      },
      receiptLog: log as never,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0].assignmentId).toBe("fc-1");
    }
    const record = store.get(goalId)!;
    expect(record.assignmentStates["fc-2" as never]).toBe("COMPLETED");
    expect(record.assignmentStates["fc-1" as never]).toBe("ACQUIRED");
    expect(record.state).toBe("EXECUTING");
  });
});
