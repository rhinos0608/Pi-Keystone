import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default async function (pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_SUBAGENT_CHILD) return;
  let observerPath: string | null = null;
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
    observerPath = join(ctx.cwd, ".keystone-e2e-observer.jsonl");
    appendFileSync(observerPath, JSON.stringify({ kind: "parent", model, sessionId: ctx.sessionManager.getSessionId() }) + "\n");
  });
  pi.events.on("subagent:async-complete", (data: unknown) => {
    try {
      if (!observerPath) return;
      appendFileSync(observerPath, JSON.stringify({ kind: "child-complete", data }) + "\n");
    } catch {}
  });
  pi.events.on("subagents:rpc:v1:request", (data: unknown) => {
    try {
      const row = data as any;
      if (row?.method === "spawn") {
        if (!observerPath) return;
        appendFileSync(observerPath, JSON.stringify({ kind: "spawn", params: row.params }) + "\n");
      }
    } catch {}
  });
}
