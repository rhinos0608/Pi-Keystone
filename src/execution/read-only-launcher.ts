// Read-only worker launcher — dispatches assignment to a fresh session
// with NO mutation tools (no bash, write, edit). Uses pi-subagents
// delegation pattern: builds config, caller passes to agent spawner.

import type { ArtifactRef, AssignmentId, GoalEvent, GoalId, ISO8601 } from "../domain/types.js";
import type { ToolPolicy } from "./tool-policy.js";
import { dispatchEvent as lifecycleDispatch, type ReceiptLog } from "../runtime/lifecycle.js";
import { GoalStore } from "../store/goal-store.js";
import type { SubagentRpcClient } from "../rpc/subagent-rpc-client.js";
import { RunRegistry } from "../rpc/run-registry.js";
import type { AsyncCompletePayload, SpawnResult } from "../rpc/types.js";
export type { AsyncCompletePayload };
import { ensureKeystoneSessionBridges } from "../rpc/subagents-bridge.js";
import { redactError } from "../observability/redaction.js";
export { ensureKeystoneSessionBridges };
import {
  executeSchedule,
  resolveOrder,
  type DispatchResult,
  type ExecuteScheduleResult,
  type ScheduledAssignment,
  type ScheduleFailure,
} from "./scheduler.js";
import type { Assignment } from "./assignment.js";
import type { ReportEnvelope } from "./report-envelope.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal goal context the worker can see. */
export type ContextView = {
  goalId: string;
  task: string;
  workspace: string;
  targetFiles: string[];
};

/** What gets sent to the fresh session as a delegation request. */
export type WorkerDelegation = {
  assignmentId: AssignmentId;
  task: string;
  toolPolicy: ToolPolicy;
  contextView: ContextView;
};

/** Captured output from a completed worker session. */
export type WorkerReport = {
  outcome: "succeeded" | "failed" | "cancelled";
  summary: string;
  artifacts: string[];
};

/** Result of dispatchReadOnly — the delegation config + captured report. */
export type ReadOnlyLaunchResult = {
  delegation: WorkerDelegation;
  report: WorkerReport | null;
};

// ─── Policy ─────────────────────────────────────────────────────────────────

/** Read-only policy: denies bash, write, edit, mcp via tool-policy.ts. */
export const READ_ONLY_POLICY: ToolPolicy = { kind: "read-only" };

// ─── Live execution (Task 7, Wave 3a) ───────────────────────────────────────

/** Authority transport: extensionBindings ONLY (bindings env is the sole channel). */
// NOTE: task-text sentinel transport removed (Round-1 P2). Lease JSON travels
// ONLY via extensionBindings ("keystone/1" namespace) into PI_SUBAGENT_EXTENSION_BINDINGS.

/** Default session id when the host supplies none. */
export const DEFAULT_LIVE_SESSION_ID = "keystone:default-session";

/** Sink misconfigured: neither store nor dispatch seam set, or ref minter missing. */
export class CompletionSinkError extends Error {
  readonly code = "COMPLETION_SINK" as const;
  constructor(reason: string) {
    super(`Completion sink cannot dispatch: ${reason}`);
    this.name = "CompletionSinkError";
  }
}

/** Where an AssignmentCompleted goes once the child finishes. */
export type CompletionSink = {
  goalId: GoalId;
  assignmentId: AssignmentId;
  /** Fence captured at spawn; refreshed from the store at completion time. */
  driverFence: number;
  /** Mint the report ArtifactRef from the async-complete payload. Required for real dispatch. */
  reportRefFor?: (payload: AsyncCompletePayload) => ArtifactRef;
  /** Mint the error ArtifactRef for a FAILED child. Optional: AssignmentFailed carries errorRef?. */
  errorRefFor?: (payload: AsyncCompletePayload) => ArtifactRef | undefined;
  /** Real store dispatch (default path). */
  store?: GoalStore;
  receiptLog?: ReceiptLog;
  /** Test/embedding seam: bypass the store. */
  dispatch?: (event: GoalEvent) => unknown;
  onError?: (err: unknown) => void;
};

export type LiveExecutionOptions = {
  sessionId?: string;
  agent?: string;
  cwd?: string;
  /** Optional typed output contract forwarded to the async child. */
  structuredOutputSchema?: Record<string, unknown>;
  registry?: RunRegistry;
  /** Bridge registration; defaults to ensureKeystoneSessionBridges. Injected in tests to count calls. */
  ensureBridges?: (sessionId: string) => unknown;
  completion?: CompletionSink;
  /** Called immediately after a real async run id is allocated. */
  onSpawn?: (result: LiveExecutionResult) => void;
  onComplete?: (payload: AsyncCompletePayload) => void;
};

export type LiveExecutionResult = {
  runId: string;
  spawn: SpawnResult;
};

export const SUCCESS_STATUSES = new Set(["complete", "completed", "success", "succeeded", "ok"]);

/** Best-effort terminal status from async-complete child results.
 * Fail-closed: missing/empty results -> FAILED. Live single-child
 * completions may omit the results array entirely. */
export function completionStatusOf(
  payload: Pick<AsyncCompletePayload, "runId"> & { results?: AsyncCompletePayload["results"] },
): "SUCCEEDED" | "FAILED" {
  const results = payload.results ?? [];
  const ok =
    results.length > 0 &&
    results.every((r) => SUCCESS_STATUSES.has(String(r.status).toLowerCase()));
  return ok ? "SUCCEEDED" : "FAILED";
}

/**
 * Build the completion event from the child payload: AssignmentFailed when
 * completionStatusOf(payload) === "FAILED" (errorRef minted when available,
 * optional otherwise), else AssignmentCompleted (reportRef required).
 */
function buildCompletionEvent(sink: CompletionSink, payload: AsyncCompletePayload): GoalEvent {
  // Pinned fence: the spawn-captured token is authoritative. Lease rotation
  // invalidates old child completions — never re-read a fresh token here.
  const driverFence = sink.driverFence;
  if (completionStatusOf(payload) === "FAILED") {
    const errorRef = sink.errorRefFor?.(payload);
    return errorRef === undefined
      ? { type: "AssignmentFailed", assignmentId: sink.assignmentId, driverFence }
      : { type: "AssignmentFailed", assignmentId: sink.assignmentId, errorRef, driverFence };
  }
  const reportRef = sink.reportRefFor?.(payload);
  if (!reportRef) throw new CompletionSinkError("reportRefFor required to dispatch AssignmentCompleted");
  return { type: "AssignmentCompleted", assignmentId: sink.assignmentId, reportRef, driverFence };
}

function dispatchCompletion(sink: CompletionSink, payload: AsyncCompletePayload): void {
  try {
    if (sink.dispatch) {
      // Test/embedding seam: no store, so no lease to check against — but
      // the pinned fence must still ride the event. A seam event missing
      // driverFence (or carrying a non-pinned token) fails typed instead of
      // dispatching an unfenced completion.
      const event = buildCompletionEvent({ ...sink, store: undefined }, payload);
      const fence = (event as { driverFence?: unknown }).driverFence;
      if (typeof fence !== "number" || fence !== sink.driverFence) {
        throw new CompletionSinkError(
          `seam dispatch fence mismatch: event carries ${String(fence)}, pinned ${String(sink.driverFence)}`,
        );
      }
      sink.dispatch(event);
    } else if (sink.store) {
      // Pinned fence, no retry: on CAS conflict the completion dispatch fails
      // typed. A re-read token could belong to a rotated lease, which must
      // invalidate (not rescue) this stale child completion.
      const event = buildCompletionEvent(sink, payload);
      lifecycleDispatch(sink.store, sink.goalId, event, sink.receiptLog ?? []);
    } else {
      throw new CompletionSinkError("no dispatch target: set store or dispatch");
    }
  } catch (err) {
    const safe = redactError(err);
    if (!sink.onError) throw safe;
    sink.onError(safe);
  }
}

/**
 * Watch async-complete for one run; update the registry and dispatch
 * AssignmentCompleted via the sink. Returns the unwatch function.
 */
export function watchLiveCompletion(
  client: Pick<SubagentRpcClient, "onAsyncComplete">,
  runId: string,
  registry: RunRegistry | undefined,
  sink: CompletionSink | undefined,
  onComplete?: (payload: AsyncCompletePayload) => void,
): () => void {
  if (!sink && !onComplete) return () => {};
  let unwatch: (() => void) | undefined;
  unwatch = client.onAsyncComplete((payload) => {
    if (payload.runId !== runId) return;
    // One-shot: consume only the first matching payload.
    unwatch?.();
    const reg = registry?.lookupByRunId(runId);
    if (reg) {
      registry?.updateRecord(runId, {
        ...reg.record,
        status: completionStatusOf(payload),
        endedAt: new Date().toISOString() as ISO8601,
      });
      registry?.removeByRunId(runId);
    }
    if (sink) dispatchCompletion(sink, payload);
    onComplete?.(payload);
  });
  return () => {
    unwatch?.();
  };
}

/**
 * Live path: spawn a read-only child via the RPC client, register the run,
 * and correlate async-complete back to AssignmentCompleted.
 * Pure `dispatchReadOnly` (delegation value object) is unchanged.
 */
export async function executeReadOnly(
  delegation: WorkerDelegation,
  client: SubagentRpcClient,
  opts?: LiveExecutionOptions,
): Promise<LiveExecutionResult> {
  const sessionId = opts?.sessionId ?? DEFAULT_LIVE_SESSION_ID;
  (opts?.ensureBridges ?? ensureKeystoneSessionBridges)(sessionId);
  const structuredCompletionInstruction = opts?.structuredOutputSchema
    ? [
        "",
        "IMPORTANT: this run requires structured output.",
        'Finish by calling the structured_output tool with arguments exactly shaped as {"value": <object matching the provided output schema>}.',
        "Do not wrap the object in acceptanceReport or any other extra key, and do not finish with prose alone.",
      ].join("\n")
    : "";
  const spawn = await client.spawn({
    // Use a real pi-subagents builtin by default. Do not send a model:
    // pi-subagents resolves user/project settings.json role overrides, while
    // the parent Pi session keeps its own orchestrator model.
    agent: opts?.agent ?? "scout",
    task: delegation.task + structuredCompletionInstruction,
    // Keystone children are independent evidence/execution sessions. Agent
    // defaults such as oracle/worker=fork must not silently inherit the
    // orchestrator conversation and undermine fresh-review guarantees.
    context: "fresh",
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts?.structuredOutputSchema !== undefined
      ? { outputSchema: opts.structuredOutputSchema }
      : {}),
  }).catch((err) => {
    throw redactError(err);
  });
  const runId = spawn.details.runId;
  opts?.onSpawn?.({ runId, spawn });
  opts?.registry?.register(runId, delegation.assignmentId, {
    runId,
    sessionId,
    status: "RUNNING",
    startedAt: new Date().toISOString() as ISO8601,
  });
  watchLiveCompletion(client, runId, opts?.registry, opts?.completion, opts?.onComplete);
  return { runId, spawn };
}

// ─── Orchestrated frontier execution (prod wiring) ──────────────────────────

/**
 * Orchestrator-level frontier runner: the production path that keeps the
 * goal frontier honest.
 * 0. Pre-validates the DAG via resolveOrder: DUPLICATE/CYCLE/UNKNOWN
 *    dispatches BlockDeclared (fresh fence) and returns ok:false with errors
 *    instead of hanging the goal in EXECUTING.
 * 1. Dispatches ExecutionStarted with the FULL DAG from the scheduled plan
 *    (assignments payload becomes the required frontier + opens ACQUIRED /
 *    RUNNING runs via the reducer dispatch boundary).
 * 2. Runs executeSchedule (layer-by-layer, Promise.allSettled sibling
 *    collection; ok:false semantics preserved).
 * 3. Dispatches per-result AssignmentCompleted / AssignmentFailed with the
 *    PINNED spawn fence (startFence, no fresh re-read, no CAS retry — lease
 *    rotation invalidates old completions; CAS conflicts fail typed).
 *
 * Report/error refs come from caller-supplied minters (the orchestrator
 * owns artifact persistence; this runner only maps results to events).
 */
export type FrontierRunnerOptions = {
  contractVersion: number;
  executionPlanRef: ArtifactRef;
  reportRefFor: (assignmentId: AssignmentId, report: ReportEnvelope) => ArtifactRef;
  errorRefFor?: (assignmentId: AssignmentId, error: unknown) => ArtifactRef | undefined;
  receiptLog?: ReceiptLog;
};

export async function runExecutionFrontier(
  store: GoalStore,
  goalId: GoalId,
  scheduled: readonly ScheduledAssignment[],
  executor: (assignment: Assignment) => Promise<ReportEnvelope>,
  opts: FrontierRunnerOptions,
): Promise<ExecuteScheduleResult> {
  const started = store.get(goalId);
  if (!started) throw new Error(`Goal ${goalId} not found`);
  const startFence = started.activeDriverLease?.fencingToken ?? started.driverFenceCounter;
  // DAG pre-validation: an unresolvable DAG must not hang the goal in
  // EXECUTING. Block the goal (fresh fence) instead of silently returning.
  const dagOrder = resolveOrder(scheduled);
  if (!dagOrder.ok) {
    try {
      lifecycleDispatch(
        store,
        goalId,
        { type: "BlockDeclared", blockerRefs: [], driverFence: startFence },
        opts.receiptLog ?? [],
      );
    } catch (err) {
      const setupFailure = {
        layerIndex: 0,
        assignmentId: (scheduled[0]?.assignment.id ?? "setup") as AssignmentId,
        error: redactError(err),
      };
      return { ok: false, results: [], failures: [setupFailure], errors: dagOrder.errors };
    }
    return { ok: false, results: [], failures: [], errors: dagOrder.errors };
  }
  try {
    lifecycleDispatch(
      store,
      goalId,
      {
        type: "ExecutionStarted",
        contractVersion: opts.contractVersion,
        executionPlanRef: opts.executionPlanRef,
        driverFence: startFence,
        assignments: scheduled.map((s) => ({ id: s.assignment.id, dependsOn: [...s.dependsOn] })),
      },
      opts.receiptLog ?? [],
    );
  } catch (err) {
    const setupFailure = {
      layerIndex: 0,
      assignmentId: (scheduled[0]?.assignment.id ?? "setup") as AssignmentId,
      error: redactError(err),
    };
    return { ok: false, results: [], failures: [setupFailure] };
  }

  const scheduledResult = await executeSchedule(scheduled, executor);

  // Pinned fence (startFence), no CAS retry: lease rotation invalidates old
  // completions. Per-result dispatch is fail-open per item: a dispatch
  // throw (e.g. stale fence) is recorded as a ScheduleFailure and the loop
  // CONTINUES — every assignment ends either dispatched or recorded as a
  // failed run, so the goal never wedges in EXECUTING with silent ACQUIRED
  // slots. Any dispatch failure forces ok:false.
  const dispatchedResults: DispatchResult[] = [];
  const dispatchFailures: ScheduleFailure[] = [];

  for (const r of scheduledResult.results) {
    try {
      lifecycleDispatch(
        store,
        goalId,
        {
          type: "AssignmentCompleted",
          assignmentId: r.assignmentId,
          reportRef: opts.reportRefFor(r.assignmentId, r.report),
          driverFence: startFence,
        },
        opts.receiptLog ?? [],
      );
      dispatchedResults.push(r);
    } catch (err) {
      dispatchFailures.push({ layerIndex: r.layerIndex, assignmentId: r.assignmentId, error: redactError(err) });
    }
  }
  for (const f of scheduledResult.failures) {
    try {
      const errorRef = opts.errorRefFor?.(f.assignmentId, f.error);
      lifecycleDispatch(
        store,
        goalId,
        errorRef === undefined
          ? { type: "AssignmentFailed", assignmentId: f.assignmentId, driverFence: startFence }
          : { type: "AssignmentFailed", assignmentId: f.assignmentId, errorRef, driverFence: startFence },
        opts.receiptLog ?? [],
      );
      // Executor failure recorded as a failed run (dispatched AssignmentFailed).
      dispatchFailures.push(f);
    } catch (err) {
      dispatchFailures.push({ layerIndex: f.layerIndex, assignmentId: f.assignmentId, error: redactError(err) });
    }
  }
  if (dispatchFailures.length > 0) return { ok: false, results: dispatchedResults, failures: dispatchFailures };
  return scheduledResult;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Dispatch an assignment to a read-only worker in a fresh session.
 *
 * The worker receives NO mutation tools — only reading is permitted.
 * Returns the delegation config (caller passes to agent spawner) and
 * a null report (populated after the session completes).
 *
 * Throws if inputs are invalid.
 */
export function dispatchReadOnly(
  assignment: { id: AssignmentId; description: string; targetFiles: string[] },
  contextView: ContextView,
): ReadOnlyLaunchResult {
  if (!assignment.id) throw new Error("assignment.id required");
  if (!contextView.goalId) throw new Error("contextView.goalId required");
  if (!contextView.task) throw new Error("contextView.task required");

  return {
    delegation: {
      assignmentId: assignment.id,
      task: assignment.description,
      toolPolicy: READ_ONLY_POLICY,
      contextView,
    },
    report: null,
  };
}
