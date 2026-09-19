// Production goal preparation flow — baseline -> snapshot (S0) -> planning.
//
// Sequential composition over existing primitives only:
//   captureEcosystemBaseline -> captureSnapshot -> runPlanning.
// Dispatches NO events itself (no fabricated transitions): the caller persists
// returned artifact refs via controller dispatch (PreparationProgress etc.)
// and hands plan+refs to runExecution through the controller plan cache.

import { createHash } from "node:crypto";
import type {
  ArtifactRef,
  GoalRecord,
  ISO8601,
  RevisionRef,
  SnapshotId,
} from "../domain/types.js";
import {
  captureEcosystemBaseline,
  type CaptureEcosystemBaselineOptions,
} from "../baseline/orchestrator.js";
import type {
  BaselineRecord,
  CheckRecord,
  DirtyPath,
  EcosystemBaseline,
} from "../baseline/types.js";
import { CheckOutcome } from "../baseline/types.js";
import {
  captureSnapshot,
  type WorkspaceSnapshot,
} from "../baseline/snapshot.js";
import {
  runPlanning,
} from "../planning/orchestrator.js";
import type {
  ContractCriterion,
  ProvisionalPlan,
} from "../planning/provisional-plan.js";
import type { GoalContract as CanonicalGoalContract, ContractStatement } from "../contract/goal-contract.js";
import { critiqueContract } from "../contract/critic.js";

// Re-exported so callers name the real criteria type (no inline copies).
export type { ContractCriterion, ProvisionalPlan };

// ─── Deps / result ────────────────────────────────────────────────────────────

export type GoalFlowDeps = {
  /** Workspace root: baseline + snapshot capture here. */
  root: string;
  /** Goal record (post-startGoal, PREPARING). Read for goalId/userTask/planEpoch. */
  goal: GoalRecord;
  /**
   * Controller-owned artifact persistence (the single extension point for
   * refs — goal-flow never touches the store or dispatches events).
   */
  writeArtifact: (content: string) => ArtifactRef;
  /**
   * Optional caller-supplied canonical contract criteria. When absent, the
   * production contract derives user-facing criteria from goal.userTask.
   */
  contractCriteria?: ContractCriterion[];
  /** Baseline check budget override (tests use a small value). */
  baselineMaxMs?: number;
};

export type GoalFlowRefs = {
  baselineRef: ArtifactRef;
  snapshotRef: ArtifactRef;
  contractRef: ArtifactRef;
  planRef: ArtifactRef;
};

export type GoalFlowErrorCode =
  | "BASELINE_FAILED"
  | "SNAPSHOT_FAILED"
  | "PLANNING_BLOCKED"
  | "PLANNING_FAILED"
  | "ARTIFACT_WRITE_FAILED";

export type GoalFlowResult =
  | {
      ok: true;
      baseline: EcosystemBaseline;
      snapshot: WorkspaceSnapshot;
      plan: ProvisionalPlan;
      contract: CanonicalGoalContract;
      revision: RevisionRef;
      refs: GoalFlowRefs;
      /** Whether completion criteria were caller-supplied or generated from userTask. */
      criteriaSource: "explicit" | "generated";
    }
  | { ok: false; code: GoalFlowErrorCode; reason: string };

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

// ─── Baseline adapter (API gap, documented) ───────────────────────────────────
//
// runPlanning / buildPlanFromUserTask take the frozen BaselineRecord, but
// captureEcosystemBaseline returns the Task-6 EcosystemBaseline. No primitive
// converts between them, so this adapter maps lossily-but-exactly:
// worktree buckets -> dirty paths, per-check results -> CheckRecords,
// toolVersions -> environment JSON. Failure-fingerprint ids ride as the
// per-check fingerprint when the check id matches.

export function adaptEcosystemToBaselineRecord(
  root: string,
  goalId: string,
  eco: EcosystemBaseline,
): BaselineRecord {
  const dirtyPaths: DirtyPath[] = [
    ...eco.worktree.staged.map((p) => ({ path: p, status: "A" as const })),
    ...eco.worktree.modified.map((p) => ({ path: p, status: "M" as const })),
    ...eco.worktree.untracked.map((p) => ({ path: p, status: "??" as const })),
  ];
  const fingerprintFor = (checkId: string): string | null =>
    eco.failureFingerprints.find((f) => f.checkId === checkId)?.id ?? null;
  const checks: CheckRecord[] = (
    [eco.checks.typecheck, eco.checks.test, eco.checks.lint] as const
  ).flatMap((r) =>
    r
      ? [
          {
            command: r.command,
            cwd: root,
            outcome: r.status as CheckOutcome,
            exitCode: r.exitCode,
            stdout: "",
            stderr: "",
            duration: r.durationMs,
            retried: r.retried,
            fingerprint: fingerprintFor(r.checkId),
          } satisfies CheckRecord,
        ]
      : [],
  );
  return {
    goalId,
    workspace: root,
    worktree: {
      gitRoot: root,
      headCommit: eco.revision,
      dirtyPaths,
      contentHashBudget: 0,
    },
    checks,
    environment: JSON.stringify({ revision: eco.revision }),
    createdAt: eco.capturedAt,
  };
}

// ─── Production contract -------------------------------------------------------

function taskRequirements(task: string): string[] {
  // Split real sentence boundaries, not every period. Code tasks routinely
  // contain file extensions, dotted package names, versions, and symbols
  // such as "src/foo.ts" or "node:fs.promises"; splitting on every "." turns
  // those tokens into fabricated requirements and inflates the plan/depth.
  const parts = task
    .split(/\n+|[.!?](?:\s+|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [task.trim() || "Complete the requested goal"];
}

/**
 * Build the concrete contract that the live planner and completion gate share.
 * The contract is intentionally small: explicit user requirements plus a
 * baseline-relative no-regression criterion when executable checks exist.
 * No test-only fallback criteria are used on the production path.
 */
export function buildProductionContract(
  goal: GoalRecord,
  baseline: EcosystemBaseline,
  explicitCriteria?: readonly ContractCriterion[],
): CanonicalGoalContract {
  const requirements: ContractStatement[] = taskRequirements(goal.userTask).map((text, i) => ({
    id: `req-user-${i + 1}`,
    text,
    provenance: "explicit-user",
    strength: "hard",
  }));
  const requestedCriteria: ContractStatement[] = explicitCriteria !== undefined
    ? explicitCriteria.map((c) => ({
        id: c.id,
        text: c.description,
        provenance: "explicit-user" as const,
        strength: "hard" as const,
      }))
    : requirements.map((r, i) => ({
        id: `crit-user-${i + 1}`,
        text: `Verify requested outcome: ${r.text}`,
        provenance: "explicit-user" as const,
        strength: "hard" as const,
      }));
  const availableChecks = [baseline.checks.typecheck, baseline.checks.test, baseline.checks.lint]
    .filter((c): c is NonNullable<typeof c> => c !== undefined && c.status !== "UNAVAILABLE");
  const completionCriteria: ContractStatement[] = [...requestedCriteria];
  if (explicitCriteria === undefined && availableChecks.length > 0) {
    completionCriteria.push({
      id: "crit-no-regression",
      text: "Verify no baseline check regresses relative to the captured start state",
      provenance: "repo-inferred",
      strength: "hard",
    });
  }
  const contract: CanonicalGoalContract = {
    schemaVersion: 1,
    version: 1 as CanonicalGoalContract["version"],
    goalId: String(goal.goalId),
    requirements,
    invariants: [],
    completionCriteria,
    assumptions: [],
  };
  const critique = critiqueContract(contract);
  if (!critique.approved) {
    const errors = critique.findings.filter((f) => f.severity === "error").map((f) => f.message);
    throw new Error(`contract critique rejected: ${errors.join("; ")}`);
  }
  return contract;
}

// ─── Flow ─────────────────────────────────────────────────────────────────────

export async function startGoalFlow(deps: GoalFlowDeps): Promise<GoalFlowResult> {
  const { root, goal } = deps;
  const baselineOpts: CaptureEcosystemBaselineOptions =
    deps.baselineMaxMs !== undefined ? { maxMs: deps.baselineMaxMs } : {};

  // 1. Ecosystem baseline (dirty/red repos are valid baselines).
  let baseline: EcosystemBaseline;
  try {
    baseline = await captureEcosystemBaseline(root, baselineOpts);
  } catch (err) {
    return {
      ok: false,
      code: "BASELINE_FAILED",
      reason: `captureEcosystemBaseline failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  // 2. S0 snapshot. Outside a git repo captureSnapshot throws (git status
  // exits non-zero): fall back to a truthfully empty snapshot (revision null
  // is the documented "outside a git repo" shape), never a fake HEAD.
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await captureSnapshot(root);
  } catch (err) {
    if (baseline.revision !== "unknown") {
      return {
        ok: false,
        code: "SNAPSHOT_FAILED",
        reason: `captureSnapshot failed inside a git worktree: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    snapshot = {
      revision: null,
      staged: [],
      modified: [],
      untracked: [],
      dirtySignature: sha256Hex(""),
      contentHashes: {},
    };
  }

  const now = new Date().toISOString() as ISO8601;
  const revision: RevisionRef = {
    snapshotId: sha256Hex(JSON.stringify(snapshot)) as SnapshotId,
    observedAt: now,
    ...(snapshot.revision !== null ? { gitHead: snapshot.revision } : {}),
    graphRevision: 0,
    dirtySignature: snapshot.dirtySignature,
    capabilityDigest: "",
  };

  // 3. Freeze the real production contract before planning, then plan only
  // against its canonical criterion IDs. The test-only planner fallback is
  // deliberately not reachable from this live flow.
  let contract: CanonicalGoalContract;
  try {
    contract = buildProductionContract(goal, baseline, deps.contractCriteria);
  } catch (err) {
    return {
      ok: false,
      code: "PLANNING_FAILED",
      reason: `contract construction failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  const criteriaSource: "explicit" | "generated" =
    deps.contractCriteria !== undefined ? "explicit" : "generated";
  const criteria: ContractCriterion[] = contract.completionCriteria.map((c) => ({
    id: c.id,
    description: c.text,
  }));
  let plan: ProvisionalPlan;
  try {
    const result = await runPlanning(
      goal,
      adaptEcosystemToBaselineRecord(root, goal.goalId as string, baseline),
      { contractCriteria: criteria },
    );
    if ("decision" in result) {
      return {
        ok: false,
        code: "PLANNING_BLOCKED",
        reason: `${result.decision}: ${result.reason}`,
      };
    }
    plan = result.plan;
  } catch (err) {
    return {
      ok: false,
      code: "PLANNING_FAILED",
      reason: `runPlanning threw: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  // 4. Persist the three artifacts through the controller extension point.
  let refs: GoalFlowRefs;
  try {
    refs = {
      baselineRef: deps.writeArtifact(JSON.stringify(baseline)),
      snapshotRef: deps.writeArtifact(JSON.stringify(snapshot)),
      contractRef: deps.writeArtifact(JSON.stringify(contract)),
      planRef: deps.writeArtifact(JSON.stringify(plan)),
    };
  } catch (err) {
    return {
      ok: false,
      code: "ARTIFACT_WRITE_FAILED",
      reason: `artifact write failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  return { ok: true, baseline, snapshot, plan, contract, revision, refs, criteriaSource };
}
