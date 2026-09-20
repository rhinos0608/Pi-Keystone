// Integration test: Phase 6 — context compiler, execution schedulers, worker guard
// Tests: compile context for each role, verify view shape;
// dispatch read-only + mutation assignments through scheduler.

import { describe, it, expect, beforeEach, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  GoalRecord,
  GoalId,
  RevisionRef,
  WorkspaceIdentity,
  AssignmentId,
  MutationLease,
} from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { createKeystone } from "../../src/index.js";

// ─── Context compiler GoalStore (context/types.ts interface) ────────────────
import type {
  ContextGoalStore,
  ContractRef,
  Finding,
  EntityRef,
  VerificationResult,
} from "../../src/context/types.js";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeGoalId(): GoalId {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as GoalId;
}

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/test-project",
  canonicalRoot: "/tmp/test-project",
  projectKey: "abc123",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-001" as import("../../src/domain/types.js").SnapshotId,
  observedAt: new Date().toISOString() as import("../../src/domain/types.js").ISO8601,
  gitHead: "abc123",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "clean",
  capabilityDigest: "full",
};

const ARTIFACT = "artifact-001" as import("../../src/domain/types.js").ArtifactRef;

// Minimal context store for compileContext
const EMPTY_CONTEXT_STORE: ContextGoalStore = {
  contracts: [],
  findings: [],
  entities: [],
};

function makeContextStore(overrides: Partial<ContextGoalStore> = {}): ContextGoalStore {
  return { ...EMPTY_CONTEXT_STORE, ...overrides };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function completePreparation(store: GoalStore, goalId: GoalId, log: any[]) {
  const REVISION_ = REVISION;
  store.update(goalId, {
    type: "PreparationProgress",
    job: "baseline",
    planEpoch: 0,
    attemptId: "att-b-1",
    basedOnRevision: REVISION_,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: ARTIFACT,
  });
  store.update(goalId, {
    type: "PreparationProgress",
    job: "plan",
    planEpoch: 0,
    attemptId: "att-p-1",
    basedOnRevision: REVISION_,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: ARTIFACT,
  });
}

function advanceToReady(store: GoalStore, goalId: GoalId) {
  completePreparation(store, goalId, []);
  store.update(goalId, {
    type: "ReconciliationCompleted",
    reportRef: ARTIFACT,
    planEpoch: 0,
    provisionalPlanRef: ARTIFACT,
    basedOnRevision: REVISION,
    decision: "ACCEPT_PLAN_BASIS",
  });
  store.update(goalId, {
    type: "ContractFrozen",
    contractVersion: 1,
    contractRef: ARTIFACT,
  });
}

function advanceToExecuting(store: GoalStore, goalId: GoalId) {
  advanceToReady(store, goalId);
  store.update(goalId, {
    type: "ExecutionStarted",
    contractVersion: 1,
    executionPlanRef: ARTIFACT,
    driverFence: 0,
  });
}

// ─── Context compiler integration tests ─────────────────────────────────────

describe("Phase 6: Context compiler integration", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-ctx-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("compiles planner context with contracts and entities", () => {
    const contracts: ContractRef[] = [
      { id: "c-1", kind: "goal", storeKey: "goal-1" },
      { id: "c-2", kind: "plan", storeKey: "plan-1" },
      { id: "c-3", kind: "assignment", storeKey: "asgn-1" },
    ];
    const entities: EntityRef[] = [
      { id: "e-1", kind: "file", label: "src/index.ts", tokenCost: 50 },
      { id: "e-2", kind: "module", label: "auth", tokenCost: 80 },
    ];
    const ctx = ks.compileContext("planner", makeContextStore({ contracts, entities }));

    expect(ctx.role).toBe("planner");
    expect(ctx.contractRefs.length).toBe(2); // planner sees goal + plan only
    expect(ctx.contractRefs.some((c) => c.kind === "goal")).toBe(true);
    expect(ctx.contractRefs.some((c) => c.kind === "plan")).toBe(true);
    expect(ctx.contractRefs.some((c) => c.kind === "assignment")).toBe(false);
    expect(ctx.entities.length).toBe(2); // planner sees all entities
    expect(ctx.tools.length).toBeGreaterThan(0);
  });

  it("compiles worker context with assignment and no findings", () => {
    const assignment = {
      id: "asgn-1",
      goalId: "g-1",
      workerRole: "implementer",
      scope: [
        { id: "e-1", kind: "file", label: "src/auth.ts", tokenCost: 50 },
      ],
      instructions: "Implement auth module",
      tokenCost: 200,
    };
    const findings: Finding[] = [
      { id: "f-1", severity: "error", message: "Missing type export", source: "typecheck", tokenCost: 30 },
    ];
    const ctx = ks.compileContext("worker", makeContextStore({ assignment, findings }));

    expect(ctx.role).toBe("worker");
    expect(ctx.assignment).toEqual(assignment); // worker sees its assignment
    expect(ctx.findings.length).toBe(0); // worker doesn't get global findings
    expect(ctx.entities.length).toBe(1); // worker sees scope from assignment
    expect(ctx.entities[0].id).toBe("e-1");
  });

  it("compiles reviewer context with findings and verification results", () => {
    const findings: Finding[] = [
      { id: "f-1", severity: "warn", message: "Unused import", source: "lint", tokenCost: 20 },
    ];
    const verificationResults: VerificationResult[] = [
      { contractId: "c-1", passed: true, details: "All tests pass", tokenCost: 40 },
    ];
    const ctx = ks.compileContext("reviewer", makeContextStore({ findings, verificationResults }));

    expect(ctx.role).toBe("reviewer");
    expect(ctx.findings.length).toBe(1);
    expect(ctx.findings[0].id).toBe("f-1");
    expect(ctx.verificationResults.length).toBe(1);
    expect(ctx.verificationResults[0].passed).toBe(true);
    expect(ctx.assignment).toBeNull(); // reviewer doesn't see assignment
    // reviewer gets read-only tools only
    expect(ctx.tools.some((t) => t.name === "read")).toBe(true);
    expect(ctx.tools.some((t) => t.name === "write")).toBe(false);
  });

  it("compiles orchestrator context with everything", () => {
    const contracts: ContractRef[] = [
      { id: "c-1", kind: "goal", storeKey: "g-1" },
      { id: "c-2", kind: "plan", storeKey: "p-1" },
      { id: "c-3", kind: "assignment", storeKey: "a-1" },
      { id: "c-4", kind: "verification", storeKey: "v-1" },
    ];
    const findings: Finding[] = [
      { id: "f-1", severity: "info", message: "All clear", source: "review", tokenCost: 10 },
    ];
    const verificationResults: VerificationResult[] = [
      { contractId: "c-1", passed: true, details: "verified", tokenCost: 30 },
    ];
    const ctx = ks.compileContext("orchestrator", makeContextStore({ contracts, findings, verificationResults }));

    expect(ctx.role).toBe("orchestrator");
    // orchestrator sees all contract kinds
    expect(ctx.contractRefs.length).toBe(4);
    expect(ctx.findings.length).toBe(1);
    expect(ctx.verificationResults.length).toBe(1);
    // orchestrator gets mutation tools
    expect(ctx.tools.some((t) => t.name === "write")).toBe(true);
    expect(ctx.tools.some((t) => t.name === "bash")).toBe(true);
  });

  it("budget is enforced — items exceeding budget are excluded", () => {
    const expensiveEntities: EntityRef[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e-${i}`,
      kind: "file",
      label: `file-${i}.ts`,
      tokenCost: 500,
    }));
    const ctx = ks.compileContext("planner", makeContextStore({ entities: expensiveEntities }), undefined, {
      budgetLimit: 1000,
    });

    expect(ctx.budget.hardLimit).toBe(1000);
    expect(ctx.budget.consumed).toBeLessThanOrEqual(1000);
    expect(ctx.entities.length).toBeLessThan(20); // not all fit
  });

  it("view shape is frozen (immutable)", () => {
    const ctx = ks.compileContext("planner", makeContextStore());
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.tools)).toBe(true);
    expect(Object.isFrozen(ctx.contractRefs)).toBe(true);
    expect(Object.isFrozen(ctx.entities)).toBe(true);
    expect(Object.isFrozen(ctx.findings)).toBe(true);
  });
});

// ─── Role projection integration tests ──────────────────────────────────────

describe("Phase 6: Role projection integration", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-proj-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("user projection shows minimal fields", () => {
    const id = makeGoalId();
    const record = createGoalRecord(id, "build feature", WORKSPACE, REVISION);
    ks.goal.create({ goalId: id, userTask: "build feature", workspace: WORKSPACE, startRevision: REVISION });

    const goal = ks.goal.get(id)!;
    const proj = ks.projectGoalStoreView(goal, "user");
    expect(proj.kind).toBe("user");
    expect(proj.goalId).toBe(id);
    expect(proj.userTask).toBe("build feature");
    expect(proj.state).toBe("PREPARING");
    // user doesn't see internal fields
    expect("planEpoch" in proj).toBe(false);
    expect("findingLedgerRef" in proj).toBe(false);
  });

  it("executor projection shows operational fields", () => {
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "build feature", workspace: WORKSPACE, startRevision: REVISION });
    advanceToReady(ks.store, id);

    const goal = ks.goal.get(id)!;
    const proj = ks.projectGoalStoreView(goal, "executor");
    expect(proj.kind).toBe("executor");
    expect(proj.planEpoch).toBeDefined();
    expect(proj.contractVersion).toBeDefined();
    expect(proj.driverFenceCounter).toBeDefined();
    expect(proj.recoveryRequired).toBeDefined();
  });

  it("reviewer projection shows review-cycle fields", () => {
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "build feature", workspace: WORKSPACE, startRevision: REVISION });

    const goal = ks.goal.get(id)!;
    const proj = ks.projectGoalStoreView(goal, "reviewer");
    expect(proj.kind).toBe("reviewer");
    expect(proj.reviewCycles).toBeDefined();
    expect(proj.repairCycles).toBeDefined();
    expect(proj.findingLedgerRef).toBeDefined();
  });

  it("auditor projection includes full record", () => {
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "build feature", workspace: WORKSPACE, startRevision: REVISION });

    const goal = ks.goal.get(id)!;
    const proj = ks.projectGoalStoreView(goal, "auditor");
    expect(proj.kind).toBe("auditor");
    // auditor has all GoalRecord fields
    expect("goalId" in proj).toBe(true);
    expect("workspace" in proj).toBe(true);
    expect("preparation" in proj).toBe(true);
  });
});

// ─── Execution scheduler integration tests ──────────────────────────────────

describe("Phase 6: Execution scheduler — read-only dispatch", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-ro-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("dispatches a read-only assignment", () => {
    const assignmentId = "asgn-ro-1" as AssignmentId;
    const contextView = {
      goalId: "g-1",
      task: "Verify auth module exports",
      workspace: "/tmp/test-project",
      targetFiles: ["src/auth.ts"],
    };

    const result = ks.dispatchReadOnly({ id: assignmentId, description: "verify auth", targetFiles: ["src/auth.ts"] }, contextView);

    expect(result.delegation.assignmentId).toBe(assignmentId);
    expect(result.delegation.task).toBe("verify auth");
    expect(result.delegation.toolPolicy.kind).toBe("read-only");
    expect(result.delegation.contextView.goalId).toBe("g-1");
    expect(result.report).toBeNull(); // not yet completed
  });

  it("read-only policy denies mutation tools", () => {
    const decision = ks.enforceToolPolicy("write", { kind: "read-only" });
    expect(decision.allowed).toBe(false);

    const readDecision = ks.enforceToolPolicy("read", { kind: "read-only" });
    expect(readDecision.allowed).toBe(true);
  });

  it("mutation policy with permit allows mutation tools", () => {
    const decision = ks.enforceToolPolicy(
      "write",
      {
        kind: "mutation",
        permit: { leaseId: "lease-1", fencingToken: 1 },
      },
      { leaseId: "lease-1", fencingToken: 1 },
    );
    expect(decision.allowed).toBe(true);
  });

  it("mutation policy rejects permit bound to another lease", () => {
    const decision = ks.enforceToolPolicy(
      "write",
      {
        kind: "mutation",
        permit: { leaseId: "lease-other", fencingToken: 1 },
      },
      { leaseId: "lease-1", fencingToken: 1 },
    );
    expect(decision.allowed).toBe(false);
  });

  it("mutation policy without permit denies mutation tools", () => {
    const decision = ks.enforceToolPolicy("write", { kind: "mutation" });
    expect(decision.allowed).toBe(false);
  });
});

// ─── Execution scheduler — mutation dispatch ────────────────────────────────

describe("Phase 6: Execution scheduler — mutation dispatch", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-mut-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("dispatches a mutation assignment with valid lease", () => {
    const id = makeGoalId();
    ks.goal.create({ goalId: id, userTask: "fix bug", workspace: WORKSPACE, startRevision: REVISION });
    advanceToExecuting(ks.store, id);

    const assignmentId = "asgn-mut-1" as AssignmentId;
    const lease: MutationLease = {
      leaseId: "lease-1",
      fencingToken: 1,
      assignmentId,
      sessionId: "session-1",
      workerProcessIdentity: "pid-1",
      canonicalWorkspaceRoot: "/tmp/test-project",
      allowedCanonicalPaths: ["src/"],
      baseDirtySignature: "clean",
      phase: "ACQUIRED",
      acquiredAt: new Date().toISOString() as import("../../src/domain/types.js").ISO8601,
      heartbeatAt: new Date().toISOString() as import("../../src/domain/types.js").ISO8601,
      expiresAt: new Date(Date.now() + 60_000).toISOString() as import("../../src/domain/types.js").ISO8601,
    };

    const contextView = {
      goalId: id,
      task: "Fix authentication bug",
      workspace: "/tmp/test-project",
      targetFiles: ["src/auth.ts"],
    };

    const result = ks.dispatchMutation(
      { id: assignmentId, description: "fix auth", targetFiles: ["src/auth.ts"] },
      contextView,
      lease,
      undefined,
      { writeSet: ["src/"] },
    );

    // Two-phase protocol: acquisition then mutation
    expect(result.turns.length).toBe(2);
    expect(result.turns[0].phase).toBe("acquisition");
    expect(result.turns[0].delegation.toolPolicy.kind).toBe("read-only");
    expect(result.turns[1].phase).toBe("mutation");
    expect(result.turns[1].delegation.toolPolicy.kind).toBe("mutation");
    const mutationPolicy = result.turns[1].delegation.toolPolicy as {
      permit?: { leaseId: string; fencingToken: number };
    };
    expect(mutationPolicy.permit?.leaseId).toBe("lease-1");
    expect(result.lease.leaseId).toBe("lease-1");
    expect(result.report).toBeNull();
  });

  it("rejects mutation dispatch with expired lease", () => {
    const assignmentId = "asgn-mut-2" as AssignmentId;
    const expiredLease: MutationLease = {
      leaseId: "lease-expired",
      fencingToken: 1,
      assignmentId,
      sessionId: "session-1",
      workerProcessIdentity: "pid-1",
      canonicalWorkspaceRoot: "/tmp/test-project",
      allowedCanonicalPaths: ["src/"],
      baseDirtySignature: "clean",
      phase: "ACQUIRED",
      acquiredAt: "2020-01-01T00:00:00.000Z" as import("../../src/domain/types.js").ISO8601,
      heartbeatAt: "2020-01-01T00:00:00.000Z" as import("../../src/domain/types.js").ISO8601,
      expiresAt: "2020-01-01T00:00:01.000Z" as import("../../src/domain/types.js").ISO8601,
    };

    const contextView = {
      goalId: "g-1",
      task: "Fix bug",
      workspace: "/tmp/test-project",
      targetFiles: ["src/auth.ts"],
    };

    expect(() =>
      ks.dispatchMutation(
        { id: assignmentId, description: "fix auth", targetFiles: ["src/auth.ts"] },
        contextView,
        expiredLease,
        undefined,
        { writeSet: ["src/"] },
      ),
    ).toThrow("invalid mutation lease");
  });

  it("acquireLease creates a lease and checkLease validates it", () => {
    const root = mkdtempSync(join(tmpdir(), "keystone-p6-lease-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const result = ks.acquireLease({
      goalId: "g-1",
      assignmentId: "asgn-p6-1" as AssignmentId,
      sessionId: "sess-p6-1",
      root,
      writeSet: ["src/a.ts"],
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      const check = ks.checkLease(root);
      expect(check).not.toBeNull();
      if (check !== null && typeof check === "object" && "conflict" in check) {
        throw new Error(`unexpected lease conflict: ${check.reason}`);
      }
      expect(check!.leaseId).toBe(result.lease.leaseId);

      // Release it
      const released = ks.releaseLease(root, result.lease.leaseId);
      expect(released).toBe(true);
      expect(ks.checkLease(root)).toBeNull();
    }
  });

  it("acquireLease denies duplicate lease on same root", () => {
    const root = mkdtempSync(join(tmpdir(), "keystone-p6-dup-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const r1 = ks.acquireLease({
      goalId: "g-1",
      assignmentId: "asgn-p6-d1" as AssignmentId,
      sessionId: "sess-p6-d1",
      root,
      writeSet: ["src/a.ts"],
    });
    expect(r1.acquired).toBe(true);
    const r2 = ks.acquireLease({
      goalId: "g-2",
      assignmentId: "asgn-p6-d2" as AssignmentId,
      sessionId: "sess-p6-d2",
      root,
      writeSet: ["src/a.ts"],
    });
    expect(r2.acquired).toBe(false);
  });
});

// ─── Worker guard integration ───────────────────────────────────────────────

describe("Phase 6: Worker guard integration", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-guard-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("registers a read-only guard and denies mutation tools", () => {
    const guard = ks.registerWorkerGuard({ kind: "read-only" }, { sessionId: "session-1" });

    const allowResult = guard.check({
      toolCallId: "tc-1",
      toolName: "read",
      sessionId: "session-1",
    });
    expect(allowResult.decision).toBe("allow");

    const denyResult = guard.check({
      toolCallId: "tc-2",
      toolName: "write",
      sessionId: "session-1",
    });
    expect(denyResult.decision).toBe("deny");
    if (denyResult.decision === "deny") {
      expect(denyResult.reason).toContain("denied");
    }
  });

  it("denies cross-session tool calls", () => {
    const guard = ks.registerWorkerGuard({ kind: "read-only" }, { sessionId: "session-1" });

    const result = guard.check({
      toolCallId: "tc-1",
      toolName: "read",
      sessionId: "session-wrong",
    });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toContain("session mismatch");
    }
  });

  it("issues authority receipt with correct role and tools", () => {
    const receipt = ks.issueAuthority("reviewer");
    expect(receipt.role).toBe("reviewer");
    expect(receipt.allowedTools).toContain("read");
    expect(receipt.allowedTools).not.toContain("write");
    expect(receipt.issuedAt).toBeTruthy();
  });

  it("mutation guard allows tools with permit token", () => {
    const guard = ks.registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
      {
        sessionId: "session-mut",
        lease: { leaseId: "lease-1", root: "/tmp", fencingToken: 1, expiresAt: Date.now() + 60_000 },
      },
    );

    const result = guard.check({
      toolCallId: "tc-1",
      toolName: "write",
      sessionId: "session-mut",
    });
    // Worker guard delegates to tool-policy; mutation with permit = allowed
    expect(result.decision).toBe("allow");
  });
});

// ─── Keystone factory wiring ────────────────────────────────────────────────

describe("Phase 6: Keystone factory — all Phase 6 methods wired", () => {
  let dir: string;
  let ks: ReturnType<typeof createKeystone>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keystone-p6-wire-"));
    ks = createKeystone({ dataDir: dir });
  });

  it("exposes compileContext on keystone instance", () => {
    expect(typeof ks.compileContext).toBe("function");
  });

  it("exposes execution scheduler methods", () => {
    expect(typeof ks.dispatchReadOnly).toBe("function");
    expect(typeof ks.dispatchMutation).toBe("function");
    expect(typeof ks.acquireLease).toBe("function");
    expect(typeof ks.releaseLease).toBe("function");
    expect(typeof ks.checkLease).toBe("function");
  });

  it("exposes worker guard factory", () => {
    expect(typeof ks.registerWorkerGuard).toBe("function");
  });

  it("exposes tool policy and authority", () => {
    expect(typeof ks.enforceToolPolicy).toBe("function");
    expect(typeof ks.issueAuthority).toBe("function");
  });

  it("exposes role projection", () => {
    expect(typeof ks.projectGoalStoreView).toBe("function");
  });
});
