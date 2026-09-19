import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKeystone, type FrontierWiring } from "../../src/index.js";
import { handleGoalCommand, type GoalCommandHost } from "../../src/runtime/commands.js";
import { createReportEnvelope, type ReportEnvelope } from "../../src/execution/report-envelope.js";
import type { Assignment } from "../../src/execution/assignment.js";
import type { LifecycleDepth } from "../../src/domain/types.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "keystone-adaptive-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Keystone Test");
  git(root, "commit", "--allow-empty", "-m", "init");
  return root;
}

function auditorOutput(assignment: Assignment, message: string) {
  const prompt = assignment.acceptanceCriteria.join("\n");
  const manifestLine = prompt.split("\n").find((line) => line.startsWith("Evidence manifest: "));
  if (!manifestLine) throw new Error("auditor prompt missing evidence manifest");
  const manifest = JSON.parse(manifestLine.slice("Evidence manifest: ".length)) as { nodeIds: string[] };
  const claimNodeId = manifest.nodeIds.find((id) => !id.startsWith("artifact:")) ?? manifest.nodeIds[0];
  const artifactRefs = manifest.nodeIds
    .filter((id) => id.startsWith("artifact:"))
    .map((id) => id.slice("artifact:".length));
  if (!claimNodeId || artifactRefs.length === 0) throw new Error("manifest lacks audit evidence");
  return {
    outcome: /^ACCEPTED\b/i.test(message) ? "ACCEPTED" as const : "REJECTED" as const,
    summary: message,
    claims: [{ nodeId: claimNodeId, statement: "Auditor checked the cited manifest evidence" }],
    evidenceChecklist: artifactRefs.map((artifactRef) => ({
      artifactRef,
      description: `checked ${artifactRef.slice(0, 12)}`,
      present: true,
    })),
  };
}

function report(assignment: Assignment, message: string, seq: number): ReportEnvelope {
  const built = createReportEnvelope({
    assignmentId: assignment.id,
    runId: `run-${seq}`,
    sessionId: `child-session-${seq}`,
    findings: [{ id: `f-${seq}`, severity: "info", message, source: "adaptive-test" }],
    evidenceRefs: [`evidence-${seq}`],
    ...(assignment.role === "auditor" ? { structuredOutput: auditorOutput(assignment, message) } : {}),
  });
  if (!built.ok) throw new Error(`test envelope invalid: ${built.errors.map((e) => e.kind).join(",")}`);
  return built.envelope;
}

async function runDepth(
  depth: LifecycleDepth,
  executorFactory: () => (assignment: Assignment) => Promise<ReportEnvelope>,
): Promise<{ controller: ReturnType<typeof createKeystone>; cleanup(): void }> {
  const root = workspace();
  const dataParent = mkdtempSync(join(tmpdir(), "keystone-adaptive-data-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataParent, { recursive: true, force: true });
  });
  const controller = createKeystone({ dataDir: join(dataParent, ".keystone") });
  const executor = executorFactory();
  const wiring: FrontierWiring = {
    executor,
    postExecutor: async (assignment) => executor(assignment),
    executionPlanRef: controller.writeArtifact("adaptive-plan-placeholder"),
    reportRefFor: (_assignmentId, envelope) => controller.writeArtifact(JSON.stringify(envelope)),
    errorRefFor: (_assignmentId, error) => controller.writeArtifact(String((error as Error)?.message ?? error)),
  };
  controller.registerFrontierWiring(wiring);
  const notes: string[] = [];
  const host: GoalCommandHost = {
    cwd: root,
    notify: (message) => notes.push(message),
    confirmPreparedGoal: async () => ({ depth }),
  };
  await handleGoalCommand(controller, host, "create implement the requested tiny feature");
  expect(notes.some((note) => note.startsWith("Goal completed:")), notes.join("\n")).toBe(true);
  return {
    controller,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataParent, { recursive: true, force: true });
    },
  };
}

describe("adaptive lifecycle end-to-end", () => {
  it("quick repairs a failed verifier, re-verifies fresh, then reaches DONE", async () => {
    let seq = 0;
    let verifierCalls = 0;
    const run = await runDepth("quick", () => async (assignment) => {
      seq++;
      if (assignment.role === "verifier") {
        verifierCalls++;
        if (verifierCalls === 1) throw new Error("verification-failed: fixable regression");
        return report(assignment, "fresh verifier pass after repair", seq);
      }
      return report(assignment, verifierCalls === 0 ? "initial implementation" : "repair implementation", seq);
    });
    const goal = run.controller.goal.list()[0]!;
    expect(goal.state).toBe("DONE");
    expect(goal.repairCycles).toBe(1);
    expect(goal.reviewCycles).toBe(0);
    expect(goal.finalAuditAttempts).toBe(0);
    expect(goal.repairVerificationPending).toBe(false);
    run.cleanup();
  });

  it("standard treats reviewer ERROR as repairable and reaches DONE after a fresh review", async () => {
    let seq = 0;
    let reviewCalls = 0;
    const run = await runDepth("standard", () => async (assignment) => {
      seq++;
      const id = String(assignment.id);
      if (id.startsWith("review-")) {
        reviewCalls++;
        return report(assignment, reviewCalls === 1 ? "ERROR: fixable review defect" : "ACCEPTED: repaired", seq);
      }
      return report(assignment, assignment.role === "verifier" ? "verifier pass" : "implementation pass", seq);
    });
    const goal = run.controller.goal.list()[0]!;
    expect(goal.state).toBe("DONE");
    expect(goal.repairCycles).toBe(1);
    expect(goal.reviewCycles).toBe(2);
    expect(goal.finalAuditAttempts).toBe(0);
    run.cleanup();
  });

  it("full repairs the first rejected final audit and succeeds on the second audit round", async () => {
    let seq = 0;
    let auditCalls = 0;
    const run = await runDepth("full", () => async (assignment) => {
      seq++;
      const id = String(assignment.id);
      if (id.startsWith("review-")) return report(assignment, "ACCEPTED: review clean", seq);
      if (id.startsWith("audit-")) {
        auditCalls++;
        return report(assignment, auditCalls === 1 ? "REJECTED: fixable final-audit defect" : "ACCEPTED: audit clean", seq);
      }
      return report(assignment, assignment.role === "verifier" ? "verifier pass" : "implementation pass", seq);
    });
    const goal = run.controller.goal.list()[0]!;
    expect(goal.state).toBe("DONE");
    expect(goal.repairCycles).toBe(1);
    expect(goal.reviewCycles).toBe(2);
    expect(goal.finalAuditAttempts).toBe(2);
    run.cleanup();
  });
});
