// Schema-frozen domain types — ARCHITECTURE.md §3A-3B
// Transcribed verbatim. Do not modify without architecture review.

// ─── Branded IDs ───────────────────────────────────────────────────────────

type GoalId = string & { readonly __brand: "GoalId" };           // UUIDv7
type SnapshotId = string & { readonly __brand: "SnapshotId" };   // sha256 manifest id
type ArtifactRef = string & { readonly __brand: "ArtifactRef" }; // sha256 CAS ref
type FindingId = string & { readonly __brand: "FindingId" };
type AssignmentId = string & { readonly __brand: "AssignmentId" };
type ISO8601 = string & { readonly __brand: "ISO8601" };

// ─── §3A — Goal state machine ─────────────────────────────────────────────

type LifecycleDepth = "quick" | "standard" | "full";

type GoalState =
  | "CREATED"
  | "PREPARING"
  | "RECONCILING"
  | "CONTRACT_REVIEW"
  | "READY"
  | "EXECUTING"
  | "VERIFYING"
  | "REVIEWING"
  | "ADJUDICATING"
  | "REPAIRING"
  | "FINAL_AUDIT"
  | "COMPLETION_GATE"
  | "PAUSED"
  | "CANCELLING"
  | "DONE"
  | "BLOCKED"
  | "FAILED"
  | "NON_CONVERGENT"
  | "CANCELLED";

type GoalEvent =
  | { type: "GoalStarted" }
  | { type: "PreparedFlowStored"; flowRef: ArtifactRef; baselineRef: ArtifactRef; driverFence?: number }
  | { type: "LifecycleDepthApproved"; depth: LifecycleDepth; proposalRef: ArtifactRef; approvedBy: "USER"; driverFence?: number }
  | {
      type: "PreparationProgress";
      job: "baseline" | "plan";
      planEpoch: number;
      attemptId: string;
      basedOnRevision: RevisionRef;
      status: JobStatus;
      driverFence: number;      // every continuation/child completion must carry the active DriverLease.fencingToken
      artifactRef?: ArtifactRef;
      errorRef?: ArtifactRef;
    }
  | {
      type: "ReconciliationCompleted";
      reportRef: ArtifactRef;
      planEpoch: number;
      provisionalPlanRef: ArtifactRef;
      basedOnRevision: RevisionRef;
      decision: "ACCEPT_PLAN_BASIS" | "REPLAN" | "BLOCK";
      driverFence?: number;
    }
  | { type: "ContractCritiqueCompleted"; critiqueRef: ArtifactRef; accepted: boolean; criticRunId: string }
  | { type: "ContractFrozen"; contractVersion: number; contractRef: ArtifactRef; driverFence?: number }
  | {
      type: "ContractAmendmentProposed";
      amendmentRef: ArtifactRef;
      fromVersion: number;
      proposedVersion: number;
      proposer: "USER" | "KEYSTONE";
      authorizationRef: ArtifactRef;
      driverFence?: number;
    }
  | { type: "ContractAmendmentApproved"; amendmentRef: ArtifactRef; approvalRef: ArtifactRef; approvedBy: "USER" | "POLICY"; driverFence?: number }
  | { type: "ContractAmendmentRejected"; amendmentRef: ArtifactRef; rejectionRef: ArtifactRef; rejectedBy: "USER" | "POLICY"; driverFence?: number }
  | { type: "ContractAmendmentFrozen"; amendmentRef: ArtifactRef; contractVersion: number; contractRef: ArtifactRef; criticRunId: string; driverFence?: number }
  | { type: "ExecutionStarted"; contractVersion: number; executionPlanRef: ArtifactRef; driverFence: number; assignments?: ExecutionPlanSnapshot["assignments"] }
  | { type: "AssignmentRunBound"; assignmentId: AssignmentId; runId: string; sessionId: string; driverFence: number }
  | { type: "AssignmentCompleted"; assignmentId: AssignmentId; reportRef: ArtifactRef; driverFence: number }
  | { type: "AssignmentFailed"; assignmentId: AssignmentId; errorRef?: ArtifactRef; driverFence: number }
  | { type: "VerificationCompleted"; runRef: ArtifactRef; accepted: boolean; driverFence: number }
  | { type: "CompletionRecoveryRestarted"; reasonRef: ArtifactRef; driverFence: number }
  | { type: "ReviewCompleted"; reviewRef: ArtifactRef; candidateIds: FindingId[]; driverFence: number }
  | { type: "AdjudicationCompleted"; decisionRefs: ArtifactRef[]; driverFence: number }
  | { type: "RepairRequested"; reasonRef: ArtifactRef; driverFence: number }
  | { type: "LifecycleRerouted"; to: "COMPLETION_GATE"; depth: LifecycleDepth; reasonRef: ArtifactRef; driverFence: number }
  | { type: "RepairCompleted"; assignmentId: AssignmentId; reportRef: ArtifactRef; driverFence: number }
  | { type: "FinalAuditRoundStarted"; round: number; assignmentRefs: [ArtifactRef, ArtifactRef]; driverFence: number }
  | { type: "FinalAuditCompleted"; auditRefs: [ArtifactRef, ArtifactRef]; accepted: boolean; driverFence: number }
  | { type: "CompletionEvaluated"; reportRef: ArtifactRef; accepted: boolean; driverFence: number }
  | { type: "PauseRequested"; reason: string; driverFence?: number }
  | { type: "ResumeRequested"; driverFence?: number }
  | { type: "CancelRequested"; reason?: string; driverFence?: number }
  | { type: "CancellationSettled"; cleanupRef: ArtifactRef; mutationOutcome: "SETTLED" | "ROLLED_BACK" | "INDETERMINATE"; driverFence?: number }
  | { type: "FatalError"; errorRef: ArtifactRef; driverFence?: number }
  | { type: "BlockDeclared"; blockerRefs: ArtifactRef[]; driverFence?: number }
  | { type: "ConvergenceLimitReached"; evidenceRef: ArtifactRef; driverFence?: number }
  | { type: "MutationLeaseAttached"; lease: MutationLease; driverFence: number }
  | { type: "MutationLeaseReleased"; leaseId: string; driverFence: number }
  | { type: "DriverLeaseAcquired"; lease: DriverLease; fenceCounter: number }
  | { type: "DriverLeaseReleased" };

// ─── §3B — GoalRecord and supporting types ────────────────────────────────

type WorkspaceIdentity = {
  requestedRoot: string;
  canonicalRoot: string;       // realpath; same rule as workspace protocol v3
  projectKey: string;          // sha256(canonicalRoot)
  vcs: "git" | "none";
  gitCommonDir?: string;
};

type RevisionRef = {
  snapshotId: SnapshotId;
  observedAt: ISO8601;
  gitHead?: string;
  branch?: string;
  graphRevision: number;
  dirtySignature: string;      // content-addressed worktree inventory
  capabilityDigest: string;
};

type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

// ─── Per-assignment execution state (Task 1: explicit assignment/run tracking) ─

type AssignmentState =
  | "CREATED"
  | "ACQUIRED"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type RunRecord = {
  runId: string;
  sessionId: string;
  status: RunStatus;
  startedAt: ISO8601;
  endedAt?: ISO8601;
  resultRef?: ArtifactRef;
};

// Minimal DAG snapshot used for frontier-gated VERIFYING.
// Assignments listed here form the required frontier for the current plan epoch.
type ExecutionPlanSnapshot = {
  planEpoch: number;
  assignments: readonly {
    readonly id: AssignmentId;
    readonly dependsOn: readonly AssignmentId[];
  }[];
};

type PreparationJob = {
  kind: "baseline" | "plan";
  planEpoch: number;
  attemptId: string;           // UUIDv7, new for every dispatch/retry
  basedOnRevision: RevisionRef;
  status: JobStatus;
  ref?: ArtifactRef;
  errorRef?: ArtifactRef;
};

type DriverLease = {
  leaseId: string;
  sessionId: string;
  fencingToken: number;        // monotonically increases per goal on every acquisition
  acquiredAt: ISO8601;
  heartbeatAt: ISO8601;
  expiresAt: ISO8601;
};

type SnapshotPinLease = {
  snapshotId: SnapshotId;
  purpose: "R0" | "CHECKPOINT" | "OPEN_FINDING" | "RN";
  leaseId: string;
  renewedAt: ISO8601;
  expiresAt: ISO8601;
};

type MutationLease = {
  leaseId: string;
  fencingToken: number;          // monotonically increases per canonical worktree
  assignmentId: AssignmentId;
  sessionId: string;
  workerProcessIdentity: string; // pid + process-start key
  canonicalWorkspaceRoot: string;
  allowedCanonicalPaths: string[];
  baseDirtySignature: string;
  phase: "ACQUIRED" | "AUTHORITY_READY" | "MUTATING" | "SETTLING";
  authorityReceiptRef?: ArtifactRef;
  inFlightToolCallId?: string;
  acquiredAt: ISO8601;
  heartbeatAt: ISO8601;
  expiresAt: ISO8601;
};

// checkpoint-2 recheck: CANCELLING excluded from resume targets
type GoalRecord = {
  schemaVersion: 1;
  recordVersion: number;       // optimistic concurrency token
  goalId: GoalId;
  supersedesGoalId?: GoalId;
  userTask: string;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  workspace: WorkspaceIdentity;
  startRevision: RevisionRef;
  currentRevision: RevisionRef;
  state: GoalState;
  resumeState?: Exclude<GoalState, "PAUSED" | "CANCELLING" | "DONE" | "BLOCKED" | "FAILED" | "NON_CONVERGENT" | "CANCELLED">;
  recoveryRequired: boolean;
  planEpoch: number;           // starts at 0; material contradiction increments
  contractVersion: number | null;
  lifecycleDepth: LifecycleDepth | null;
  depthProposalRef: ArtifactRef | null;
  depthApprovedAt?: ISO8601;
  /** CAS artifact containing the complete prepared execution bundle. Optional for schema-v1 backward compatibility. */
  preparedFlowRef?: ArtifactRef | null;
  /** Durable evidence/reason for the currently requested repair cycle. */
  repairReasonRef?: ArtifactRef;
  /** True after a repair mutation settles and until a fresh verifier frontier starts. */
  repairVerificationPending?: boolean;
  activeContractRef: ArtifactRef | null;
  pendingAmendmentRef?: ArtifactRef;
  amendmentReturnState?: Exclude<GoalState, "PAUSED" | "CANCELLING">;
  baselineRef: ArtifactRef | null;
  snapshotRefs: SnapshotId[];
  snapshotPins: SnapshotPinLease[];
  findingLedgerRef: ArtifactRef;
  evidenceIndexRef: ArtifactRef;
  assignmentIndexRef: ArtifactRef;
  verificationIndexRef: ArtifactRef;
  preparation: {
    baselineJob: PreparationJob;
    provisionalPlanJob: PreparationJob;
  };
  activeDriverLease?: DriverLease;
  driverFenceCounter: number;
  activeMutationLease?: MutationLease;
  mutationFenceCounter: number;
  // Per-assignment progress (Task 1). AssignmentCompleted transitions only
  // the named assignment; the goal advances EXECUTING → VERIFYING only when
  // every assignment in the current plan epoch's required frontier is terminal.
  assignmentStates: Partial<Record<AssignmentId, AssignmentState>>;
  activeRuns: Partial<Record<AssignmentId, RunRecord>>;
  executionPlan: ExecutionPlanSnapshot | null;
  reviewCycles: number;
  repairCycles: number;
  finalAuditAttempts: number;
  cancellationRequestedAt?: ISO8601;
  cancellationReason?: string;
  pauseReason?: string;
  pauseCheckpointRef?: ArtifactRef;
  pausedAt?: ISO8601;
  terminalReportRef?: ArtifactRef;
  lastTransitionId: string;
};

// ─── PreparationProgress (event sub-shape referenced in §3A) ──────────────

type PreparationProgress = Extract<GoalEvent, { type: "PreparationProgress" }>;

// ─── Re-export all ─────────────────────────────────────────────────────────

export type {
  GoalId,
  SnapshotId,
  ArtifactRef,
  FindingId,
  AssignmentId,
  ISO8601,
  GoalState,
  LifecycleDepth,
  GoalEvent,
  GoalRecord,
  WorkspaceIdentity,
  RevisionRef,
  JobStatus,
  PreparationJob,
  DriverLease,
  SnapshotPinLease,
  MutationLease,
  AssignmentState,
  RunStatus,
  RunRecord,
  ExecutionPlanSnapshot,
  PreparationProgress,
};
