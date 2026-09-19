import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKeystone, acquireLease, releaseLease, type FrontierWiring, type FlowPlanEntry } from "../../src/index.js";
import { handleGoalCommand, type GoalCommandHost } from "../../src/runtime/commands.js";
import { createReportEnvelope, type ReportEnvelope } from "../../src/execution/report-envelope.js";
import type { Assignment } from "../../src/execution/assignment.js";
import type { AssignmentId, GoalId, MutationLease } from "../../src/domain/types.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "keystone-repair-recovery-ws-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Keystone Recovery Test");
  git(root, "commit", "--allow-empty", "-m", "init");
  return root;
}

function envelope(assignment: Assignment, runId: string, message: string): ReportEnvelope {
  const built = createReportEnvelope({
    assignmentId: assignment.id,
    runId,
    sessionId: `session-${runId}`,
    findings: [{ id: `finding-${runId}`, severity: "info", message, source: "repair-recovery-test" }],
    evidenceRefs: [`evidence-${runId}`],
  });
  if (!built.ok) throw new Error(`invalid test report: ${built.errors.map((e) => e.kind).join(",")}`);
  return built.envelope;
}

function walkToPostRepairVerify(
  controller: ReturnType<typeof createKeystone>,
  goalId: GoalId,
  flow: FlowPlanEntry,
): void {
  controller.dispatchEvent(goalId, {
    type: "LifecycleDepthApproved",
    depth: "quick",
    proposalRef: controller.writeArtifact("quick-depth"),
    approvedBy: "USER",
  });
  const attemptId = "restart-test-attempt";
  controller.dispatchEvent(goalId, {
    type: "PreparationProgress",
    job: "baseline",
    planEpoch: 0,
    attemptId,
    basedOnRevision: flow.revision,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: flow.refs.baselineRef,
  });
  controller.dispatchEvent(goalId, {
    type: "PreparationProgress",
    job: "plan",
    planEpoch: 0,
    attemptId,
    basedOnRevision: flow.revision,
    status: "SUCCEEDED",
    driverFence: 0,
    artifactRef: flow.refs.planRef,
  });
  controller.dispatchEvent(goalId, {
    type: "ReconciliationCompleted",
    reportRef: flow.refs.planRef,
    planEpoch: 0,
    provisionalPlanRef: flow.refs.planRef,
    basedOnRevision: flow.revision,
    decision: "ACCEPT_PLAN_BASIS",
    driverFence: 0,
  });
  controller.dispatchEvent(goalId, {
    type: "ContractFrozen",
    contractVersion: 1,
    contractRef: flow.refs.contractRef,
    driverFence: 0,
  });
  const assignments = flow.plan.assignments.map((row) => ({ id: row.id as AssignmentId, dependsOn: [] as AssignmentId[] }));
  controller.dispatchEvent(goalId, {
    type: "ExecutionStarted",
    contractVersion: 1,
    executionPlanRef: flow.refs.planRef,
    driverFence: 0,
    assignments,
  });
  for (const row of flow.plan.assignments) {
    controller.dispatchEvent(goalId, {
      type: "AssignmentCompleted",
      assignmentId: row.id as AssignmentId,
      reportRef: controller.writeArtifact(JSON.stringify({ assignmentId: row.id, preRepair: true })),
      driverFence: 0,
    });
  }
  controller.dispatchEvent(goalId, {
    type: "VerificationCompleted",
    runRef: controller.writeArtifact(JSON.stringify({ regression: "fixable" })),
    accepted: false,
    driverFence: 0,
  });
  const implementation = flow.plan.assignments.find((row) => row.role === "implementation");
  if (!implementation) throw new Error("test flow has no implementation assignment");
  controller.dispatchEvent(goalId, {
    type: "AssignmentRunBound",
    assignmentId: implementation.id as AssignmentId,
    runId: "repair-run-before-crash",
    sessionId: "repair-child-before-crash",
    driverFence: 0,
  });
  controller.dispatchEvent(goalId, {
    type: "RepairCompleted",
    assignmentId: implementation.id as AssignmentId,
    reportRef: controller.writeArtifact(JSON.stringify({ repaired: true })),
    driverFence: 0,
  });
  const postRepair = controller.goal.get(goalId)!;
  expect(postRepair.state).toBe("VERIFYING");
  expect(postRepair.repairVerificationPending).toBe(true);
}

describe("repair restart recovery", () => {
  it("restarts after RepairCompleted by running fresh independent verification before DONE", async () => {
    const root = makeWorkspace();
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-repair-recovery-data-"));
    const dataDir = join(dataParent, ".keystone");
    try {
      const first = createKeystone({ dataDir });
      const host: GoalCommandHost = { cwd: root, notify: () => {} };
      await handleGoalCommand(first, host, "create implement the requested tiny feature");
      const goalId = first.goal.list()[0]!.goalId;
      const flow = first.getFlowPlan(goalId);
      if (!flow) throw new Error("prepared flow missing");
      walkToPostRepairVerify(first, goalId, flow);

      // Simulated process restart: new controller, empty in-memory flow cache.
      const restarted = createKeystone({ dataDir });
      let verifierRuns = 0;
      const executor = async (assignment: Assignment): Promise<ReportEnvelope> => {
        if (assignment.role !== "verifier") throw new Error("repair must not rerun once RepairCompleted is durable");
        verifierRuns++;
        return envelope(assignment, `post-repair-verifier-${verifierRuns}`, "fresh independent verifier pass after restart");
      };
      const wiring: FrontierWiring = {
        executor,
        postExecutor: async (assignment) => envelope(assignment, `post-${String(assignment.id)}`, "ACCEPTED: post stage clean"),
        executionPlanRef: restarted.writeArtifact("recovery-placeholder"),
        reportRefFor: (_assignmentId, report) => restarted.writeArtifact(JSON.stringify(report)),
        errorRefFor: (_assignmentId, error) => restarted.writeArtifact(String((error as Error)?.message ?? error)),
      };
      restarted.registerFrontierWiring(wiring);
      restarted.bindSessionRuntime({
        rpc: { ready: true } as any,
        sessionId: "restart-session",
        live: true,
        cwd: root,
      });

      const outcome = await restarted.runExecution(goalId);
      expect(outcome).toEqual({ ok: true });
      expect(verifierRuns).toBeGreaterThan(0);
      const final = restarted.goal.get(goalId)!;
      expect(final.state).toBe("DONE");
      expect(final.repairCycles).toBe(1);
      expect(final.repairVerificationPending).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataParent, { recursive: true, force: true });
    }
  });
  it("pauses and preserves mirrored authority when the on-disk repair lease identity disagrees", async () => {
    const root = makeWorkspace();
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-repair-conflict-data-"));
    const dataDir = join(dataParent, ".keystone");
    let diskLeaseId: string | undefined;
    try {
      const first = createKeystone({ dataDir });
      const host: GoalCommandHost = { cwd: root, notify: () => {} };
      await handleGoalCommand(first, host, "create implement the requested tiny feature");
      const goalId = first.goal.list()[0]!.goalId;
      const flow = first.getFlowPlan(goalId);
      if (!flow) throw new Error("prepared flow missing");
      walkToPostRepairVerify(first, goalId, flow);
      first.dispatchEvent(goalId, {
        type: "VerificationCompleted",
        runRef: first.writeArtifact(JSON.stringify({ regression: "again" })),
        accepted: false,
        driverFence: 0,
      });
      const implementation = flow.plan.assignments.find((row) => row.role === "implementation");
      if (!implementation) throw new Error("test flow has no implementation assignment");

      const disk = acquireLease({
        goalId: String(goalId),
        assignmentId: implementation.id as AssignmentId,
        sessionId: "other-writer",
        root,
        writeSet: ["src/conflict.ts"],
        ttlMs: 120_000,
      });
      if (!disk.acquired) throw new Error(`could not create conflicting disk lease: ${disk.reason}`);
      diskLeaseId = disk.lease.leaseId;

      const mirror: MutationLease = {
        ...disk.lease,
        leaseId: "mirror-repair-lease",
        sessionId: "lost-repair-session",
        workerProcessIdentity: "lost-worker",
        phase: "MUTATING",
      };
      first.dispatchEvent(goalId, { type: "MutationLeaseAttached", lease: mirror, driverFence: 0 });

      const restarted = createKeystone({ dataDir });
      restarted.registerFrontierWiring({
        executor: async () => { throw new Error("must not spawn while authority identity is ambiguous"); },
        executionPlanRef: restarted.writeArtifact("conflict-placeholder"),
        reportRefFor: (_assignmentId, report) => restarted.writeArtifact(JSON.stringify(report)),
      });
      restarted.bindSessionRuntime({
        rpc: { ready: true } as any,
        sessionId: "restart-session",
        live: true,
        cwd: root,
      });

      const outcome = await restarted.runExecution(goalId);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toContain("repair-recovery-lease-identity-changed");
      const paused = restarted.goal.get(goalId)!;
      expect(paused.state).toBe("PAUSED");
      expect(paused.activeMutationLease?.leaseId).toBe("mirror-repair-lease");
    } finally {
      if (diskLeaseId) releaseLease(root, diskLeaseId);
      rmSync(root, { recursive: true, force: true });
      rmSync(dataParent, { recursive: true, force: true });
    }
  });

});
