// Event constructors and validation

import type {
  GoalEvent,
  ArtifactRef,
  AssignmentId,
  FindingId,
  JobStatus,
  RevisionRef,
} from "./types.js";

export function goalStarted(): GoalEvent {
  return { type: "GoalStarted" };
}

export function preparationProgress(opts: {
  job: "baseline" | "plan";
  planEpoch: number;
  attemptId: string;
  basedOnRevision: RevisionRef;
  status: JobStatus;
  driverFence: number;
  artifactRef?: ArtifactRef;
  errorRef?: ArtifactRef;
}): GoalEvent {
  return { type: "PreparationProgress", ...opts };
}

export function reconciliationCompleted(opts: {
  reportRef: ArtifactRef;
  planEpoch: number;
  provisionalPlanRef: ArtifactRef;
  basedOnRevision: RevisionRef;
  decision: "ACCEPT_PLAN_BASIS" | "REPLAN" | "BLOCK";
}): GoalEvent {
  return { type: "ReconciliationCompleted", ...opts };
}

export function contractCritiqueCompleted(opts: {
  critiqueRef: ArtifactRef;
  accepted: boolean;
  criticRunId: string;
}): GoalEvent {
  return { type: "ContractCritiqueCompleted", ...opts };
}

export function contractFrozen(opts: {
  contractVersion: number;
  contractRef: ArtifactRef;
}): GoalEvent {
  return { type: "ContractFrozen", ...opts };
}

export function contractAmendmentProposed(opts: {
  amendmentRef: ArtifactRef;
  fromVersion: number;
  proposedVersion: number;
  proposer: "USER" | "KEYSTONE";
  authorizationRef: ArtifactRef;
}): GoalEvent {
  return { type: "ContractAmendmentProposed", ...opts };
}

export function contractAmendmentApproved(opts: {
  amendmentRef: ArtifactRef;
  approvalRef: ArtifactRef;
  approvedBy: "USER" | "POLICY";
}): GoalEvent {
  return { type: "ContractAmendmentApproved", ...opts };
}

export function contractAmendmentRejected(opts: {
  amendmentRef: ArtifactRef;
  rejectionRef: ArtifactRef;
  rejectedBy: "USER" | "POLICY";
}): GoalEvent {
  return { type: "ContractAmendmentRejected", ...opts };
}

export function contractAmendmentFrozen(opts: {
  amendmentRef: ArtifactRef;
  contractVersion: number;
  contractRef: ArtifactRef;
  criticRunId: string;
}): GoalEvent {
  return { type: "ContractAmendmentFrozen", ...opts };
}

export function executionStarted(opts: {
  contractVersion: number;
  executionPlanRef: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "ExecutionStarted", ...opts };
}

export function assignmentCompleted(opts: {
  assignmentId: AssignmentId;
  reportRef: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "AssignmentCompleted", ...opts };
}

export function verificationCompleted(opts: {
  runRef: ArtifactRef;
  accepted: boolean;
  driverFence: number;
}): GoalEvent {
  return { type: "VerificationCompleted", ...opts };
}

export function reviewCompleted(opts: {
  reviewRef: ArtifactRef;
  candidateIds: FindingId[];
  driverFence: number;
}): GoalEvent {
  return { type: "ReviewCompleted", ...opts };
}

export function adjudicationCompleted(opts: {
  decisionRefs: ArtifactRef[];
  driverFence: number;
}): GoalEvent {
  return { type: "AdjudicationCompleted", ...opts };
}

export function repairCompleted(opts: {
  assignmentId: AssignmentId;
  reportRef: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "RepairCompleted", ...opts };
}

export function finalAuditRoundStarted(opts: {
  round: number;
  assignmentRefs: [ArtifactRef, ArtifactRef];
  driverFence: number;
}): GoalEvent {
  return { type: "FinalAuditRoundStarted", ...opts };
}

export function finalAuditCompleted(opts: {
  auditRefs: [ArtifactRef, ArtifactRef];
  accepted: boolean;
  driverFence: number;
}): GoalEvent {
  return { type: "FinalAuditCompleted", ...opts };
}

export function completionEvaluated(opts: {
  reportRef: ArtifactRef;
  accepted: boolean;
  driverFence: number;
}): GoalEvent {
  return { type: "CompletionEvaluated", ...opts };
}

export function pauseRequested(reason: string): GoalEvent {
  return { type: "PauseRequested", reason };
}

export function resumeRequested(): GoalEvent {
  return { type: "ResumeRequested" };
}

export function cancelRequested(reason?: string): GoalEvent {
  return { type: "CancelRequested", reason };
}

export function cancellationSettled(opts: {
  cleanupRef: ArtifactRef;
  mutationOutcome: "SETTLED" | "ROLLED_BACK" | "INDETERMINATE";
}): GoalEvent {
  return { type: "CancellationSettled", ...opts };
}

export function fatalError(errorRef: ArtifactRef): GoalEvent {
  return { type: "FatalError", errorRef };
}

export function blockDeclared(blockerRefs: ArtifactRef[]): GoalEvent {
  return { type: "BlockDeclared", blockerRefs };
}

export function convergenceLimitReached(evidenceRef: ArtifactRef): GoalEvent {
  return { type: "ConvergenceLimitReached", evidenceRef };
}

/**
 * Validate that a driverFence field matches the expected lease token.
 * Returns true if the event carries a driverFence that matches, or if
 * the event type does not require a driverFence.
 */
export function validateDriverFence(
  event: GoalEvent,
  expectedFence: number,
): boolean {
  if ("driverFence" in event) {
    return event.driverFence === expectedFence;
  }
  // Events without driverFence (GoalStarted, PauseRequested, etc.) pass
  return true;
}
