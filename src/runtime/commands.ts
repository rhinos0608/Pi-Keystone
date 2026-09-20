// /goal command: parsing + controller-backed Pi command handler.
//
// Legacy parsing (`parseGoalCommand` / `createGoalHandler`) is kept for
// compat. The live `/goal` command registered by the extension entrypoint
// uses `handleGoalCommand` with subcommands create|status|cancel|list,
// delegating to the createKeystone() controller API.

import { randomUUID, createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { captureSnapshot, type WorkspaceSnapshot } from "../baseline/snapshot.js";
import { startGoalFlow } from "./goal-flow.js";
import { applyHeuristicFloor, heuristicDepth, type DepthProposal, type DepthProposalInput, type LifecycleDepth } from "./depth.js";
import type { FlowPlanEntry } from "../index.js";
import type {
  ArtifactRef,
  GoalId,
  GoalRecord,
  GoalState,
  ISO8601,
  SnapshotId,
} from "../domain/types.js";
import type { createKeystone } from "../index.js";

/** Minimal Pi agent interface for command → turn handoff (legacy). */
export interface PiAgent {
  /** Always triggers a turn (extensions.md:1414). */
  sendUserMessage(message: string): void | Promise<void>;
}

export interface GoalCommand {
  task: string;
}

/**
 * Parse user input for a /goal command.
 * Accepts `/goal <task>` (raw user input).
 * Returns null when input is not a valid goal command.
 */
export function parseGoalCommand(input: string): GoalCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/goal\s+([\s\S]+)$/);
  if (!match) return null;
  const task = match[1].trim();
  if (!task) return null;
  return { task };
}

/**
 * Create a /goal command handler for Pi 0.84.1 extension registration.
 *
 * Usage:
 *   pi.registerCommand("goal", { handler: createGoalHandler(pi) });
 *
 * Commands bypass the normal turn lifecycle (extensions.md:287).
 * The handler explicitly drives agent work via pi.sendUserMessage(),
 * which always triggers a turn (extensions.md:1414).
 *
 * Pi strips the command name from args; the handler reconstructs
 * the full `/goal <task>` input for the parser.
 */
export function createGoalHandler(pi: PiAgent) {
  return async (args: string): Promise<void> => {
    // Pi strips the command name; reconstruct full input for the parser
    const parsed = parseGoalCommand("/goal " + args);
    if (!parsed) return;

    // Trigger agent turn — commands bypass lifecycle, must explicitly drive work
    await pi.sendUserMessage(parsed.task);
  };
}

// ─── Controller-backed /goal subcommands (Task 7, Wave 3a) ──────────────────

export type GoalSubcommand = "create" | "release" | "status" | "cancel" | "list";

export type ParsedGoalSubcommand = {
  subcommand: GoalSubcommand;
  rest: string;
};

const SUBCOMMANDS: GoalSubcommand[] = ["create", "release", "status", "cancel", "list"];

/** Parse stripped command args (`create <task>` / `status [goalId]` / ...). */
export function parseGoalSubcommand(args: string): ParsedGoalSubcommand | null {
  const trimmed = args.trim();
  if (!trimmed) return { subcommand: "status", rest: "" };
  const space = trimmed.search(/\s/);
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = (space === -1 ? "" : trimmed.slice(space + 1)).trim();
  if ((SUBCOMMANDS as string[]).includes(head)) {
    const sub = head as GoalSubcommand;
    if (sub === "create") {
      return { subcommand: sub, rest };
    }
    if (sub === "list" || sub === "status") {
      // Bare or remainder-bearing list/status; bare release/cancel still
      // routes to its own subcommand so the handler reports usage.
      return { subcommand: sub, rest };
    }
    if (rest.length > 0) {
      // release/cancel require a goal-id-like remainder.
      return { subcommand: sub, rest };
    }
    return { subcommand: sub, rest };
  }
  // Bare task text is shorthand for create.
  return { subcommand: "create", rest: trimmed };
}

/** Engine surface handleGoalCommand needs (structural subset of createKeystone()). */
export type GoalCommandController = Pick<ReturnType<typeof createKeystone>, "goal" | "dispatchEvent"> & {
  /**
   * Production frontier runner: persisted driver lease -> preparation walk
   * -> runExecutionFrontier. Returns ok:false with a typed reason when
   * there is nothing to run — never throws for that case.
   */
  runExecution?: (goalId: GoalId) => Promise<{ ok: boolean; reason?: string }>;
  /** Runtime cancellation: revokes live mutation authority before settlement. */
  cancelGoal?: (
    goalId: GoalId,
    reason: string,
  ) => Promise<{ state: GoalState; outcome: "SETTLED" | "INDETERMINATE" }>;
  /** Controller-owned artifact persistence (goal-flow extension point). */
  writeArtifact?: (content: string) => ArtifactRef;
  /** Cache the flow plan+refs so runExecution can walk to READY. */
  attachFlowPlan?: (goalId: GoalId, entry: FlowPlanEntry) => void;
  getFlowPlan?: (goalId: GoalId) => FlowPlanEntry | undefined;
};

/** Minimal host notify surface (adapts ExtensionCommandContext). */
export type GoalCommandHost = {
  cwd: string;
  notify(message: string, level?: "info" | "error"): void;
  proposeDepth?(input: DepthProposalInput, fallback: DepthProposal): Promise<DepthProposal>;
  confirmPreparedGoal?(input: {
    goalId: string;
    task: string;
    plan: FlowPlanEntry["plan"];
    proposal: DepthProposal;
    baselineSummary: string;
    fleetSummary?: string;
  }): Promise<{ depth: LifecycleDepth } | null>;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/** UUIDv7 goal id (timestamp-ordered; GoalId is UUIDv7-branded). */
export function newGoalId(): GoalId {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, "0");
  const rand = randomUUID().replace(/-/g, "");
  const tail = (rand.slice(12) + rand).slice(0, 18);
  const raw = `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-${((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16)}${rand.slice(4, 7)}-${tail.slice(0, 12)}`;
  return raw as GoalId;
}

/**
 * Workspace identity from a captured snapshot.
 * vcs is "none" ONLY when git is absent (snapshot null or revision null);
 * a present revision always means "git".
 */
function bootstrapWorkspace(cwd: string, snapshot: WorkspaceSnapshot | null): GoalRecord["workspace"] {
  let canonicalRoot = cwd;
  try {
    canonicalRoot = realpathSync(cwd);
  } catch {
    // Goal-flow/lease acquisition will fail closed if the root later becomes
    // unusable; preserve the requested root for truthful diagnostics.
  }
  return {
    requestedRoot: cwd,
    canonicalRoot,
    projectKey: sha256Hex(canonicalRoot),
    vcs: snapshot?.revision ? "git" : "none",
  };
}

/** S0 revision from the captured snapshot (never a hardcoded marker). */
function bootstrapRevision(snapshot: WorkspaceSnapshot | null): GoalRecord["startRevision"] {
  const now = new Date().toISOString() as ISO8601;
  return {
    snapshotId: sha256Hex(snapshot ? JSON.stringify(snapshot) : `keystone-s0-${now}`) as SnapshotId,
    observedAt: now,
    ...(snapshot?.revision ? { gitHead: snapshot.revision } : {}),
    graphRevision: 0,
    dirtySignature: snapshot?.dirtySignature ?? "",
    capabilityDigest: "",
  };
}

function summarize(record: GoalRecord): string {
  return `${record.goalId} [${record.state}] epoch=${record.planEpoch} task="${record.userTask.slice(0, 80)}"`;
}

function summarizeBaseline(entry: FlowPlanEntry): string {
  const checks = Object.values(entry.baseline.checks)
    .filter((check): check is NonNullable<typeof check> => Boolean(check))
    .map((check) => `${check.checkId}:${check.status}`);
  return checks.length ? checks.join(" · ") : "no ecosystem checks";
}


function snapshotMatchesPrepared(current: WorkspaceSnapshot, prepared: WorkspaceSnapshot): boolean {
  return current.revision === prepared.revision && current.dirtySignature === prepared.dirtySignature;
}

async function refreshPreparedFlowIfStale(
  controller: GoalCommandController,
  host: GoalCommandHost,
  record: GoalRecord,
  entry: FlowPlanEntry,
): Promise<{ record: GoalRecord; entry: FlowPlanEntry; refreshed: boolean } | null> {
  if (record.state !== "PREPARING" && record.state !== "PAUSED") return { record, entry, refreshed: false };
  // Outside git, captureSnapshot cannot provide a meaningful freshness token;
  // keep the durable prepared flow rather than pretending a comparison exists.
  let current: WorkspaceSnapshot;
  try {
    current = await captureSnapshot(record.workspace.canonicalRoot || host.cwd);
  } catch {
    if (entry.snapshot.revision === null) return { record, entry, refreshed: false };
    host.notify(`Goal ${record.goalId} remains prepared: workspace freshness could not be verified.`, "error");
    return null;
  }
  if (snapshotMatchesPrepared(current, entry.snapshot)) return { record, entry, refreshed: false };
  if (typeof controller.writeArtifact !== "function" || typeof controller.attachFlowPlan !== "function") {
    host.notify(`Goal ${record.goalId} remains prepared: workspace changed and flow refresh wiring is unavailable.`, "error");
    return null;
  }
  let flow: Awaited<ReturnType<typeof startGoalFlow>>;
  try {
    flow = await startGoalFlow({
      root: record.workspace.canonicalRoot || host.cwd,
      goal: record,
      writeArtifact: controller.writeArtifact,
    });
  } catch (err) {
    host.notify(`Goal ${record.goalId} remains prepared: workspace changed and re-preparation failed (${(err as Error)?.message ?? String(err)}).`, "error");
    return null;
  }
  if (!flow.ok) {
    host.notify(`Goal ${record.goalId} remains prepared: re-preparation ${flow.code} (${flow.reason}).`, "error");
    return null;
  }
  const refreshed: FlowPlanEntry = {
    plan: flow.plan,
    contract: flow.contract,
    revision: flow.revision,
    refs: flow.refs,
    baseline: flow.baseline,
    snapshot: flow.snapshot,
  };
  controller.attachFlowPlan(record.goalId, refreshed);
  const flowRef = controller.writeArtifact(JSON.stringify(refreshed));
  controller.dispatchEvent(record.goalId, {
    type: "PreparedFlowStored",
    flowRef,
    baselineRef: flow.refs.baselineRef,
  });
  const latest = controller.goal.get(record.goalId);
  if (!latest) {
    host.notify(`Goal vanished while refreshing prepared flow: ${record.goalId}`, "error");
    return null;
  }
  host.notify(
    `Prepared plan refreshed: ${record.goalId} (workspace changed before release; prior depth approval invalidated)`,
    "info",
  );
  return { record: latest, entry: refreshed, refreshed: true };
}

async function releasePreparedGoal(
  controller: GoalCommandController,
  host: GoalCommandHost,
  record: GoalRecord,
  flowEntry: FlowPlanEntry,
): Promise<void> {
  const goalId = record.goalId;
  if (typeof controller.runExecution !== "function" || typeof controller.writeArtifact !== "function") {
    host.notify(`Release unavailable: ${goalId} (controller lacks execution wiring)`, "error");
    return;
  }
  if (record.state === "PAUSED" && record.activeMutationLease) {
    host.notify(
      `Goal ${goalId} remains paused: mutation authority ${record.activeMutationLease.leaseId} is still unresolved; re-preparation and execution were not released.`,
      "error",
    );
    return;
  }
  const refreshed = await refreshPreparedFlowIfStale(controller, host, record, flowEntry);
  if (!refreshed) return;
  record = refreshed.record;
  flowEntry = refreshed.entry;
  if (!record.lifecycleDepth || refreshed.refreshed) {
    const depthInput: DepthProposalInput = {
      task: record.userTask,
      plan: flowEntry.plan,
      contract: flowEntry.contract,
      baseline: flowEntry.baseline,
    };
    const heuristic = heuristicDepth(depthInput);
    let proposal = heuristic;
    if (host.proposeDepth) {
      try {
        proposal = applyHeuristicFloor(await host.proposeDepth(depthInput, heuristic), heuristic);
      } catch (err) {
        host.notify(`Depth model unavailable; using ${heuristic.depth} (${(err as Error)?.message ?? String(err)})`, "error");
      }
    }
    if (!host.confirmPreparedGoal) {
      host.notify(`Goal ${goalId} remains prepared: interactive confirmation UI is unavailable; execution was not released.`, "error");
      return;
    }
    const decision = await host.confirmPreparedGoal({
      goalId: String(goalId),
      task: record.userTask,
      plan: flowEntry.plan,
      proposal,
      baselineSummary: summarizeBaseline(flowEntry),
    });
    if (!decision) {
      host.notify(`Goal ${goalId} remains prepared; release cancelled.`, "info");
      return;
    }
    const proposalRef = controller.writeArtifact(JSON.stringify({
      proposal,
      approvedDepth: decision.depth,
      goalId,
      at: new Date().toISOString(),
    }));
    controller.dispatchEvent(goalId, {
      type: "LifecycleDepthApproved",
      depth: decision.depth,
      proposalRef,
      approvedBy: "USER",
    });
  }
  try {
    const outcome = await controller.runExecution(goalId);
    if (outcome.ok) host.notify(`Goal completed: ${goalId}`, "info");
    else host.notify(`Execution incomplete: ${goalId} (${outcome.reason ?? "unknown"})`, "error");
  } catch (err) {
    host.notify(`Execution failed: ${String(goalId)} (${(err as Error)?.message ?? String(err)})`, "error");
  }
}

/**
 * Execute one `/goal` invocation against the controller.
 * create prepares durably; release reopens confirmation; status/list read; cancel revokes/settles.
 */
export async function handleGoalCommand(
  controller: GoalCommandController,
  host: GoalCommandHost,
  args: string,
): Promise<void> {
  const parsed = parseGoalSubcommand(args);
  if (!parsed) {
    host.notify("Usage: /goal <create <task> | release <goalId> | status [goalId] | cancel <goalId> [reason] | list>", "error");
    return;
  }
  switch (parsed.subcommand) {
    case "create": {
      if (!parsed.rest) {
        host.notify("Usage: /goal create <task>", "error");
        return;
      }
      const goalId = newGoalId();
      // S0 snapshot first: workspace identity + start revision derive from
      // it (vcs "none" only when git is absent). Snapshot failure is
      // truthful, never a hardcoded marker: fall back with empty dirt.
      let snapshot: WorkspaceSnapshot | null = null;
      try {
        snapshot = await captureSnapshot(host.cwd);
      } catch {
        snapshot = null;
      }
      const record = controller.goal.create({
        goalId,
        userTask: parsed.rest,
        workspace: bootstrapWorkspace(host.cwd, snapshot),
        startRevision: bootstrapRevision(snapshot),
      });
      host.notify(`Goal created: ${summarize(record)}`, "info");
      // Production lifecycle: startGoalFlow (baseline -> S0 -> plan) then
      // runExecution (preparation walk -> frontier). EVERY outcome notifies
      // truthfully — no silent suppression.
      if (
        typeof controller.writeArtifact !== "function" ||
        typeof controller.attachFlowPlan !== "function" ||
        typeof controller.runExecution !== "function"
      ) {
        host.notify(
          `Preparation unavailable: ${goalId} (controller lacks flow wiring: writeArtifact/attachFlowPlan/runExecution)`,
          "error",
        );
        return;
      }
      let flow: Awaited<ReturnType<typeof startGoalFlow>>;
      try {
        flow = await startGoalFlow({ root: host.cwd, goal: record, writeArtifact: controller.writeArtifact });
      } catch (err) {
        host.notify(`Preparation failed: ${goalId} (${(err as Error)?.message ?? String(err)})`, "error");
        return;
      }
      if (!flow.ok) {
        host.notify(`Preparation ${flow.code}: ${goalId} (${flow.reason})`, "error");
        return;
      }
      const preparedEntry: FlowPlanEntry = {
        plan: flow.plan,
        contract: flow.contract,
        revision: flow.revision,
        refs: flow.refs,
        baseline: flow.baseline,
        snapshot: flow.snapshot,
      };
      controller.attachFlowPlan(goalId, preparedEntry);
      // The in-memory cache is only an optimization. Persist the complete
      // prepared bundle in CAS and link it from the durable goal BEFORE the
      // release TUI, so a dismissed prompt, compaction, or process restart can
      // reopen the exact same plan instead of silently losing execution state.
      const preparedFlowRef = controller.writeArtifact(JSON.stringify(preparedEntry));
      controller.dispatchEvent(goalId, {
        type: "PreparedFlowStored",
        flowRef: preparedFlowRef,
        baselineRef: flow.refs.baselineRef,
      });
      const flowEntry = controller.getFlowPlan?.(goalId) ?? preparedEntry;
      const proposed = heuristicDepth({
        task: parsed.rest,
        plan: flow.plan,
        contract: flow.contract,
        baseline: flow.baseline,
      });
      host.notify(
        `Prepared: ${goalId} (baseline ${flow.refs.baselineRef.slice(0, 12)}…, plan ${flow.plan.assignments.length} assignments, heuristic ${proposed.depth})`,
        "info",
      );
      const latest = controller.goal.get(goalId);
      if (!latest) {
        host.notify(`Goal vanished after preparation: ${goalId}`, "error");
        return;
      }
      await releasePreparedGoal(controller, host, latest, flowEntry);
      return;
    }
    case "release": {
      const goalId = parsed.rest.trim() as GoalId;
      if (!goalId) {
        host.notify("Usage: /goal release <goalId>", "error");
        return;
      }
      const record = controller.goal.get(goalId);
      if (!record) {
        host.notify(`Goal not found: ${parsed.rest}`, "error");
        return;
      }
      if (["DONE", "BLOCKED", "FAILED", "NON_CONVERGENT", "CANCELLED", "CANCELLING"].includes(record.state)) {
        host.notify(`Goal ${goalId} cannot be released from ${record.state}.`, "error");
        return;
      }
      let flowEntry: FlowPlanEntry | undefined;
      try {
        flowEntry = controller.getFlowPlan?.(goalId);
      } catch (err) {
        host.notify(`Prepared flow unreadable: ${goalId} (${(err as Error)?.message ?? String(err)})`, "error");
        return;
      }
      if (!flowEntry) {
        host.notify(`Goal ${goalId} has no durable prepared flow; execution was not released.`, "error");
        return;
      }
      await releasePreparedGoal(controller, host, record, flowEntry);
      return;
    }
    case "status": {
      if (parsed.rest) {
        const record = controller.goal.get(parsed.rest as GoalId);
        host.notify(record ? summarize(record) : `Goal not found: ${parsed.rest}`, record ? "info" : "error");
        return;
      }
      const records = controller.goal.list();
      if (records.length === 0) host.notify("No goals.", "info");
      records.forEach((record) => host.notify(summarize(record), "info"));
      return;
    }
    case "list": {
      const records = controller.goal.list();
      if (records.length === 0) host.notify("No goals.", "info");
      records.forEach((record) => host.notify(summarize(record), "info"));
      return;
    }
    case "cancel": {
      const [goalId, ...reasonParts] = parsed.rest.split(/\s+/);
      if (!goalId) {
        host.notify("Usage: /goal cancel <goalId> [reason]", "error");
        return;
      }
      const existing = controller.goal.get(goalId as GoalId);
      if (!existing) {
        host.notify(`Goal not found: ${goalId}`, "error");
        return;
      }
      const state: GoalState = existing.state;
      if (["DONE", "BLOCKED", "FAILED", "NON_CONVERGENT", "CANCELLED"].includes(state)) {
        host.notify(`Goal ${goalId} already terminal in ${state}; no rollback claimed.`, "error");
        return;
      }
      const reason = reasonParts.join(" ") || "cancelled via /goal cancel";
      if (controller.cancelGoal) {
        try {
          const outcome = await controller.cancelGoal(goalId as GoalId, reason);
          if (outcome.state === "CANCELLED") {
            host.notify(`Goal cancelled: ${goalId} (${reason})`, "info");
          } else {
            host.notify(
              `Cancellation quarantined: ${goalId} (${reason}); live mutation authority was revoked, but rollback/settlement is indeterminate.`,
              "info",
            );
          }
        } catch (err) {
          host.notify(`Cancellation failed: ${goalId} (${(err as Error)?.message ?? String(err)})`, "error");
        }
        return;
      }
      const fencingActive = existing.activeDriverLease !== undefined || existing.driverFenceCounter > 0;
      const driverFence = existing.activeDriverLease?.fencingToken ?? existing.driverFenceCounter;
      controller.dispatchEvent(
        goalId as GoalId,
        fencingActive
          ? { type: "CancelRequested", reason, driverFence }
          : { type: "CancelRequested", reason },
      );
      const cancelling = controller.goal.get(goalId as GoalId);
      if (!cancelling) {
        host.notify(`Cancellation state vanished: ${goalId}`, "error");
        return;
      }
      if (!cancelling.activeMutationLease && typeof controller.writeArtifact === "function") {
        const cleanupRef = controller.writeArtifact(JSON.stringify({
          goalId,
          outcome: "SETTLED",
          reason: "no active mutation lease at cancellation settlement",
          at: new Date().toISOString(),
        }));
        const settleFence = cancelling.activeDriverLease?.fencingToken ?? cancelling.driverFenceCounter;
        const settleFencing = cancelling.activeDriverLease !== undefined || cancelling.driverFenceCounter > 0;
        controller.dispatchEvent(
          goalId as GoalId,
          settleFencing
            ? { type: "CancellationSettled", cleanupRef, mutationOutcome: "SETTLED", driverFence: settleFence }
            : { type: "CancellationSettled", cleanupRef, mutationOutcome: "SETTLED" },
        );
        host.notify(`Goal cancelled: ${goalId} (${reason})`, "info");
        return;
      }
      host.notify(
        `Cancellation requested: ${goalId} (${reason}); mutation settlement is still pending and no rollback is claimed.`,
        "info",
      );
      return;
    }
  }
}

/** Build the `goal` command registration for pi.registerCommand("goal", ...). */
export function createGoalCommandRegistration(
  controllerProvider: () => GoalCommandController,
  hostProvider: (ctx: { cwd: string }) => GoalCommandHost,
): { name: "goal"; description: string; handler: (args: string, ctx: { cwd: string }) => Promise<void> } {
  return {
    name: "goal",
    description: "Keystone goal lifecycle: create <task> | release <goalId> | status [goalId] | cancel <goalId> | list",
    handler: async (args: string, ctx: { cwd: string }): Promise<void> => {
      await handleGoalCommand(controllerProvider(), hostProvider(ctx), args);
    },
  };
}

// Re-export engine-adjacent branded refs used by live paths.
export type { ArtifactRef };
