// Role-based bounded projections over GoalRecord.
// Packs only fields relevant to each role — avoids leaking internal state
// to consumers that don't need it.

import type { GoalRecord, GoalId, GoalState, ArtifactRef } from "../domain/types.js";

// ─── Role definitions ───────────────────────────────────────────────────────

export type ProjectionRole = "user" | "executor" | "reviewer" | "auditor";

// ─── Projection shapes per role ─────────────────────────────────────────────

export type UserProjection = {
  kind: "user";
  goalId: GoalId;
  userTask: string;
  state: GoalState;
  createdAt: GoalRecord["createdAt"];
  updatedAt: GoalRecord["updatedAt"];
  recoveryRequired: boolean;
  terminalReportRef?: ArtifactRef;
};

export type ExecutorProjection = {
  kind: "executor";
  goalId: GoalId;
  state: GoalState;
  planEpoch: number;
  contractVersion: number | null;
  activeContractRef: ArtifactRef | null;
  baselineRef: ArtifactRef | null;
  preparation: GoalRecord["preparation"];
  driverFenceCounter: number;
  mutationFenceCounter: number;
  recoveryRequired: boolean;
  currentRevision: GoalRecord["currentRevision"];
};

export type ReviewerProjection = {
  kind: "reviewer";
  goalId: GoalId;
  state: GoalState;
  planEpoch: number;
  reviewCycles: number;
  repairCycles: number;
  finalAuditAttempts: number;
  findingLedgerRef: ArtifactRef;
  evidenceIndexRef: ArtifactRef;
  verificationIndexRef: ArtifactRef;
  activeContractRef: ArtifactRef | null;
};

export type AuditorProjection = {
  kind: "auditor";
} & GoalRecord;

export type GoalProjection = UserProjection | ExecutorProjection | ReviewerProjection | AuditorProjection;

// ─── Projection function ────────────────────────────────────────────────────

export function projectGoalStoreView(goal: GoalRecord, role: ProjectionRole): GoalProjection {
  switch (role) {
    case "user":
      return {
        kind: "user",
        goalId: goal.goalId,
        userTask: goal.userTask,
        state: goal.state,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        recoveryRequired: goal.recoveryRequired,
        ...(goal.terminalReportRef !== undefined && { terminalReportRef: goal.terminalReportRef }),
      };

    case "executor":
      return {
        kind: "executor",
        goalId: goal.goalId,
        state: goal.state,
        planEpoch: goal.planEpoch,
        contractVersion: goal.contractVersion,
        activeContractRef: goal.activeContractRef,
        baselineRef: goal.baselineRef,
        preparation: goal.preparation,
        driverFenceCounter: goal.driverFenceCounter,
        mutationFenceCounter: goal.mutationFenceCounter,
        recoveryRequired: goal.recoveryRequired,
        currentRevision: goal.currentRevision,
      };

    case "reviewer":
      return {
        kind: "reviewer",
        goalId: goal.goalId,
        state: goal.state,
        planEpoch: goal.planEpoch,
        reviewCycles: goal.reviewCycles,
        repairCycles: goal.repairCycles,
        finalAuditAttempts: goal.finalAuditAttempts,
        findingLedgerRef: goal.findingLedgerRef,
        evidenceIndexRef: goal.evidenceIndexRef,
        verificationIndexRef: goal.verificationIndexRef,
        activeContractRef: goal.activeContractRef,
      };

    case "auditor":
      // Full record — no field filtering
      return { kind: "auditor", ...goal };
  }
}
