import { describe, it } from "vitest";
import assert from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createKeystone } from "../../src/index.ts";
import {
  parseGoalCommand,
  parseGoalSubcommand,
  createGoalHandler,
  createGoalCommandRegistration,
  handleGoalCommand,
  newGoalId,
} from "../../src/runtime/commands.ts";
import type { PiAgent, GoalCommandController, GoalCommandHost } from "../../src/runtime/commands.ts";

// ─── parseGoalCommand ─────────────────────────────────────────────────────

describe("parseGoalCommand", () => {
  it("parses /goal with task text", () => {
    const r = parseGoalCommand("/goal implement feature X");
    expect(r).toEqual({ task: "implement feature X" });
  });

  it("trims whitespace around task", () => {
    const r = parseGoalCommand("/goal   implement feature X   ");
    expect(r).toEqual({ task: "implement feature X" });
  });

  it("handles multi-line task text", () => {
    const r = parseGoalCommand("/goal implement feature X\nwith tests");
    expect(r).toEqual({ task: "implement feature X\nwith tests" });
  });

  it("returns null for bare /goal with no task", () => {
    expect(parseGoalCommand("/goal")).toEqual(null);
  });

  it("returns null for /goal followed by only whitespace", () => {
    expect(parseGoalCommand("/goal   ")).toEqual(null);
  });

  it("returns null for plain text without /goal prefix", () => {
    expect(parseGoalCommand("implement feature X")).toEqual(null);
  });

  it("returns null for unrelated input", () => {
    expect(parseGoalCommand("hello world")).toEqual(null);
  });

  it("returns null for empty string", () => {
    expect(parseGoalCommand("")).toEqual(null);
  });

  it("returns null for /goals (no space before task)", () => {
    expect(parseGoalCommand("/goalsomething")).toEqual(null);
  });

  it("returns null for whitespace-only input", () => {
    expect(parseGoalCommand("   ")).toEqual(null);
  });
});

// ─── createGoalHandler ────────────────────────────────────────────────────

describe("createGoalHandler", () => {
  it("calls sendUserMessage with the parsed task", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    // Pi strips "/goal" prefix; handler receives "implement feature X"
    await handler("implement feature X");

    expect(sent).toEqual(["implement feature X"]);
  });

  it("returns silently for empty args", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    await handler("");

    expect(sent.length).toEqual(0);
  });

  it("returns silently for whitespace-only args", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    await handler("   ");

    expect(sent.length).toEqual(0);
  });

  it("handles sendUserMessage returning a Promise", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: async (msg) => { sent.push(msg); },
    };
    await createGoalHandler(pi)("deploy to staging");

    expect(sent).toEqual(["deploy to staging"]);
  });

  it("propagates sendUserMessage rejection", async () => {
    const pi: PiAgent = {
      sendUserMessage: () => { throw new Error("pi down"); },
    };

    await expect(
      () => createGoalHandler(pi)("fix bug"),
      { message: "pi down" },
    );
  });
});

// ─── parseGoalSubcommand (Task 7) ───────────────────────────────────────────

describe("parseGoalSubcommand", () => {
  it("bare args default to status", () => {
    expect(parseGoalSubcommand("")).toEqual({ subcommand: "status", rest: "" });
    expect(parseGoalSubcommand("   ")).toEqual({ subcommand: "status", rest: "" });
  });

  it("parses create with task", () => {
    expect(parseGoalSubcommand("create implement X")).toEqual({ subcommand: "create", rest: "implement X" });
  });

  it("parses release/status/cancel/list", () => {
    expect(parseGoalSubcommand("release abc")).toEqual({ subcommand: "release", rest: "abc" });
    expect(parseGoalSubcommand("status abc")).toEqual({ subcommand: "status", rest: "abc" });
    expect(parseGoalSubcommand("cancel abc reason here")).toEqual({ subcommand: "cancel", rest: "abc reason here" });
    expect(parseGoalSubcommand("list")).toEqual({ subcommand: "list", rest: "" });
  });

  it("is case-insensitive", () => {
    expect(parseGoalSubcommand("STATUS abc")?.subcommand).toEqual("status");
  });

  it("bare task text is create shorthand", () => {
    expect(parseGoalSubcommand("implement feature X")).toEqual({ subcommand: "create", rest: "implement feature X" });
  });
});

// ─── newGoalId (Task 7) ─────────────────────────────────────────────────────

describe("newGoalId", () => {
  it("emits uuidv7-shaped unique ids", () => {
    const a = newGoalId();
    const b = newGoalId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toEqual(b);
  });
});

// ─── handleGoalCommand (Task 7) ─────────────────────────────────────────────

describe("handleGoalCommand", () => {
  function fakeHost(confirm = true) {
    const notes: Array<{ message: string; level?: string }> = [];
    return {
      notes,
      host: {
        cwd: "/tmp/proj",
        notify: (message: string, level?: "info" | "error") => { notes.push({ message, level }); },
        ...(confirm ? { confirmPreparedGoal: async () => ({ depth: "quick" as const }) } : {}),
      } as GoalCommandHost,
    };
  }

  function fakeController() {
    const dispatched: unknown[] = [];
    const goals = new Map<string, any>();
    const plans = new Map<string, unknown>();
    let artCounter = 0;
    return {
      dispatched,
      plans,
      controller: {
        goal: {
          create: (input: any) => {
            const record = {
              goalId: input.goalId,
              userTask: input.userTask,
              state: "PREPARING",
              planEpoch: 0,
            };
            goals.set(input.goalId, record);
            return record;
          },
          get: (id: string) => goals.get(id) ?? null,
          list: () => [...goals.values()],
        },
        dispatchEvent: (goalId: string, event: unknown) => { dispatched.push({ goalId, event }); },
        writeArtifact: (content: string) => `art-${++artCounter}-${content.length}` as any,
        attachFlowPlan: (goalId: string, entry: unknown) => { plans.set(goalId, entry); },
        getFlowPlan: (goalId: string) => plans.get(goalId),
      } as unknown as GoalCommandController,
    };
  }

  it("create stores goal and notifies id", async () => {
    const { controller } = fakeController();
    const ctrl = { ...controller, runExecution: async () => ({ ok: true as const }) };
    const { notes, host } = fakeHost();
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[0].message).toContain("Goal created:");
    expect(notes[0].message).toContain("implement X");
    expect(notes[1].message).toContain("Prepared:");
    expect(notes[2].message).toContain("Goal completed:");
  });

  it("create without confirmation UI stays prepared and does not release execution", async () => {
    const { controller, dispatched } = fakeController();
    let runs = 0;
    const ctrl = { ...controller, runExecution: async () => { runs++; return { ok: true as const }; } };
    const { notes, host } = fakeHost(false);
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(runs).toEqual(0);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as any).event.type).toBe("PreparedFlowStored");
    expect(notes[2].message).toContain("remains prepared");
  });

  it("release reopens confirmation for a durably prepared goal and then runs execution", async () => {
    const { controller, dispatched } = fakeController();
    let runs = 0;
    const ctrl = { ...controller, runExecution: async () => { runs++; return { ok: true as const }; } };
    const noUi = fakeHost(false);
    await handleGoalCommand(ctrl, noUi.host, "create implement X");
    const created = (controller.goal.list() as any[])[0].goalId as string;

    const withUi = fakeHost(true);
    await handleGoalCommand(ctrl, withUi.host, `release ${created}`);

    expect(runs).toBe(1);
    expect(dispatched.map((row: any) => row.event.type)).toContain("LifecycleDepthApproved");
    expect(withUi.notes.at(-1)?.message).toContain("Goal completed:");
  });

  it("create without flow wiring notifies preparation unavailable", async () => {
    const { controller } = fakeController();
    const { writeArtifact: _w, attachFlowPlan: _a, ...bare } = controller as any;
    const { notes, host } = fakeHost();
    await handleGoalCommand(bare as GoalCommandController, host, "create implement X");
    expect(notes).toHaveLength(2);
    expect(notes[1].level).toEqual("error");
    expect(notes[1].message).toContain("Preparation unavailable:");
  });

  it("create without task is usage error", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "create   ");
    expect(notes[0].level).toEqual("error");
  });

  it("status reports unknown goal as error", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "status nope");
    expect(notes[0].level).toEqual("error");
    expect(notes[0].message).toContain("not found");
  });

  it("list on empty store notifies once", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "list");
    expect(notes).toEqual([{ message: "No goals.", level: "info" }]);
  });

  it("cancel dispatches CancelRequested with reason", async () => {
    const { controller, dispatched } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "create do Y");
    const created = (controller.goal.list() as any[])[0].goalId as string;
    await handleGoalCommand(controller, host, `cancel ${created} user asked`);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toEqual({ goalId: created, event: { type: "CancelRequested", reason: "user asked" } });
    expect((dispatched[1] as any).event).toMatchObject({ type: "CancellationSettled", mutationOutcome: "SETTLED" });
    const last = notes[notes.length - 1];
    expect(last.message).toContain("Goal cancelled");
  });

  it("cancel delegates to runtime revocation and reports indeterminate mutation quarantine", async () => {
    const { controller, dispatched } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "create do Y");
    const created = (controller.goal.list() as any[])[0].goalId as string;
    let requested: { goalId: string; reason: string } | undefined;
    const ctrl = {
      ...controller,
      cancelGoal: async (goalId: any, reason: string) => {
        requested = { goalId: String(goalId), reason };
        return { state: "CANCELLING" as const, outcome: "INDETERMINATE" as const };
      },
    };
    const before = dispatched.length;
    await handleGoalCommand(ctrl, host, `cancel ${created} stop now`);
    expect(requested).toEqual({ goalId: created, reason: "stop now" });
    expect(dispatched).toHaveLength(before);
    expect(notes.at(-1)?.message).toContain("quarantined");
    expect(notes.at(-1)?.message).toContain("revoked");
  });

  it("cancel of terminal goal claims no rollback and skips dispatch", async () => {
    const done = { goalId: "g-done", userTask: "t", state: "DONE", planEpoch: 1 };
    const dispatched: unknown[] = [];
    const controller = {
      goal: { create: () => done, get: () => done, list: () => [done] },
      dispatchEvent: (goalId: string, event: unknown) => { dispatched.push({ goalId, event }); },
    } as unknown as GoalCommandController;
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "cancel g-done");
    expect(dispatched).toHaveLength(0);
    expect(notes[0].level).toEqual("error");
    expect(notes[0].message).toContain("already terminal");
  });

  it("cancel of unknown goal is error", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    await handleGoalCommand(controller, host, "cancel ghost");
    expect(notes[0].level).toEqual("error");
  });

  it("create with runExecution ok:true notifies frontier ran", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    const ctrl = { ...controller, runExecution: async () => ({ ok: true as const }) };
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[0].message).toContain("Goal created:");
    expect(notes[2]).toEqual({ message: expect.stringContaining("Goal completed"), level: "info" });
  });

  it("create with runExecution no-execution-plan notifies loud (no silent suppression)", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    const ctrl = { ...controller, runExecution: async () => ({ ok: false as const, reason: "no-execution-plan" }) };
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[2].level).toEqual("error");
    expect(notes[2].message).toContain("Execution incomplete:");
    expect(notes[2].message).toContain("no-execution-plan");
  });

  it("create with runExecution no-frontier-executor notifies loud (no silent suppression)", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    const ctrl = { ...controller, runExecution: async () => ({ ok: false as const, reason: "no-frontier-executor-registered" }) };
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[2].level).toEqual("error");
    expect(notes[2].message).toContain("Execution incomplete:");
    expect(notes[2].message).toContain("no-frontier-executor-registered");
  });

  it("create with runExecution frontier-incomplete notifies error", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    const ctrl = { ...controller, runExecution: async () => ({ ok: false as const, reason: "frontier-incomplete" }) };
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[0].message).toContain("Goal created:");
    expect(notes[2].level).toEqual("error");
    expect(notes[2].message).toContain("Execution incomplete:");
    expect(notes[2].message).toContain("frontier-incomplete");
  });

  it("create with runExecution reject notifies loud", async () => {
    const { controller } = fakeController();
    const { notes, host } = fakeHost();
    const ctrl = { ...controller, runExecution: async () => { throw new Error("spawn down"); } };
    await handleGoalCommand(ctrl, host, "create implement X");
    expect(notes).toHaveLength(3);
    expect(notes[2].level).toEqual("error");
    expect(notes[2].message).toContain("Execution failed:");
    expect(notes[2].message).toContain("spawn down");
  });
  it("refreshes a drifted prepared flow and re-confirms depth before release", async () => {
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-drift-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "keystone-drift-ws-"));
    try {
      execSync("git init", { cwd: workspace, stdio: "ignore" });
      execSync("git config user.email test@example.com", { cwd: workspace, stdio: "ignore" });
      execSync("git config user.name Test", { cwd: workspace, stdio: "ignore" });
      writeFileSync(join(workspace, "seed.txt"), "seed\n");
      execSync("git add seed.txt && git commit -m seed", { cwd: workspace, stdio: "ignore", shell: "/bin/sh" });

      const controller = createKeystone({ dataDir: join(dataParent, ".keystone") });
      let confirms = 0;
      const notes: Array<{ message: string; level?: string }> = [];
      const host: GoalCommandHost = {
        cwd: workspace,
        notify: (message, level) => { notes.push({ message, level }); },
        confirmPreparedGoal: async () => { confirms++; return { depth: "quick" }; },
      };

      await handleGoalCommand(controller, host, "create implement X");
      const first = controller.goal.list()[0]!;
      expect(first.state).toBe("PREPARING");
      expect(first.lifecycleDepth).toBe("quick");
      const firstFlowRef = first.preparedFlowRef;
      expect(confirms).toBe(1);

      writeFileSync(join(workspace, "drift.txt"), "changed after first approval\n");
      await handleGoalCommand(controller, host, `release ${String(first.goalId)}`);

      const refreshed = controller.goal.get(first.goalId)!;
      expect(refreshed.state).toBe("PREPARING");
      expect(refreshed.preparedFlowRef).not.toBe(firstFlowRef);
      expect(refreshed.lifecycleDepth).toBe("quick");
      expect(confirms).toBe(2);
      expect(notes.some((n) => n.message.includes("Prepared plan refreshed"))).toBe(true);
      expect(controller.getFlowPlan(first.goalId)?.snapshot.untracked).toContain("drift.txt");
    } finally {
      rmSync(dataParent, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps paused goals stable, refreshes drift, bumps epoch, and re-confirms before resume", async () => {
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-paused-drift-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "keystone-paused-drift-ws-"));
    try {
      execSync("git init", { cwd: workspace, stdio: "ignore" });
      execSync("git config user.email test@example.com", { cwd: workspace, stdio: "ignore" });
      execSync("git config user.name Test", { cwd: workspace, stdio: "ignore" });
      writeFileSync(join(workspace, "seed.txt"), "seed\n");
      execSync("git add seed.txt && git commit -m seed", { cwd: workspace, stdio: "ignore", shell: "/bin/sh" });

      const controller = createKeystone({ dataDir: join(dataParent, ".keystone") });
      let confirms = 0;
      const notes: Array<{ message: string; level?: string }> = [];
      const host: GoalCommandHost = {
        cwd: workspace,
        notify: (message, level) => { notes.push({ message, level }); },
        confirmPreparedGoal: async () => { confirms++; return { depth: "quick" }; },
      };

      await handleGoalCommand(controller, host, "create implement X");
      const first = controller.goal.list()[0]!;
      const firstFlowRef = first.preparedFlowRef;
      const firstEpoch = first.planEpoch;
      controller.dispatchEvent(first.goalId, { type: "PauseRequested", reason: "operator pause" });
      controller.hooks.session_start();
      expect(controller.goal.get(first.goalId)?.state).toBe("PAUSED");

      writeFileSync(join(workspace, "paused-drift.txt"), "changed while paused\n");
      await handleGoalCommand(controller, host, `release ${String(first.goalId)}`);

      const refreshed = controller.goal.get(first.goalId)!;
      expect(refreshed.state).toBe("PAUSED");
      expect(refreshed.planEpoch).toBe(firstEpoch + 1);
      expect(refreshed.preparedFlowRef).not.toBe(firstFlowRef);
      expect(refreshed.lifecycleDepth).toBe("quick");
      expect(refreshed.preparation.baselineJob.status).toBe("PENDING");
      expect(refreshed.preparation.provisionalPlanJob.status).toBe("PENDING");
      expect(confirms).toBe(2);
      expect(controller.getFlowPlan(first.goalId)?.snapshot.untracked).toContain("paused-drift.txt");
      expect(notes.at(-1)?.message).toContain("no-live-runtime");
    } finally {
      rmSync(dataParent, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

});

// ─── createGoalCommandRegistration (Task 7) ─────────────────────────────────

describe("createGoalCommandRegistration", () => {
  it("registers name goal and delegates to controller", async () => {
    const seen: string[] = [];
    const controller = {
      goal: { create: () => ({ goalId: "g", userTask: "t", state: "PREPARING", planEpoch: 0 }), get: () => null, list: () => [] },
      dispatchEvent: () => {},
    } as unknown as GoalCommandController;
    const reg = createGoalCommandRegistration(() => controller, (ctx) => ({
      cwd: ctx.cwd,
      notify: (message: string) => { seen.push(message); },
    }));
    expect(reg.name).toEqual("goal");
    await reg.handler("list", { cwd: "/tmp" });
    expect(seen).toEqual(["No goals."]);
  });
});

// ─── Production composition (goal-flow + runExecution, no RPC bridge) ───────

describe("goal create composition", () => {
  it("persists baseline+contract+plan and stays prepared when no live RPC bridge exists", async () => {
    const dataParent = mkdtempSync(join(tmpdir(), "keystone-cmd-"));
    const workspace = mkdtempSync(join(tmpdir(), "keystone-ws-"));
    try {
      const controller = createKeystone({ dataDir: join(dataParent, ".keystone") });
      const notes: Array<{ message: string; level?: string }> = [];
      const host: GoalCommandHost = {
        cwd: workspace,
        notify: (message: string, level?: "info" | "error") => { notes.push({ message, level }); },
        confirmPreparedGoal: async () => ({ depth: "quick" }),
      };
      await handleGoalCommand(controller, host, "create implement X");

      // Every outcome notified truthfully: created + prepared + incomplete.
      expect(notes).toHaveLength(3);
      expect(notes[0].message).toContain("Goal created:");
      expect(notes[1].message).toContain("Prepared:");
      expect(notes[2].level).toEqual("error");
      expect(notes[2].message).toContain("Execution incomplete:");
      expect(notes[2].message).toContain("no-live-runtime");

      const record = controller.goal.list()[0];
      // Bridge availability is not a goal defect. Approval is durable, but the
      // lifecycle remains PREPARING so a later /goal release can retry safely.
      expect(record.executionPlan).toBeNull();
      expect(record.state).toEqual("PREPARING");
      expect(record.lifecycleDepth).toEqual("quick");
      expect(record.preparedFlowRef).toBeTruthy();
      expect(controller.receiptLog.map((r) => r.eventType)).not.toContain("ExecutionStarted");
      expect(controller.receiptLog.map((r) => r.eventType)).toContain("LifecycleDepthApproved");
      // The state-machine preparation walk intentionally has not started yet.
      expect(record.preparation.baselineJob.status).toEqual("PENDING");
      expect(record.preparation.provisionalPlanJob.status).toEqual("PENDING");
      // Plan + refs cached for runExecution.
      const entry = controller.getFlowPlan(record.goalId);
      expect(entry).toBeDefined();
      expect(entry!.plan.assignments.length).toBeGreaterThan(0);
      expect(entry!.contract.goalId).toEqual(record.goalId);
      expect(entry!.refs.contractRef).toBeTruthy();

      // Direct runExecution re-entry is also truthful, never silent.
      const outcome = await controller.runExecution(record.goalId);
      expect(outcome.ok).toEqual(false);
      expect(typeof outcome.reason).toEqual("string");
      expect((outcome.reason ?? "").length).toBeGreaterThan(0);
    } finally {
      rmSync(dataParent, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
