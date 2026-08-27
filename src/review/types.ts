/**
 * Review-phase types — Phase 9.
 *
 * Finding representation used by review discovery, convergence, and repair.
 * Imports the canonical FindingId from domain.
 */

import type { FindingId, AssignmentId, ArtifactRef } from "../domain/types.js";

// ─── Severity ──────────────────────────────────────────────────────────────

/** Severity ordering for convergence comparison (higher index = worse). */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  blocker: 3,
};

export type FindingSeverity = "info" | "warn" | "error" | "blocker";

// ─── ReviewFinding ─────────────────────────────────────────────────────────

/** A finding produced or carried through the review pipeline. */
export type ReviewFinding = {
  readonly id: FindingId;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly filePath: string;
  readonly fingerprint: string;
  readonly source: string;
  readonly reportedAt: string; // ISO-8601
};

// ─── ImpactCone ────────────────────────────────────────────────────────────

/** Set of files affected by a finding or repair action. */
export type ImpactCone = {
  readonly files: readonly string[];
  readonly changedSymbols: readonly string[];
};

// ─── ReviewCandidate ───────────────────────────────────────────────────────

/** A finding surfaced for review with its impact context. */
export type ReviewCandidate = {
  readonly finding: ReviewFinding;
  readonly affectedCone: ImpactCone;
  readonly priorMatch: FindingId | null; // ID of prior finding this supersedes
};

// ─── Convergence History ───────────────────────────────────────────────────

export type ReviewCycleEntry = {
  readonly cycleIndex: number;
  readonly timestamp: string; // ISO-8601
  readonly findingFingerprints: readonly string[];
  readonly action: "review" | "repair" | "final_audit" | "terminal_dispatch";
};

export type ConvergenceHistory = {
  readonly cycles: readonly ReviewCycleEntry[];
};

// ─── Convergence Result ────────────────────────────────────────────────────

export type ConvergenceStatus =
  | "CONVERGING"
  | "NO_PROGRESS"
  | "REPAIR_LIMIT"
  | "REVIEW_LIMIT"
  | "FINAL_AUDIT_LIMIT"
  | "TERMINAL_DISPATCH_LIMIT"
  | "NON_CONVERGENT";

export type ConvergenceResult = {
  readonly status: ConvergenceStatus;
  readonly reviewCycles: number;
  readonly repairCycles: number;
  readonly finalAuditRounds: number;
  readonly terminalDispatches: number;
};

// ─── Repair ────────────────────────────────────────────────────────────────

export type RepairAssignment = {
  readonly assignmentId: AssignmentId;
  readonly targetFiles: readonly string[];
  readonly changedSymbols: readonly string[];
};

export type RepairDispatch = {
  readonly findingId: FindingId;
  readonly assignmentId: AssignmentId;
  readonly impactCone: ImpactCone;
  readonly previousFindings: readonly FindingId[];
};
