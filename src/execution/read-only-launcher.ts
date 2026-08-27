// Read-only worker launcher — dispatches assignment to a fresh session
// with NO mutation tools (no bash, write, edit). Uses pi-subagents
// delegation pattern: builds config, caller passes to agent spawner.

import type { AssignmentId } from "../domain/types.js";
import type { ToolPolicy } from "./tool-policy.js";

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
