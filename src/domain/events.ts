// Event constructors and validation

import type {
  GoalEvent,
  ArtifactRef,
  AssignmentId,
  DriverLease,
  ExecutionPlanSnapshot,
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
  driverFence?: number;
}): GoalEvent {
  const { driverFence, ...rest } = opts;
  return driverFence === undefined
    ? { type: "ReconciliationCompleted", ...rest }
    : { type: "ReconciliationCompleted", ...rest, driverFence };
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
  driverFence?: number;
}): GoalEvent {
  const { driverFence, ...rest } = opts;
  return driverFence === undefined
    ? { type: "ContractFrozen", ...rest }
    : { type: "ContractFrozen", ...rest, driverFence };
}

// ContractAmendment* constructors removed (Round-3): zero prod + zero test
// callers; the GoalEvent union members in domain/types.ts (schema-frozen)
// remain, constructed inline if the amendment flow is ever wired.

export function executionStarted(opts: {
  contractVersion: number;
  executionPlanRef: ArtifactRef;
  driverFence: number;
  assignments?: ExecutionPlanSnapshot["assignments"];
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

export function assignmentFailed(opts: {
  assignmentId: AssignmentId;
  errorRef?: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "AssignmentFailed", ...opts };
}

export function driverLeaseAcquired(opts: {
  lease: DriverLease;
  fenceCounter: number;
}): GoalEvent {
  return { type: "DriverLeaseAcquired", ...opts };
}

export function driverLeaseReleased(): GoalEvent {
  return { type: "DriverLeaseReleased" };
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

export function repairRequested(opts: {
  reasonRef: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "RepairRequested", ...opts };
}

export function repairCompleted(opts: {
  assignmentId: AssignmentId;
  reportRef: ArtifactRef;
  driverFence: number;
}): GoalEvent {
  return { type: "RepairCompleted", ...opts };
}

// finalAuditRoundStarted removed (Round-3): zero prod + zero test callers;
// the union member in domain/types.ts (schema-frozen) remains.

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

export function pauseRequested(reason: string, driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "PauseRequested", reason }
    : { type: "PauseRequested", reason, driverFence };
}

export function resumeRequested(driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "ResumeRequested" }
    : { type: "ResumeRequested", driverFence };
}

export function cancelRequested(reason?: string, driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "CancelRequested", reason }
    : { type: "CancelRequested", reason, driverFence };
}

export function cancellationSettled(opts: {
  cleanupRef: ArtifactRef;
  mutationOutcome: "SETTLED" | "ROLLED_BACK" | "INDETERMINATE";
  driverFence?: number;
}): GoalEvent {
  const { driverFence, ...rest } = opts;
  return driverFence === undefined
    ? { type: "CancellationSettled", ...rest }
    : { type: "CancellationSettled", ...rest, driverFence };
}

export function fatalError(errorRef: ArtifactRef, driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "FatalError", errorRef }
    : { type: "FatalError", errorRef, driverFence };
}

export function blockDeclared(blockerRefs: ArtifactRef[], driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "BlockDeclared", blockerRefs }
    : { type: "BlockDeclared", blockerRefs, driverFence };
}

export function convergenceLimitReached(evidenceRef: ArtifactRef, driverFence?: number): GoalEvent {
  return driverFence === undefined
    ? { type: "ConvergenceLimitReached", evidenceRef }
    : { type: "ConvergenceLimitReached", evidenceRef, driverFence };
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
