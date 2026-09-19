import { describe, it, expect } from "vitest";
import type { AssignmentId, RunRecord } from "../../src/domain/types.js";
import { SubagentRpcClient } from "../../src/rpc/subagent-rpc-client.js";
import { RunRegistry } from "../../src/rpc/run-registry.js";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REQUEST_EVENT,
  subagentRpcReplyEvent,
  RpcNotReadyError,
  RpcReplyError,
  RpcTimeoutError,
} from "../../src/rpc/types.js";

// ─── Fake bus (mirrors pi-subagents test/unit/rpc.test.ts:57-66) ────────────

class FakeEvents {
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  private handlers = new Map<string, Array<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event) ?? [];
      this.handlers.set(event, current.filter((c) => c !== handler));
    };
  }

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }

  count(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

function aid(s: string): AssignmentId {
  return s as AssignmentId;
}

function makeRunRecord(runId: string): RunRecord {
  return {
    runId,
    sessionId: "session-1",
    status: "RUNNING",
    startedAt: "2026-01-01T00:00:00.000Z" as RunRecord["startedAt"],
  };
}

describe("SubagentRpcClient", () => {
  it("ready → ping → spawn → reply correlation → async-complete delivery", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });

    // Bridge stub: answer ping + spawn on the request channel.
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw: unknown) => {
      const req = raw as { requestId: string; method: string; params?: unknown };
      if (req.method === "ping") {
        events.emit(subagentRpcReplyEvent(req.requestId), {
          version: 1,
          requestId: req.requestId,
          method: "ping",
          success: true,
          data: { version: 1, methods: ["ping", "spawn"], capabilities: {}, events: {}, session: {} },
        });
      } else if (req.method === "spawn") {
        const params = req.params as Record<string, unknown>;
        expect(params.async).toBe(true);
        expect(String(req.requestId).startsWith("keystone-")).toBe(true);
        events.emit(subagentRpcReplyEvent(req.requestId), {
          version: 1,
          requestId: req.requestId,
          method: "spawn",
          success: true,
          data: {
            text: "Async: worker [run-1]",
            details: { mode: "single", asyncId: "run-1", asyncDir: "/tmp/run-1", runId: "run-1" },
          },
        });
      }
    });

    // Sending before ready must fail closed.
    await expect(client.ping()).rejects.toBeInstanceOf(RpcNotReadyError);

    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();

    const pong = await client.ping();
    expect(pong.version).toBe(1);

    const spawned = await client.spawn({ agent: "worker", task: "Do work" });
    expect(spawned.details.runId).toBe("run-1");
    expect(spawned.details.asyncId).toBe("run-1");

    // Two in-flight requests correlate to their own replies.
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw: unknown) => {
      const req = raw as { requestId: string; method: string };
      if (req.method === "status" || req.method === "result") {
        events.emit(subagentRpcReplyEvent(req.requestId), {
          version: 1,
          requestId: req.requestId,
          success: true,
          data: req.method === "status" ? { text: `echo:${req.method}` } : { runId: "run-1", ready: false, state: "running" },
        });
      }
    });
    const [st, rs] = await Promise.all([client.status("run-1"), client.result("run-1")]);
    expect(st.text).toBe("echo:status");
    expect(rs).toMatchObject({ runId: "run-1", ready: false });

    // async-complete delivery.
    const completions: unknown[] = [];
    const off = client.onAsyncComplete((payload) => completions.push(payload));
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      runId: "run-1",
      results: [
        { agent: "worker", status: "complete", summary: "done", index: 0, artifactPath: "/tmp/a.md", sessionPath: "/tmp/s.jsonl" },
      ],
    });
    expect(completions).toHaveLength(1);
    expect((completions[0] as { runId: string }).runId).toBe("run-1");
    off();
    client.dispose();
  });

  it("async-complete without results array delivered fail-closed (results: [])", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();
    const completions: Array<{ runId: string; results: unknown[] }> = [];
    const off = client.onAsyncComplete((payload) => completions.push(payload as { runId: string; results: unknown[] }));
    // Live single-child completion omits results entirely.
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-solo", state: "complete" });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ runId: "run-solo", results: [] });
    // Malformed payloads filtered: empty runId, non-array results.
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "", results: [] });
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-x", results: "bogus" });
    events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { noRunId: true });
    expect(completions).toHaveLength(1);
    off();
    client.dispose();
  });

  it("missing reply → RpcTimeoutError", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 20 });
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();
    // No bridge stub: no reply ever arrives.
    await expect(client.ping(20)).rejects.toBeInstanceOf(RpcTimeoutError);
    client.dispose();
  });

  it("error reply → RpcReplyError with code", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 500 });
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw: unknown) => {
      const req = raw as { requestId: string; method: string };
      events.emit(subagentRpcReplyEvent(req.requestId), {
        version: 1,
        requestId: req.requestId,
        success: false,
        error: { code: "not_found", message: "Async result 'nope' not found in active session." },
      });
    });
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();
    const err = await client.result("nope").catch((e) => e);
    expect(err).toBeInstanceOf(RpcReplyError);
    expect((err as RpcReplyError).code).toBe("not_found");
    client.dispose();
  });

  it("dispose during pending send rejects and removes the reply listener", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 5000 });
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();
    const pending = client.ping(5000);
    const settled = pending.then(
      () => { throw new Error("pending send should reject on dispose"); },
      (e) => e,
    );
    const req = events.emitted.find((e) => e.event === SUBAGENT_RPC_REQUEST_EVENT);
    expect(req).toBeDefined();
    const replyEvent = subagentRpcReplyEvent((req!.data as { requestId: string }).requestId);
    expect(events.count(replyEvent)).toBe(1);
    client.dispose();
    const err = await settled;
    expect(err).toBeInstanceOf(RpcNotReadyError);
    expect(events.count(replyEvent)).toBe(0);
  });

  it("dispose while waitReady pending rejects RpcNotReadyError promptly", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 5000 });
    const start = Date.now();
    const pending = client.waitReady(5000);
    const settled = pending.then(
      () => { throw new Error("waitReady should reject on dispose"); },
      (e) => e,
    );
    client.dispose();
    const err = await settled;
    expect(err).toBeInstanceOf(RpcNotReadyError);
    // Prompt: far below the 5s timeout (timer cleared, not left to fire later).
    expect(Date.now() - start).toBeLessThan(1000);
    // No stray timer rejection after dispose: emitting ready later is a no-op.
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await expect(client.waitReady()).rejects.toBeInstanceOf(RpcNotReadyError);
  });

  it("onAsyncComplete disposers do not grow across spawn/complete cycles", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    await client.waitReady();
    const base = client.listenerCount;
    const N = 10;
    for (let i = 0; i < N; i++) {
      const off = client.onAsyncComplete(() => {});
      // Each watch adds exactly one entry while subscribed.
      expect(client.listenerCount).toBe(base + 1);
      events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: `run-${i}`, results: [] });
      off();
    }
    expect(client.listenerCount).toBe(base);
    client.dispose();
  });

  it("run registry maps runId ⇄ AssignmentId with RunRecord", () => {
    const registry = new RunRegistry();
    const assignmentId = aid("a-1");
    registry.register("run-1", assignmentId, makeRunRecord("run-1"));
    expect(registry.lookupByRunId("run-1")?.assignmentId).toBe(assignmentId);
    expect(registry.lookupByAssignmentId(assignmentId)?.runId).toBe("run-1");
    expect(registry.lookupByAssignmentId(assignmentId)?.record.status).toBe("RUNNING");

    expect(registry.updateRecord("run-1", { ...makeRunRecord("run-1"), status: "SUCCEEDED" })).toBe(true);
    expect(registry.lookupByRunId("run-1")?.record.status).toBe("SUCCEEDED");
    expect(registry.updateRecord("missing", makeRunRecord("missing"))).toBe(false);

    expect(registry.removeByRunId("run-1")).toBe(true);
    expect(registry.lookupByRunId("run-1")).toBeUndefined();
    expect(registry.lookupByAssignmentId(assignmentId)).toBeUndefined();
  });
});

describe("SubagentRpcClient ready race (one-shot ready vs construction order)", () => {
  function pingStub(events: FakeEvents): void {
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw: unknown) => {
      const req = raw as { requestId: string; method: string };
      if (req.method !== "ping") return;
      events.emit(subagentRpcReplyEvent(req.requestId), {
        version: 1,
        requestId: req.requestId,
        method: "ping",
        success: true,
        data: { version: 1, methods: ["ping", "spawn"], capabilities: {}, events: {}, session: {} },
      });
    });
  }

  it("(a) ready emitted BEFORE construction: waitReady resolves via ping probe", async () => {
    const events = new FakeEvents();
    pingStub(events);
    events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 });
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });
    expect(client.ready).toBe(false); // one-shot emission missed
    const start = Date.now();
    await client.waitReady(1000);
    expect(client.ready).toBe(true); // probe success set readySeen
    expect(Date.now() - start).toBeLessThan(1000);
    client.dispose();
  });

  it("(b) ready emitted AFTER construction: waitReady resolves via event", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });
    setTimeout(() => events.emit(SUBAGENT_RPC_READY_EVENT, { version: 1 }), 20);
    await client.waitReady(1000);
    expect(client.ready).toBe(true);
    client.dispose();
  });

  it("(c) no bridge at all: waitReady rejects with typed timeout", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 1000 });
    const err = await client.waitReady(30).catch((e) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    client.dispose();
  });

  it("(d) dispose during probe rejects RpcNotReadyError", async () => {
    const events = new FakeEvents();
    const client = new SubagentRpcClient(events, { defaultTimeoutMs: 5000 });
    const start = Date.now();
    const pending = client.waitReady(5000); // probe (1500ms) in flight, no bridge
    client.dispose();
    const err = await pending.then(
      () => { throw new Error("waitReady should reject on dispose"); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(RpcNotReadyError);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
