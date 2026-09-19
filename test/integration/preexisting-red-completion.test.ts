import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKeystone } from "../../src/index.js";
import { startGoalFlow } from "../../src/runtime/goal-flow.js";
import { runCompletionFlow } from "../../src/runtime/completion-flow.js";
import { acquireDriverLeasePersisted } from "../../src/runtime/driver.js";
import type { AssignmentId, GoalId } from "../../src/domain/types.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function writeFakeVitest(root: string, lines: string[]): void {
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, "vitest");
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "vitest 3.2.1"; exit 0; fi
${lines.map((line) => `echo "${line}"`).join("\n")}
exit 1
`,
  );
  chmodSync(file, 0o755);
}

describe("completion on a pre-existing red repo", () => {
  it("rejects a new owned failure even when the same test command stays FAIL", async () => {
    const root = mkdtempSync(join(tmpdir(), "keystone-red-completion-ws-"));
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-red-completion-data-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "red-fixture",
        private: true,
        scripts: { test: "vitest run" },
      }));
      writeFakeVitest(root, ["FAIL src/old.test.ts > suite > old failure"]);
      git(root, "init");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Keystone Test");
      git(root, "add", "-f", "package.json", "node_modules/.bin/vitest");
      git(root, "commit", "-m", "fixture");

      const controller = createKeystone({ dataDir: join(dataParent, ".keystone") });
      const goalId = "goal-red-owned-failure" as GoalId;
      controller.goal.create({
        goalId,
        userTask: "implement the requested tiny feature",
        workspace: {
          requestedRoot: root,
          canonicalRoot: root,
          projectKey: "red-owned-failure",
          vcs: "git",
        },
        startRevision: {
          snapshotId: "start" as never,
          observedAt: new Date().toISOString() as never,
          gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
          graphRevision: 0,
          dirtySignature: "",
          capabilityDigest: "",
        },
      });
      const goal = controller.goal.get(goalId)!;
      const prepared = await startGoalFlow({
        root,
        goal,
        writeArtifact: controller.writeArtifact,
        baselineMaxMs: 15_000,
      });
      if (!prepared.ok) throw new Error(prepared.reason);
      expect(prepared.baseline.checks.test?.status).toBe("FAIL");
      expect(prepared.baseline.failureFingerprints).toHaveLength(1);

      const attemptId = "red-fixture-attempt";
      controller.dispatchEvent(goalId, {
        type: "PreparationProgress",
        job: "baseline",
        planEpoch: 0,
        attemptId,
        basedOnRevision: prepared.revision,
        status: "SUCCEEDED",
        driverFence: 0,
        artifactRef: prepared.refs.baselineRef,
      });
      controller.dispatchEvent(goalId, {
        type: "PreparationProgress",
        job: "plan",
        planEpoch: 0,
        attemptId,
        basedOnRevision: prepared.revision,
        status: "SUCCEEDED",
        driverFence: 0,
        artifactRef: prepared.refs.planRef,
      });
      controller.dispatchEvent(goalId, {
        type: "ReconciliationCompleted",
        reportRef: prepared.refs.planRef,
        planEpoch: 0,
        provisionalPlanRef: prepared.refs.planRef,
        basedOnRevision: prepared.revision,
        decision: "ACCEPT_PLAN_BASIS",
        driverFence: 0,
      });
      controller.dispatchEvent(goalId, {
        type: "ContractFrozen",
        contractVersion: 1,
        contractRef: prepared.refs.contractRef,
        driverFence: 0,
      });
      const assignments = prepared.plan.assignments.map((row) => ({
        id: row.id as AssignmentId,
        dependsOn: [] as AssignmentId[],
      }));
      controller.dispatchEvent(goalId, {
        type: "ExecutionStarted",
        contractVersion: 1,
        executionPlanRef: prepared.refs.planRef,
        driverFence: 0,
        assignments,
      });
      for (const row of prepared.plan.assignments) {
        controller.dispatchEvent(goalId, {
          type: "AssignmentCompleted",
          assignmentId: row.id as AssignmentId,
          reportRef: controller.writeArtifact(JSON.stringify({ assignmentId: row.id })),
          driverFence: 0,
        });
      }
      expect(controller.goal.get(goalId)!.state).toBe("VERIFYING");

      const sessionId = "red-verification-session";
      const leased = acquireDriverLeasePersisted(controller.store, goalId, sessionId);
      expect(leased.activeDriverLease?.sessionId).toBe(sessionId);

      writeFakeVitest(root, [
        "FAIL src/old.test.ts > suite > old failure",
        "FAIL src/new.test.ts > suite > new regression",
      ]);

      const result = await runCompletionFlow({
        goalId,
        store: controller.store,
        receiptLog: controller.receiptLog,
        entry: {
          plan: prepared.plan,
          contract: prepared.contract,
          revision: prepared.revision,
          refs: prepared.refs,
          baseline: prepared.baseline,
        },
        frontierResults: [],
        reportRefs: new Map(),
        writeArtifact: controller.writeArtifact,
        driverSessionId: sessionId,
        executeReader: async () => {
          throw new Error("verification regression must stop before review/audit");
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected verification rejection");
      expect(result.reason).toContain("verification-regression");
      expect(result.reason).toContain("fingerprint:");
      expect(controller.goal.get(goalId)!.state).toBe("REPAIRING");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataParent, { recursive: true, force: true });
    }
  });
});
