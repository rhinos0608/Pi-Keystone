/**
 * Repair — Phase 9 targeted repair dispatch.
 *
 * Creates a RepairDispatch binding a finding to an assignment, capturing the
 * changed symbols, previous finding IDs for the same fingerprint, and the
 * affected impact cone.
 */

import type { FindingId, AssignmentId } from "../domain/types.js";
import type { ReviewFinding, ImpactCone, RepairAssignment, RepairDispatch } from "./types.js";

// ─── dispatchRepair ────────────────────────────────────────────────────────

/**
 * Dispatch a targeted repair for a single finding.
 *
 * Returns a RepairDispatch describing what to repair and which assignment
 * carries the work. The caller is responsible for launching the actual
 * mutation.
 */
export function dispatchRepair(
  finding: ReviewFinding,
  assignment: RepairAssignment,
  previousFindings: readonly FindingId[],
  cone: ImpactCone,
): RepairDispatch {
  if (finding.id.length === 0) {
    throw new Error("dispatchRepair: finding.id must be non-empty");
  }
  if (assignment.assignmentId.length === 0) {
    throw new Error("dispatchRepair: assignment.assignmentId must be non-empty");
  }

  return {
    findingId: finding.id,
    assignmentId: assignment.assignmentId,
    impactCone: cone,
    previousFindings,
  };
}
