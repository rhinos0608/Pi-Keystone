/**
 * DAG-based scheduler — resolves dependency order for assignments,
 * dispatches independent slices in parallel, collects reports.
 *
 * No reducer edits.
 */

import type { AssignmentId } from "../domain/types.js";
import type { Assignment } from "./assignment.js";
import type { ReportEnvelope } from "./report-envelope.js";

// ─── Scheduled assignment ───────────────────────────────────────────────────

export type ScheduledAssignment = {
  readonly assignment: Assignment;
  readonly dependsOn: readonly AssignmentId[];
};

// ─── DAG node (internal) ────────────────────────────────────────────────────

type Node = {
  id: AssignmentId;
  inDegree: number;
  deps: AssignmentId[];
};

// ─── Scheduling errors ──────────────────────────────────────────────────────

export type ScheduleError =
  | { kind: "DUPLICATE_ID"; id: AssignmentId }
  | { kind: "UNKNOWN_DEPENDENCY"; id: AssignmentId; missing: AssignmentId }
  | { kind: "CYCLE_DETECTED"; cycle: AssignmentId[] };

// ─── Result types ───────────────────────────────────────────────────────────

export type ScheduleResult =
  | { ok: true; layers: AssignmentId[][] }
  | { ok: false; errors: ScheduleError[] };

export type DispatchResult = {
  readonly layerIndex: number;
  readonly assignmentId: AssignmentId;
  readonly report: ReportEnvelope;
};

export type ScheduleFailure = {
  readonly layerIndex: number;
  readonly assignmentId: AssignmentId;
  readonly error: unknown;
};

export class DependencyFailedError extends Error {
  readonly code = "DEPENDENCY_FAILED" as const;
  constructor(
    readonly assignmentId: AssignmentId,
    readonly failedDependencies: readonly AssignmentId[],
  ) {
    super(
      `Assignment ${String(assignmentId)} blocked because dependencies failed: ${failedDependencies.map(String).join(", ")}`,
    );
    this.name = "DependencyFailedError";
  }
}

export type ExecuteScheduleResult =
  | { ok: true; results: DispatchResult[]; failures: [] }
  | { ok: false; results: DispatchResult[]; failures: ScheduleFailure[]; errors?: ScheduleError[] };

// ─── DAG resolution ─────────────────────────────────────────────────────────

/**
 * Topological sort via Kahn's algorithm.
 * Returns layers: groups of nodes that can run in parallel.
 */
function resolveDAG(
  scheduled: readonly ScheduledAssignment[],
): ScheduleResult {
  const errors: ScheduleError[] = [];
  const allIds = new Set<AssignmentId>(scheduled.map((s) => s.assignment.id));

  // Check duplicates
  const seen = new Set<string>();
  for (const s of scheduled) {
    if (seen.has(s.assignment.id)) {
      errors.push({ kind: "DUPLICATE_ID", id: s.assignment.id });
    }
    seen.add(s.assignment.id);
  }
  if (errors.length > 0) return { ok: false, errors };

  // Build nodes + check unknown deps
  const nodeMap = new Map<AssignmentId, Node>();
  for (const s of scheduled) {
    const deps: AssignmentId[] = [];
    for (const d of s.dependsOn) {
      if (!allIds.has(d)) {
        errors.push({ kind: "UNKNOWN_DEPENDENCY", id: s.assignment.id, missing: d });
      }
      deps.push(d);
    }
    nodeMap.set(s.assignment.id, {
      id: s.assignment.id,
      inDegree: deps.length,
      deps,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm — layers
  const layers: AssignmentId[][] = [];
  const remaining = new Map<AssignmentId, Node>(nodeMap);
  const resolved = new Set<AssignmentId>();

  let current = [...remaining.values()]
    .filter((n) => n.inDegree === 0)
    .map((n) => n.id);

  while (current.length > 0) {
    layers.push([...current]);
    for (const id of current) {
      resolved.add(id);
      remaining.delete(id);
    }
    const next: AssignmentId[] = [];
    for (const [, node] of remaining) {
      node.deps = node.deps.filter((d) => !resolved.has(d));
      node.inDegree = node.deps.length;
      if (node.inDegree === 0) next.push(node.id);
    }
    current = next;
  }

  if (remaining.size > 0) {
    const cycleIds = [...remaining.keys()];
    errors.push({ kind: "CYCLE_DETECTED", cycle: cycleIds });
    return { ok: false, errors };
  }

  return { ok: true, layers };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve dependency order for scheduled assignments.
 * Returns layers: groups of AssignmentIds that can execute in parallel.
 */
export function resolveOrder(
  scheduled: readonly ScheduledAssignment[],
): ScheduleResult {
  return resolveDAG(scheduled);
}

/**
 * Execute assignments layer-by-layer. Each layer runs in parallel
 * (Promise.allSettled: one throwing executor never loses sibling results,
 * and later layers still run).
 * `executor` is called per assignment; returns a ReportEnvelope.
 *
 * Result contract: `ok: true` only when every executor succeeded
 * (failures is then empty). Any executor failure yields `ok: false` with
 * the partial results plus per-assignment failures. An unresolvable DAG
 * yields `ok: false` with `errors` (and empty results/failures).
 */
export async function executeSchedule(
  scheduled: readonly ScheduledAssignment[],
  executor: (assignment: Assignment) => Promise<ReportEnvelope>,
): Promise<ExecuteScheduleResult> {
  const order = resolveOrder(scheduled);
  if (!order.ok) return { ok: false, results: [], failures: [], errors: order.errors };

  const byId = new Map<AssignmentId, Assignment>(
    scheduled.map((s) => [s.assignment.id, s.assignment]),
  );
  const depsById = new Map<AssignmentId, readonly AssignmentId[]>(
    scheduled.map((s) => [s.assignment.id, s.dependsOn]),
  );

  const results: DispatchResult[] = [];
  const failures: ScheduleFailure[] = [];
  const failedOrBlocked = new Set<AssignmentId>();

  for (let layerIdx = 0; layerIdx < order.layers.length; layerIdx++) {
    const layer = order.layers[layerIdx];
    // A failed dependency is not merely an ordering concern. Dependents must
    // never execute against missing/partial predecessor work. Independent
    // branches remain runnable, while blocked descendants are recorded
    // explicitly so downstream descendants are blocked transitively.
    const runnable: AssignmentId[] = [];
    for (const id of layer) {
      const failedDeps = [...(depsById.get(id) ?? [])].filter((dep) => failedOrBlocked.has(dep));
      if (failedDeps.length > 0) {
        failures.push({
          layerIndex: layerIdx,
          assignmentId: id,
          error: new DependencyFailedError(id, failedDeps),
        });
        failedOrBlocked.add(id);
      } else {
        runnable.push(id);
      }
    }

    // Sibling-result collection inside the runnable slice: one throwing
    // executor never loses successful sibling evidence.
    const settled = await Promise.allSettled(
      runnable.map(async (id) => {
        const assignment = byId.get(id)!;
        const report = await executor(assignment);
        return { layerIndex: layerIdx, assignmentId: id, report } as DispatchResult;
      }),
    );
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const id = runnable[i]!;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        failures.push({ layerIndex: layerIdx, assignmentId: id, error: outcome.reason });
        failedOrBlocked.add(id);
      }
    }
  }

  if (failures.length > 0) return { ok: false, results, failures };
  return { ok: true, results, failures: [] };
}
