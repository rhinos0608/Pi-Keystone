// Mutation worker launcher — dispatches assignment to a session with
// mutation tools guarded by worker-guard. Two-phase protocol:
//   1. Acquisition turn (read-only) — reads context, builds plan
//   2. Mutation turn (after authority receipt) — applies changes
//
// Requires a valid MutationLease. Lease validation is performed here;
// worker-guard enforces the policy at tool-call time.

import * as path from "node:path";
import type { ArtifactRef, AssignmentId, ISO8601, MutationLease } from "../domain/types.js";
import type { ToolPolicy } from "./tool-policy.js";
import type { WorkspaceSnapshot } from "../baseline/snapshot.js";
import { conflictMatrix } from "../baseline/snapshot.js";
import type { MutationApproval } from "./approval.js";
import { evaluateApproval } from "./approval.js";
import { advanceLeasePhase, heartbeatLease, type MutationLeaseRecord } from "./mutation-lease.js";
import { recordReceipt, type ReceiptArtifactStore } from "./authority-receipt.js";
import type { ContextView, WorkerDelegation, WorkerReport } from "./read-only-launcher.js";
import {
  ensureKeystoneSessionBridges,
  watchLiveCompletion,
  DEFAULT_LIVE_SESSION_ID,
  SUCCESS_STATUSES,
  type CompletionSink,
  type LiveExecutionResult,
} from "./read-only-launcher.js";
import type { SubagentRpcClient } from "../rpc/subagent-rpc-client.js";
import { RunRegistry } from "../rpc/run-registry.js";
import { redactError } from "../observability/redaction.js";
import type { AsyncCompletePayload } from "../rpc/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Phases of the two-phase mutation protocol. */
export type MutationPhase = "acquisition" | "mutation";

/** The delegation config for a single turn within a mutation session. */
export type MutationTurn = {
  phase: MutationPhase;
  delegation: WorkerDelegation;
};

/** Result of dispatchMutation — two-phase delegations + captured report. */
export type MutationLaunchResult = {
  /** Two delegation configs: acquisition (read-only) then mutation. */
  turns: [acquisition: MutationTurn, mutation: MutationTurn];
  /** The validated lease carried through both turns. */
  lease: MutationLease;
  /** Null until session completes. */
  report: WorkerReport | null;
};

/** Options for dispatchMutation. */
export type DispatchMutationOptions = {
  /**
   * Acquisition-proposed write-set. Required: `allowedCanonicalPaths` must
   * come from the acquisition turn's proposed write-set, never from the
   * planner's targetFiles alone. Must match the lease's allowed paths as a
   * set after canonicalization against the lease root.
   */
  writeSet: string[];
};

// ─── Lease Validation ───────────────────────────────────────────────────────

export type LeaseValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a MutationLease for dispatch.
 * - Must not be expired
 * - Must be in a launchable phase (ACQUIRED or AUTHORITY_READY)
 */
export function validateMutationLease(
  lease: MutationLease,
  now?: Date,
): LeaseValidation {
  const nowMs = now?.getTime() ?? Date.now();

  if (new Date(lease.expiresAt).getTime() <= nowMs) {
    return { ok: false, reason: "lease expired" };
  }

  if (lease.phase !== "ACQUIRED" && lease.phase !== "AUTHORITY_READY") {
    return { ok: false, reason: `lease phase "${lease.phase}" not launchable (need ACQUIRED or AUTHORITY_READY)` };
  }

  return { ok: true };
}

/** Normalize a write-set entry against the lease root; throws when it escapes. */
function canonicalizeAgainstRoot(root: string, entry: string): string {
  const abs = path.isAbsolute(entry) ? path.normalize(entry) : path.join(root, entry);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`write-set entry escapes workspace root: ${entry}`);
  }
  return abs;
}

/**
 * Verify the acquisition write-set matches the lease's allowed paths exactly
 * (set equality after canonicalization). Throws on mismatch or escape.
 */
export function validateWriteSetBinding(lease: MutationLease, writeSet: string[]): void {
  const root = lease.canonicalWorkspaceRoot;
  const actual = new Set(writeSet.map((e) => canonicalizeAgainstRoot(root, e)));
  const allowed = new Set(
    lease.allowedCanonicalPaths.map((e) => canonicalizeAgainstRoot(root, e)),
  );
  const missing = [...allowed].filter((p) => !actual.has(p));
  const excess = [...actual].filter((p) => !allowed.has(p));
  if (missing.length > 0 || excess.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing from write-set: ${missing.sort().join(", ")}`);
    if (excess.length > 0) parts.push(`outside lease scope: ${excess.sort().join(", ")}`);
    throw new Error(`write-set does not match lease allowedCanonicalPaths (${parts.join("; ")})`);
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/** Policy for the acquisition turn — always read-only. */
const ACQUISITION_POLICY: ToolPolicy = { kind: "read-only" };

/** Typed output required from the read-only scope-acquisition child. */
export const MUTATION_ACQUISITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["writeSet"],
  properties: {
    writeSet: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    rationale: { type: "string" },
  },
};

/**
 * Build phase 1 without a lease. Authority cannot exist yet because the exact
 * write-set is the OUTPUT of this read-only acquisition turn.
 */
export function dispatchMutationAcquisition(
  assignment: { id: AssignmentId; description: string; targetFiles: string[] },
  contextView: ContextView,
): WorkerDelegation {
  if (!assignment.id) throw new Error("assignment.id required");
  if (!contextView.goalId) throw new Error("contextView.goalId required");
  if (!contextView.task) throw new Error("contextView.task required");
  const hints = assignment.targetFiles.length > 0
    ? `\nPlanner file hints (non-authoritative): ${assignment.targetFiles.join(", ")}`
    : "";
  return {
    assignmentId: assignment.id,
    task: [
      "Read the repository and determine the exact minimal file write-set required for this assignment.",
      "Do not modify files. Return every file that the mutation turn must be allowed to create or edit.",
      "Paths must be workspace-relative or absolute paths inside the workspace. Do not return directories or globs.",
      `Assignment: ${assignment.description}${hints}`,
    ].join("\n"),
    contextView,
    toolPolicy: ACQUISITION_POLICY,
  };
}

/** Parse and validate the structured output from the acquisition child. */
export function acquisitionWriteSet(payload: AsyncCompletePayload): string[] {
  const rows = payload.results ?? [];
  if (rows.length === 0) throw new Error("acquisition-no-results");
  const failed = rows.find((row) => !SUCCESS_STATUSES.has(String(row.status).toLowerCase()));
  if (failed) throw new Error(`acquisition-child-failed:${failed.summary || failed.status}`);
  const structured = rows.find((row) => row.structuredOutput !== undefined)?.structuredOutput;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("acquisition-missing-structured-output");
  }
  const writeSet = (structured as { writeSet?: unknown }).writeSet;
  if (!Array.isArray(writeSet) || writeSet.length === 0 || writeSet.length > 128) {
    throw new Error("acquisition-invalid-write-set");
  }
  const normalized = [...new Set(writeSet.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error("acquisition-invalid-write-set-entry");
    return entry.trim();
  }))];
  if (normalized.length === 0) throw new Error("acquisition-empty-write-set");
  return normalized;
}

/**
 * Build the mutation policy: structural permit bound to the lease.
 * Textual mode (default) with an empty approved-command list: bash denied.
 */
function mutationPolicy(lease: MutationLease): ToolPolicy {
  return {
    kind: "mutation",
    permit: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
    permitToken: lease.leaseId,
    approvedCommands: [],
  };
}

/**
 * Dispatch an assignment to a mutation worker via two-phase protocol.
 *
 * Phase 1 (acquisition): read-only turn. Worker reads context, builds
 * a mutation plan, and signals readiness.
 *
 * Phase 2 (mutation): mutation tools enabled via worker-guard permit.
 * Only runs after authority receipt (lease phase transitions to
 * AUTHORITY_READY). The worker-guard validates the permit token
 * against the lease before allowing bash/write/edit calls.
 *
 * Throws if lease validation fails, if no acquisition write-set is supplied,
 * or if the write-set does not match the lease's allowedCanonicalPaths.
 * The planner's targetFiles are never consulted for scope — only the
 * acquisition-proposed write-set binds the launch.
 */
export function dispatchMutation(
  assignment: { id: AssignmentId; description: string; targetFiles: string[] },
  contextView: ContextView,
  lease: MutationLease,
  now?: Date,
  options?: DispatchMutationOptions,
): MutationLaunchResult {
  if (!assignment.id) throw new Error("assignment.id required");
  if (!contextView.goalId) throw new Error("contextView.goalId required");
  if (!contextView.task) throw new Error("contextView.task required");
  if (!options || !options.writeSet || options.writeSet.length === 0) {
    throw new Error(
      "acquisition writeSet required: allowedCanonicalPaths must come from the acquisition-proposed write-set, not the planner's targetFiles",
    );
  }

  const validation = validateMutationLease(lease, now);
  if (!validation.ok) {
    throw new Error(`invalid mutation lease: ${validation.reason}`);
  }

  // Verify lease is for this assignment
  if (lease.assignmentId !== assignment.id) {
    throw new Error(
      `lease assignment mismatch: lease=${lease.assignmentId} assignment=${assignment.id}`,
    );
  }

  // Scope binds to the acquisition-proposed write-set, never planner targetFiles.
  validateWriteSetBinding(lease, options.writeSet);

  const baseContext: WorkerDelegation = {
    assignmentId: assignment.id,
    task: assignment.description,
    contextView,
    toolPolicy: ACQUISITION_POLICY,
  };

  return {
    turns: [
      { phase: "acquisition", delegation: { ...baseContext, toolPolicy: ACQUISITION_POLICY } },
      { phase: "mutation", delegation: { ...baseContext, toolPolicy: mutationPolicy(lease) } },
    ],
    lease,
    report: null,
  };
}

// ─── Live execution (Task 7, Wave 3a; authority transport fixed Task 9) ──────

/**
 * Spawn `extensionBindings` namespace carrying the mutation lease.
 *
 * LOAD-BEARING transport contract (verified against pi-subagents sources):
 * - RPC spawn params accept `extensionBindings` (extension/schemas.ts +
 *   launch-contract.ts) and forward it to the child launch.
 * - The ONLY child-side reader channel is the `PI_SUBAGENT_EXTENSION_BINDINGS`
 *   env var, applied via `childProcessEnv` solely when `host === "runner"`
 *   (runs/shared/child-launch.ts `buildInProcessChildLaunch`). Foreground
 *   (`host === "parent"`) children share the parent process and get no env.
 * - RPC spawns are always detached async (client forces `async: true`), which
 *   the background runner launches with `host: "runner"`
 *   (runs/background/runner-child-launch.ts), so the bindings env IS present
 *   in every live mutation child. The child guard reads it via
 *   `parseLeaseFromBindingsEnv`.
 * - Namespace must match pi-subagents `EXTENSION_BINDING_NAMESPACE`
 *   (`name/1` shape, ≤16 namespaces, ≤16KB canonical JSON).
 * - Task-text sentinel transport REMOVED (Round-1 P2): there is no Pi
 *   extension API exposing the child's initial prompt/task text to a child
 *   extension, so a sentinel was never machine-readable live.
 *   `extensionBindings` is the SOLE machine transport. `executeReadOnly`
 *   sends no bindings: read-only children carry no lease by design.
 */
export const KEYSTONE_BINDING_NAMESPACE = "keystone/1";

/** Build the authoritative lease bindings for the mutation spawn.
 *
 * Textual mode carries no bash grant: approvedCommands is empty (bash never
 * allowed) and allowedMcpTools is empty (mcp denied). Values already on the
 * lease are preserved; only absent fields default to empty.
 */
export function authorityBindings(lease: MutationLease): Record<string, unknown> {
  const carried = lease as unknown as { approvedCommands?: unknown; allowedMcpTools?: unknown };
  return {
    [KEYSTONE_BINDING_NAMESPACE]: {
      ...lease,
      approvedCommands: carried.approvedCommands ?? [],
      allowedMcpTools: carried.allowedMcpTools ?? [],
    },
  };
}

export type ExecuteMutationOptions = {
  sessionId?: string;
  agent?: string;
  registry?: RunRegistry;
  /** Bridge registration; defaults to ensureKeystoneSessionBridges. Injected in tests to count calls. */
  ensureBridges?: (sessionId: string) => unknown;
  completion?: CompletionSink;
  /** Called immediately after the mutation child receives its real async run id. */
  onSpawn?: (result: LiveExecutionResult) => void;
  onComplete?: (payload: AsyncCompletePayload) => void;
  /** Observe durable lease phase/heartbeat changes so the goal record mirrors the filesystem lease. */
  onLeaseUpdate?: (lease: MutationLeaseRecord) => void;
  /** Mutation lease renewal window; heartbeats run at roughly one third of this. */
  leaseTtlMs?: number;
  /**
   * Authority gate input. Required when the lease is still ACQUIRED: the
   * gate must advance it to AUTHORITY_READY before any spawn. Ignored once
   * the lease is already AUTHORITY_READY (authority already established).
   */
  authority?: AuthorityGateInput;
};

/** Typed error: an ACQUIRED lease cannot launch; the acquisition turn runs first. */
export class AuthorityNotReadyError extends Error {
  readonly code = "AUTHORITY_NOT_READY";
  constructor(leaseId: string, phase: string) {
    super(
      `mutation launch requires phase AUTHORITY_READY (lease ${leaseId} is ${phase}): acquisition turn required first`,
    );
    this.name = "AuthorityNotReadyError";
  }
}

/** Typed error: the ACQUIRED -> AUTHORITY_READY gate refused to advance. */
export class AuthorityGateError extends Error {
  readonly code = "AUTHORITY_GATE_REJECTED";
  readonly status?: "STALE" | "CONFLICT";
  constructor(reason: string, status?: "STALE" | "CONFLICT") {
    super(`authority gate rejected: ${reason}`);
    this.name = "AuthorityGateError";
    if (status !== undefined) this.status = status;
  }
}

/** Input to the ACQUIRED -> AUTHORITY_READY authority gate. */
export type AuthorityGateInput = {
  goalId: string;
  planEpoch: number;
  currentSnapshot: WorkspaceSnapshot;
  /** Actual write-set about to be delegated (must match the lease scope). */
  writeSet: string[];
  approval?: MutationApproval;
  approvalRef?: ArtifactRef;
  workspaceRoot?: string;
  nowMs?: number;
};

export type AcquireAuthorityResult =
  | { ok: true; lease: MutationLeaseRecord; via: "approval" | "no-conflict"; receiptRef: ArtifactRef }
  | { ok: false; reason: string; status?: "STALE" | "CONFLICT" };

/**
 * Authority gate — the sole production path advancing a mutation lease
 * ACQUIRED -> AUTHORITY_READY (via advanceLeasePhase).
 *
 * - DirtyConflicts (S1 conflictMatrix says the write-set collides with live
 *   dirt): an approval is required and must evaluate APPROVED. A supplied
 *   approval is never silently ignored — STALE/CONFLICT rejects the advance.
 * - No conflicts (conflictMatrix proceeds): approvalRef-less advance, still
 *   gated on a live lease and recorded with an authority receipt.
 * Both paths advance the phase and persist an authorityReceiptRef; only
 * AUTHORITY_READY leases are launchable.
 */
export function acquireAuthority(opts: {
  root: string;
  leaseId: string;
  sessionId: string;
  goalId: string;
  assignmentId: AssignmentId;
  planEpoch: number;
  currentSnapshot: WorkspaceSnapshot;
  actualWriteSet: string[];
  approval?: MutationApproval;
  approvalRef?: ArtifactRef;
  workspaceRoot?: string;
  /** Durable CAS sink for the read-before-write authority receipt. */
  receiptStore?: ReceiptArtifactStore;
  nowMs?: number;
}): AcquireAuthorityResult {
  if (!opts.root) return { ok: false, reason: "root required" };
  if (!opts.leaseId) return { ok: false, reason: "leaseId required" };
  if (!opts.actualWriteSet || opts.actualWriteSet.length === 0) {
    return { ok: false, reason: "actualWriteSet required", status: "CONFLICT" };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const advanceWithReceipt = (): AcquireAuthorityResult => {
    const receiptRef = recordReceipt({
      toolCallId: `authority:${opts.leaseId}:AUTHORITY_READY`,
      resourceIds: [...opts.actualWriteSet].sort(),
      timestamp: nowMs,
      sessionId: opts.sessionId,
    }, opts.receiptStore);
    const advanced = advanceLeasePhase(opts.root, opts.leaseId, "AUTHORITY_READY", nowMs, {
      authorityReceiptRef: receiptRef,
      ...(opts.approvalRef ? { approvalRef: opts.approvalRef } : {}),
    });
    if (!advanced.ok) return { ok: false, reason: advanced.reason };
    return { ok: true, lease: advanced.lease, via: opts.approval ? "approval" : "no-conflict", receiptRef };
  };
  if (opts.approval) {
    const result = evaluateApproval(
      opts.approval,
      opts.currentSnapshot,
      opts.planEpoch,
      opts.actualWriteSet,
      {
        goalId: opts.goalId,
        assignmentId: opts.assignmentId,
        ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
        nowMs,
      },
    );
    if (result.status !== "APPROVED") {
      return { ok: false, reason: `approval ${result.status}: ${result.reason}`, status: result.status };
    }
    return advanceWithReceipt();
  }
  const { conflicts, proceeds } = conflictMatrix(opts.currentSnapshot, opts.actualWriteSet, opts.workspaceRoot ?? opts.root);
  if (!proceeds) {
    return {
      ok: false,
      status: "CONFLICT",
      reason: `DirtyConflicts require approval: ${conflicts.map((c) => `${c.kind}:${c.path}`).join(", ")}`,
    };
  }
  return advanceWithReceipt();
}

/**
 * Live path: spawn the mutation turn via the RPC client with the lease JSON
 * delivered SOLELY via extensionBindings ("keystone/1" namespace).
 * Registers the run and correlates async-complete to AssignmentCompleted.
 * Pure `dispatchMutation` (two-turn value object + writeSet/lease API) is unchanged.
 */
export async function executeMutation(
  lease: MutationLease,
  delegation: WorkerDelegation,
  client: SubagentRpcClient,
  opts?: ExecuteMutationOptions,
): Promise<LiveExecutionResult> {
  const validation = validateMutationLease(lease);
  if (!validation.ok) throw new Error(`invalid mutation lease: ${validation.reason}`);
  if (lease.assignmentId !== delegation.assignmentId) {
    throw new Error(
      `lease assignment mismatch: lease=${lease.assignmentId} assignment=${delegation.assignmentId}`,
    );
  }
  // Authority gate: only AUTHORITY_READY launches. An ACQUIRED lease must
  // first pass acquireAuthority (approval iff DirtyConflicts); any later
  // phase (MUTATING/SETTLING) is already past launchable and rejected.
  let active: MutationLease = lease;
  if (active.phase === "ACQUIRED") {
    const gate = opts?.authority;
    if (!gate) throw new AuthorityNotReadyError(active.leaseId, active.phase);
    validateWriteSetBinding(active, gate.writeSet);
    const result = acquireAuthority({
      root: active.canonicalWorkspaceRoot,
      leaseId: active.leaseId,
      sessionId: active.sessionId,
      goalId: gate.goalId,
      assignmentId: active.assignmentId,
      planEpoch: gate.planEpoch,
      currentSnapshot: gate.currentSnapshot,
      actualWriteSet: gate.writeSet,
      ...(gate.approval ? { approval: gate.approval } : {}),
      ...(gate.approvalRef ? { approvalRef: gate.approvalRef } : {}),
      ...(gate.workspaceRoot ? { workspaceRoot: gate.workspaceRoot } : {}),
      ...(gate.nowMs !== undefined ? { nowMs: gate.nowMs } : {}),
    });
    if (!result.ok) throw new AuthorityGateError(result.reason, result.status);
    active = result.lease;
  }
  if (active.phase !== "AUTHORITY_READY") {
    throw new AuthorityNotReadyError(active.leaseId, active.phase);
  }

  // The child must never run under the pre-mutation phase. Advance first,
  // then immediately renew so the lease carried in extensionBindings has a
  // meaningful execution window instead of the acquisition default TTL.
  const mutating = advanceLeasePhase(active.canonicalWorkspaceRoot, active.leaseId, "MUTATING");
  if (!mutating.ok) throw new Error(`mutation-phase-advance-failed:${mutating.reason}`);
  const leaseTtlMs = Math.max(30_000, opts?.leaseTtlMs ?? 120_000);
  const renewed = heartbeatLease(active.canonicalWorkspaceRoot, active.leaseId, leaseTtlMs);
  if (!renewed) throw new Error("mutation-lease-heartbeat-failed-before-spawn");
  active = renewed;
  opts?.onLeaseUpdate?.(renewed);

  const sessionId = opts?.sessionId ?? active.sessionId ?? DEFAULT_LIVE_SESSION_ID;
  (opts?.ensureBridges ?? ensureKeystoneSessionBridges)(sessionId);
  const spawn = await client.spawn({
    agent: opts?.agent ?? "worker",
    task: delegation.task,
    context: "fresh",
    cwd: active.canonicalWorkspaceRoot,
    extensionBindings: authorityBindings(active),
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

  let heartbeatTimer: NodeJS.Timeout | undefined;
  const heartbeatEveryMs = Math.max(10_000, Math.floor(leaseTtlMs / 3));
  heartbeatTimer = setInterval(() => {
    try {
      const liveLease = heartbeatLease(active.canonicalWorkspaceRoot, active.leaseId, leaseTtlMs);
      if (liveLease) {
        active = liveLease;
        opts?.onLeaseUpdate?.(liveLease);
      } else if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    } catch (err) {
      // Timer callbacks must never surface an uncaught exception. Losing the
      // durable mirror stops renewal so the lease expires fail-closed.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      console.error(`Keystone: mutation lease heartbeat callback failed (${(err as Error)?.message ?? String(err)})`);
    }
  }, heartbeatEveryMs);
  heartbeatTimer.unref?.();

  const onComplete = (payload: AsyncCompletePayload): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    const settling = advanceLeasePhase(active.canonicalWorkspaceRoot, active.leaseId, "SETTLING");
    if (settling.ok) {
      active = settling.lease;
      try {
        opts?.onLeaseUpdate?.(settling.lease);
      } catch (err) {
        // Completion delivery must not be suppressed by mirror bookkeeping.
        console.error(`Keystone: mutation lease settling callback failed (${(err as Error)?.message ?? String(err)})`);
      }
    }
    opts?.onComplete?.(payload);
  };
  watchLiveCompletion(client, runId, opts?.registry, opts?.completion, onComplete);
  return { runId, spawn };
}
