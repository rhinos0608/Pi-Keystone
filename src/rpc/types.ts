// RPC envelope + payload types for pi-subagents in-process EventBus RPC.
// Keystone owns only the client side; the bridge lives in pi-subagents.

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export const SUBAGENT_RPC_METHODS = [
  "ping",
  "status",
  "manage",
  "spawn",
  "steer",
  "interrupt",
  "stop",
  "resume",
  "result",
] as const;
export type SubagentRpcMethod = (typeof SUBAGENT_RPC_METHODS)[number];

/** Minimal EventBus surface (pi.events). */
export interface RpcEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export type SubagentRpcErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "unsupported_version"
  | "unsupported_method"
  | "no_active_session"
  | "execution_failed"
  | "not_found"
  | "invalid_state";

export interface SubagentRpcRequestEnvelope {
  version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
  requestId: string;
  method: SubagentRpcMethod;
  params?: unknown;
  source?: {
    extension?: string;
    [key: string]: unknown;
  };
}

export type SubagentRpcReplyEnvelope<T = unknown> =
  | {
      version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
      requestId: string;
      method?: SubagentRpcMethod;
      success: true;
      data: T;
    }
  | {
      version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
      requestId: string;
      method?: SubagentRpcMethod;
      success: false;
      error: {
        code: SubagentRpcErrorCode | string;
        message: string;
      };
    };

export function subagentRpcReplyEvent(requestId: string): string {
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

// ─── Method payloads ────────────────────────────────────────────────────────

export interface PingInfo {
  version: number;
  methods: string[];
  capabilities: Record<string, unknown>;
  events: Record<string, unknown>;
  session: Record<string, unknown>;
  [key: string]: unknown;
}

/** Validated spawn-param subset (async forced true by client). */
export interface SpawnParams {
  agent: string;
  task?: string;
  model?: string;
  context?: string;
  cwd?: string;
  toolBudget?: unknown;
  timeoutMs?: number;
  /** pi-subagents public execution contract field. */
  outputSchema?: Record<string, unknown>;
  extensionBindings?: unknown;
  worktree?: unknown;
  workflowScript?: string;
  workflowScriptPath?: string;
  [key: string]: unknown;
}

export interface SpawnDetails {
  mode: string;
  asyncId: string;
  asyncDir: string;
  runId: string;
  [key: string]: unknown;
}

export interface SpawnResult {
  text: string;
  details: SpawnDetails;
  isError?: boolean;
  [key: string]: unknown;
}

export interface TextDetailsResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  fleet?: unknown;
  asyncSnapshot?: unknown;
  [key: string]: unknown;
}

export type StatusResult = TextDetailsResult;
export type StopResult = TextDetailsResult & {
  runId?: string;
  state?: string;
};
export type ResumeResult = TextDetailsResult;
export type SteerResult = TextDetailsResult;

export type RpcTerminalState = "complete" | "failed" | "paused" | "stopped" | "rejected";
export type RpcResult =
  | { runId: string; ready: false; state: string }
  | {
      runId: string;
      ready: true;
      state: RpcTerminalState;
      outcome: "success" | "failure" | "paused" | "stopped";
      output: string;
      outputAvailable: boolean;
      outputTruncated: boolean;
    };

export interface AsyncCompleteChildResult {
  agent: string;
  status: string;
  summary: string;
  index: number;
  artifactPath?: string;
  sessionPath?: string;
  structuredOutput?: unknown;
  structuredOutputPath?: string;
  [key: string]: unknown;
}

export interface AsyncCompletePayload {
  runId: string;
  results: AsyncCompleteChildResult[];
  [key: string]: unknown;
}

export type AsyncCompleteHandler = (payload: AsyncCompletePayload) => void;

// ─── Typed errors ───────────────────────────────────────────────────────────

export class RpcTimeoutError extends Error {
  readonly requestId: string;
  constructor(requestId: string, message?: string) {
    super(message ?? `RPC request timed out: ${requestId}`);
    this.name = "RpcTimeoutError";
    this.requestId = requestId;
  }
}

export class RpcReplyError extends Error {
  readonly code: string;
  readonly requestId: string;
  constructor(requestId: string, code: string, message: string) {
    super(message);
    this.name = "RpcReplyError";
    this.requestId = requestId;
    this.code = code;
  }
}

export class RpcNotReadyError extends Error {
  constructor(message = "Subagent RPC bridge not ready; call waitReady() first.") {
    super(message);
    this.name = "RpcNotReadyError";
  }
}
