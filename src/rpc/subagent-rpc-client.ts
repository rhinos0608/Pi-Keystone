// SubagentRpcClient — the ONLY Keystone component allowed to emit on
// `subagents:rpc:v1:request`. Speaks pi-subagents RPC over pi.events
// (in-process EventBus).

import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REQUEST_EVENT,
  subagentRpcReplyEvent,
  type AsyncCompleteHandler,
  type AsyncCompletePayload,
  type PingInfo,
  type ResumeResult,
  type RpcEventBus,
  type RpcResult,
  type SpawnParams,
  type SpawnResult,
  type StatusResult,
  type SteerResult,
  type StopResult,
  type SubagentRpcMethod,
  type SubagentRpcReplyEnvelope,
  type SubagentRpcRequestEnvelope,
  RpcNotReadyError,
  RpcReplyError,
  RpcTimeoutError,
} from "./types.js";

export type SteerMode = "steer" | "follow_up" | "auto";

export interface SubagentRpcClientOptions {
  defaultTimeoutMs?: number;
  sourceExtension?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Cap for the active ready-probe ping inside waitReady (ms). */
const READY_PROBE_TIMEOUT_MS = 1500;
let requestCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class SubagentRpcClient {
  private readonly events: RpcEventBus;
  private readonly defaultTimeoutMs: number;
  private readonly sourceExtension?: string;
  private readonly prefix: string;
  private readySeen = false;
  private disposed = false;
  private readonly disposers: Array<() => void> = [];
  private readyWaiters: Array<{ done: () => void; fail: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(events: RpcEventBus, options?: SubagentRpcClientOptions) {
    this.events = events;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sourceExtension = options?.sourceExtension;
    this.prefix = "keystone-";
    const off = this.events.on(SUBAGENT_RPC_READY_EVENT, () => {
      this.markReady();
    });
    if (typeof off === "function") this.disposers.push(off);
  }

  /** Mark ready: set flag + flush waiters (idempotent). */
  private markReady(): void {
    this.readySeen = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.done();
  }

  /**
   * Wait until the bridge signals readiness, via either channel:
   * (1) the one-shot ready event (missed when emitted BEFORE construction
   * — host delivers session_start sequentially, so one load order always
   * misses it), or (2) an active `ping` probe that bypasses the ready
   * gate. Ping success sets readySeen. Probe failure is ignored — the
   * wait continues for the ready event until the overall timeout.
   * Dispose rejects promptly (probe in-flight included).
   */
   waitReady(timeoutMs?: number): Promise<void> {
    if (this.readySeen) return Promise.resolve();
    if (this.disposed) return Promise.reject(new RpcNotReadyError("Client disposed."));
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const entry: { done: () => void; fail: (err: Error) => void; timer: ReturnType<typeof setTimeout> } = {
        done: () => {
          clearTimeout(entry.timer);
          this.readyWaiters = this.readyWaiters.filter((w) => w !== entry);
          resolve();
        },
        fail: (err: Error) => {
          clearTimeout(entry.timer);
          this.readyWaiters = this.readyWaiters.filter((w) => w !== entry);
          reject(err);
        },
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      entry.timer = setTimeout(() => {
        entry.fail(new RpcTimeoutError("waitReady", `Timed out waiting for ${SUBAGENT_RPC_READY_EVENT} after ${ms}ms.`));
      }, ms);
      this.readyWaiters.push(entry);
      // Active probe: catches the missed-ready race (emission before
      // construction). Bypasses the ready gate; success marks ready.
      this.probePing(Math.min(ms, READY_PROBE_TIMEOUT_MS)).then(
        () => {
          if (this.disposed) return;
          this.markReady();
        },
        () => {
          // Ignored: keep waiting for the ready event until timeout.
        },
      );
    });
  }

  /**
   * Raw ping probe: same wire shape as ping() but bypasses the ready
   * gate (ping() rejects when not ready, which would make a readiness
   * probe impossible). Only success proves liveness.
   */
  private probePing(timeoutMs: number): Promise<PingInfo> {
    if (this.disposed) return Promise.reject(new RpcNotReadyError("Client disposed."));
    const requestId = this.nextRequestId();
    const envelope: SubagentRpcRequestEnvelope = {
      version: SUBAGENT_RPC_PROTOCOL_VERSION,
      requestId,
      method: "ping",
      ...(this.sourceExtension ? { source: { extension: this.sourceExtension } } : {}),
    };
    return new Promise<PingInfo>((resolve, reject) => {
      let settled = false;
      const removeDisposer = (fn: () => void) => {
        const i = this.disposers.indexOf(fn);
        if (i >= 0) this.disposers.splice(i, 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        removeDisposer(disposeProbe);
        reject(new RpcTimeoutError(requestId, `Ready probe timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        if (typeof off === "function") off();
      };
      const off = this.events.on(subagentRpcReplyEvent(requestId), (raw: unknown) => {
        if (settled) return;
        const reply = raw as SubagentRpcReplyEnvelope<PingInfo>;
        if (!reply || typeof reply !== "object" || reply.requestId !== requestId) return;
        settled = true;
        cleanup();
        removeDisposer(disposeProbe);
        if (reply.success === true) resolve(reply.data);
        else reject(new RpcReplyError(requestId, reply.error?.code ?? "unknown", reply.error?.message ?? "Probe failed."));
      }) as unknown as () => void;
      const disposeProbe = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new RpcNotReadyError("Client disposed during ready probe."));
      };
      this.disposers.push(disposeProbe);
      this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, envelope);
    });
  }

  get ready(): boolean {
    return this.readySeen;
  }

  /** Test-visible count of active listener disposers. */
  get listenerCount(): number {
    return this.disposers.length;
  }

  ping(timeoutMs?: number): Promise<PingInfo> {
    return this.send<PingInfo>("ping", undefined, timeoutMs);
  }

  spawn(params: SpawnParams, timeoutMs?: number): Promise<SpawnResult> {
    const { async: _ignored, ...rest } = params as SpawnParams & { async?: unknown };
    return this.send<SpawnResult>("spawn", { ...rest, async: true }, timeoutMs);
  }

  status(id: string, timeoutMs?: number): Promise<StatusResult> {
    return this.send<StatusResult>("status", { id }, timeoutMs);
  }

  /** Untargeted status exposes pi-subagents' live fleet projection. */
  statusOverview(timeoutMs?: number): Promise<StatusResult> {
    return this.send<StatusResult>("status", {}, timeoutMs);
  }

  result(runId: string, timeoutMs?: number): Promise<RpcResult> {
    return this.send<RpcResult>("result", { runId }, timeoutMs);
  }

  stop(id: string, timeoutMs?: number): Promise<StopResult> {
    return this.send<StopResult>("stop", { id }, timeoutMs);
  }

  resume(id: string, message: string, timeoutMs?: number): Promise<ResumeResult> {
    return this.send<ResumeResult>("resume", { id, message }, timeoutMs);
  }

  steer(id: string, message: string, mode?: SteerMode, timeoutMs?: number): Promise<SteerResult> {
    return this.send<SteerResult>(
      "steer",
      mode === undefined ? { id, message } : { id, message, mode },
      timeoutMs,
    );
  }

  onAsyncComplete(handler: AsyncCompleteHandler): () => void {
    const wrapped = (raw: unknown) => {
      // Fail-closed filter: runId identity required; results array optional
      // (live single-child completions emit conditionally). Absent results
      // normalize to [] so downstream status derivation yields FAILED.
      if (!isRecord(raw) || typeof raw.runId !== "string" || raw.runId.length === 0) return;
      if (raw.results !== undefined && !Array.isArray(raw.results)) return;
      handler({ ...raw, results: Array.isArray(raw.results) ? raw.results : [] } as AsyncCompletePayload);
    };
    const off = this.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, wrapped);
    const dispose = () => {
      if (typeof off === "function") off();
      const i = this.disposers.indexOf(dispose);
      if (i >= 0) this.disposers.splice(i, 1);
    };
    this.disposers.push(dispose);
    return dispose;
  }

  dispose(): void {
    this.disposed = true;
    const ready = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of ready) w.fail(new RpcNotReadyError("Client disposed."));
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch {
        // ignore listener-cleanup failures
      }
    }
  }

  private nextRequestId(): string {
    requestCounter += 1;
    const rand = Math.random().toString(36).slice(2, 10).replace(/[^A-Za-z0-9]/g, "x");
    return `${this.prefix}${Date.now().toString(36)}-${requestCounter}-${rand}`;
  }

  private send<T>(method: SubagentRpcMethod, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) return Promise.reject(new RpcNotReadyError("Client disposed."));
    if (!this.readySeen) return Promise.reject(new RpcNotReadyError());
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    const requestId = this.nextRequestId();
    const envelope: SubagentRpcRequestEnvelope = {
      version: SUBAGENT_RPC_PROTOCOL_VERSION,
      requestId,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(this.sourceExtension ? { source: { extension: this.sourceExtension } } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      // Disposer registered immediately so dispose() cleans in-flight sends.
      // Removed on settle; on dispose it rejects the pending promise.
      let disposeSend: () => void = () => {};
      const removeDisposer = () => {
        const i = this.disposers.indexOf(disposeSend);
        if (i >= 0) this.disposers.splice(i, 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        removeDisposer();
        reject(new RpcTimeoutError(requestId, `RPC ${method} timed out after ${ms}ms (requestId ${requestId}).`));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        if (typeof off === "function") off();
      };
      const off = this.events.on(subagentRpcReplyEvent(requestId), (raw: unknown) => {
        if (!isRecord(raw)) return;
        const reply = raw as SubagentRpcReplyEnvelope<T>;
        if (reply.requestId !== requestId) return;
        // Malformed reply without success flag: keep waiting until timeout.
        if (reply.success !== true && reply.success !== false) return;
        if (settled) return;
        settled = true;
        cleanup();
        removeDisposer();
        if (reply.success === true) {
          resolve(reply.data);
        } else {
          reject(new RpcReplyError(requestId, String(reply.error?.code ?? "unknown"), String(reply.error?.message ?? "RPC request failed.")));
        }
      });
      disposeSend = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new RpcNotReadyError("Client disposed during send."));
      };
      this.disposers.push(disposeSend);
      this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, envelope);
    });
  }
}
