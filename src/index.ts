// Extension entrypoint — wired by P4-INT, Phase 6 integration.
// Registers /goal command, lifecycle hooks, context compiler,
// execution schedulers, worker guard, exports public API.

import type { GoalRecord, GoalId, GoalEvent, GoalState } from "./domain/types.js";
import { createGoalRecord, validateTransition } from "./domain/goal-record.js";
import { GoalStore } from "./store/goal-store.js";
import {
  dispatchEvent,
  startGoal,
  getGoalState,
  isTerminal,
  type ReceiptLog,
  type ReceiptEntry,
} from "./runtime/lifecycle.js";
import {
  buildContinuationContext,
  resumeAfterCompaction,
  type ContinuationContext,
} from "./continuation.js";

// ─── Phase 6 imports ───────────────────────────────────────────────────────

import { compileContext, issueAuthority } from "./context/compiler.js";
import { projectGoalStoreView } from "./context/projections.js";
import type { ProjectionRole, GoalProjection } from "./context/projections.js";
import { registerWorkerGuard } from "./execution/worker-guard.js";
import type { WorkerGuard, GuardResult } from "./execution/worker-guard.js";
import { dispatchReadOnly, type ContextView } from "./execution/read-only-launcher.js";
import type { ReadOnlyLaunchResult } from "./execution/read-only-launcher.js";
import { dispatchMutation } from "./execution/mutation-launcher.js";
import type { MutationLaunchResult } from "./execution/mutation-launcher.js";
import { acquireLease, releaseLease, checkLease } from "./execution/mutation-lease.js";
import { enforceToolPolicy } from "./execution/tool-policy.js";
import type { ToolPolicy, ToolPolicyKind } from "./execution/tool-policy.js";
import type { ContextRole, GoalContextView, CompilerConfig } from "./context/types.js";
import type { AssignmentId } from "./domain/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type KeystoneConfig = {
  dataDir: string;
};

export type GoalCommandHandler = {
  create(opts: {
    goalId: GoalId;
    userTask: string;
    workspace: GoalRecord["workspace"];
    startRevision: GoalRecord["startRevision"];
  }): GoalRecord;
  get(goalId: GoalId): GoalRecord | undefined;
  list(): GoalRecord[];
  delete(goalId: GoalId): boolean;
};

export type LifecycleHooks = {
  session_start(): void;
  agent_settled(goalId: GoalId): void;
  session_before_compact(goalId: GoalId): ContinuationContext | null;
};

// ─── Factory ────────────────────────────────────────────────────────────────

export function createKeystone(config: KeystoneConfig) {
  const store = new GoalStore(config.dataDir);
  const receiptLog: ReceiptLog = [];

  // /goal command handler
  const goal: GoalCommandHandler = {
    create({ goalId, userTask, workspace, startRevision }) {
      const record = createGoalRecord(goalId, userTask, workspace, startRevision);
      return startGoal(store, goalId, record, receiptLog);
    },
    get(goalId) {
      return getGoalState(store, goalId);
    },
    list() {
      return store.list();
    },
    delete(goalId) {
      return store.delete(goalId);
    },
  };

  // Lifecycle hooks
  const hooks: LifecycleHooks = {
    session_start() {
      // Reconcile any goals left in non-terminal states from prior sessions
      const goals = store.list();
      for (const g of goals) {
        if (g.state !== "DONE" && g.state !== "CANCELLED") {
          // Flag for recovery on next interaction
          store.update(g.goalId, { type: "ResumeRequested" });
        }
      }
    },
    agent_settled(goalId) {
      const record = store.get(goalId);
      if (!record) return;
      if (record.state === "DONE" || record.state === "CANCELLED") return;
      // Persist current state after agent completes work
      store.get(goalId); // touch for consistency
    },
    session_before_compact(goalId) {
      return resumeAfterCompaction(store, goalId);
    },
  };

  return {
    goal,
    hooks,
    store,
    receiptLog,
    dispatchEvent(
      goalId: GoalId,
      event: GoalEvent,
      reducer?: (event: GoalEvent, record: GoalRecord) => GoalRecord,
    ) {
      return dispatchEvent(store, goalId, event, receiptLog, reducer);
    },
    resume(goalId: GoalId) {
      return resumeAfterCompaction(store, goalId);
    },
    isTerminal(goalId: GoalId): boolean {
      const record = store.get(goalId);
      return record ? isTerminal(record) : false;
    },

    // ─── Phase 6: Context compiler ──────────────────────────────────────
    compileContext,
    projectGoalStoreView,

    // ─── Phase 6: Execution schedulers ──────────────────────────────────
    dispatchReadOnly,
    dispatchMutation,
    acquireLease,
    releaseLease,
    checkLease,

    // ─── Phase 6: Worker guard ──────────────────────────────────────────
    registerWorkerGuard,

    // ─── Phase 6: Authority & tool policy ───────────────────────────────
    enforceToolPolicy,
    issueAuthority,
  };
}

// ─── Public API re-exports ──────────────────────────────────────────────────

export type {
  GoalRecord,
  GoalId,
  GoalEvent,
  GoalState,
} from "./domain/types.js";

export { createGoalRecord, validateTransition } from "./domain/goal-record.js";
export { GoalStore, goalReducer } from "./store/goal-store.js";
export { dispatchEvent as lifecycleDispatch, startGoal as lifecycleStart, getGoalState as lifecycleGet, isTerminal as lifecycleIsTerminal } from "./runtime/lifecycle.js";
export { buildContinuationContext, resumeAfterCompaction } from "./continuation.js";

// Phase 6 re-exports
export { compileContext, issueAuthority } from "./context/compiler.js";
export { projectGoalStoreView } from "./context/projections.js";
export type { ContextRole, GoalContextView, CompilerConfig } from "./context/types.js";
export type { ProjectionRole, GoalProjection } from "./context/projections.js";
export { registerWorkerGuard } from "./execution/worker-guard.js";
export type { WorkerGuard, GuardResult } from "./execution/worker-guard.js";
export { dispatchReadOnly } from "./execution/read-only-launcher.js";
export type { ReadOnlyLaunchResult, ContextView } from "./execution/read-only-launcher.js";
export { dispatchMutation, validateMutationLease } from "./execution/mutation-launcher.js";
export type { MutationLaunchResult } from "./execution/mutation-launcher.js";
export { acquireLease, releaseLease, checkLease } from "./execution/mutation-lease.js";
export { enforceToolPolicy } from "./execution/tool-policy.js";
export type { ToolPolicy, ToolPolicyKind } from "./execution/tool-policy.js";
