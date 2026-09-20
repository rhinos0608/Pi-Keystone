import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SubagentRpcClient,
  createKeystone,
  ensureKeystoneSessionBridges,
  handleGoalCommand,
  resetSessionBridges,
} from "../../src/index.js";

type FleetEntry = {
  agent?: string;
  model?: string;
  effort?: string;
};

type ObservedChild = {
  agent: string;
  model?: string;
  effort?: string;
  source: "fleet" | "completion";
};

export default function liveE2EDriver(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const resultPath = process.env.KEYSTONE_E2E_RESULT;
    if (!resultPath) return;
    // Return from session_start before running the lifecycle. Pi RPC attaches
    // its stdin JSONL reader only after extension binding completes. Starting
    // detached children while this hook is still awaited can otherwise leave
    // no referenced host handle and let Node exit before async completion.
    let timer: ReturnType<typeof setTimeout> | undefined;
    pi.on("session_shutdown", () => {
      if (timer !== undefined) clearTimeout(timer);
    });
    timer = setTimeout(() => {
      void (async () => {
    const rpc = new SubagentRpcClient(pi.events as never, {
      sourceExtension: "keystone-live-e2e",
    });
    // Use the production data location so the live test exercises the
    // snapshot exclusion for Keystone's own control-plane writes.
    const controller = createKeystone({ dataDir: join(ctx.cwd, ".keystone") });
    const notifications: Array<{ message: string; type?: string }> = [];
    const observed: ObservedChild[] = [];
    const completions: unknown[] = [];
    let polling = false;
    let poller: NodeJS.Timeout | undefined;

    const recordChildren = (entries: FleetEntry[], source: ObservedChild["source"]) => {
      for (const entry of entries) {
        if (!entry.agent) continue;
        const row: ObservedChild = {
          agent: entry.agent,
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.effort ? { effort: entry.effort } : {}),
          source,
        };
        if (!observed.some((seen) =>
          seen.agent === row.agent && seen.model === row.model && seen.source === row.source
        )) observed.push(row);
      }
    };

    const offComplete = rpc.onAsyncComplete((payload) => {
      completions.push(payload);
      const rows = (payload.results ?? []).map((row) => ({
        agent: String(row.agent ?? ""),
        model: typeof row.model === "string" ? row.model : undefined,
        effort: typeof row.thinking === "string" ? row.thinking : undefined,
      }));
      recordChildren(rows, "completion");
    });

    const parentModelBefore = (ctx as unknown as {
      model?: { provider?: string; id?: string };
    }).model;
    const parentBefore =
      parentModelBefore?.provider && parentModelBefore.id
        ? `${parentModelBefore.provider}/${parentModelBefore.id}`
        : undefined;

    let output: Record<string, unknown> = {};
    try {
      await rpc.waitReady(15_000);
      const sessionId = ctx.sessionManager.getSessionId();
      ensureKeystoneSessionBridges(sessionId);
      controller.bindSessionRuntime({
        rpc,
        sessionId,
        live: true,
        cwd: ctx.cwd,
        approveMutationConflict: async () => true,
      });
      controller.registerFrontierWiring(controller.buildFrontierWiring());

      poller = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const status = await rpc.statusOverview(2_000);
          const fleet = status.fleet as { entries?: FleetEntry[] } | undefined;
          recordChildren(fleet?.entries ?? [], "fleet");
        } catch {
          // Best-effort observability only; the lifecycle itself remains authoritative.
        } finally {
          polling = false;
        }
      }, 250);
      poller.unref?.();

      const task =
        process.env.KEYSTONE_E2E_TASK ??
        "Create e2e-output.md containing exactly keystone-live-e2e-ok.";
      const depth = (process.env.KEYSTONE_E2E_DEPTH ?? "full") as
        | "quick"
        | "standard"
        | "full";

      await handleGoalCommand(
        controller,
        {
          cwd: ctx.cwd,
          notify: (message, type) => notifications.push({ message, type }),
          confirmPreparedGoal: async () => ({ depth }),
        },
        `create ${task}`,
      );

      const goal = controller.goal.list()[0];
      const outputPath = join(ctx.cwd, "e2e-output.md");
      const parentModelAfter = (ctx as unknown as {
        model?: { provider?: string; id?: string };
      }).model;
      const parentAfter =
        parentModelAfter?.provider && parentModelAfter.id
          ? `${parentModelAfter.provider}/${parentModelAfter.id}`
          : undefined;

      output = {
        ok: goal?.state === "DONE" && existsSync(outputPath),
        goalId: goal?.goalId,
        state: goal?.state,
        recoveryRequired: goal?.recoveryRequired,
        lifecycleDepth: goal?.lifecycleDepth,
        outputExists: existsSync(outputPath),
        outputContent: existsSync(outputPath)
          ? readFileSync(outputPath, "utf8")
          : null,
        parentModelBefore: parentBefore,
        parentModelAfter: parentAfter,
        observedChildren: observed,
        completions,
        notifications,
        receipts: controller.receiptLog.map((row) => ({
          eventType: row.eventType,
          fromState: row.fromState,
          toState: row.toState,
        })),
      };
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        notifications,
        observedChildren: observed,
        completions,
      };
    } finally {
      if (poller) clearInterval(poller);
      offComplete();
      controller.bindSessionRuntime(null);
      rpc.dispose();
      resetSessionBridges();
      const tmpPath = `${resultPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(output, null, 2));
      renameSync(tmpPath, resultPath);
    }
      })();
    }, 100);
  });
}
