/**
 * Assignment type — Phase 6 execution slice.
 *
 * An Assignment binds a worker role to target files and acceptance criteria,
 * with a back-reference to the governing contract.
 */

import type { AssignmentId, ArtifactRef } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/** Worker roles that may be assigned. */
export type AssignmentRole =
  | "implementer"
  | "verifier"
  | "auditor";

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export type Assignment = {
  readonly id: AssignmentId;
  readonly role: AssignmentRole;
  readonly targetFiles: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly contractRef: ArtifactRef;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AssignmentError =
  | { kind: "EMPTY_ID" }
  | { kind: "EMPTY_TARGET_FILES" }
  | { kind: "EMPTY_ACCEPTANCE_CRITERIA" }
  | { kind: "EMPTY_CONTRACT_REF" };

// ---------------------------------------------------------------------------
// createAssignment
// ---------------------------------------------------------------------------

let _nextSeq = 1;

/** Generate a deterministic-ish AssignmentId for in-memory use. */
function generateAssignmentId(): AssignmentId {
  const seq = String(_nextSeq++).padStart(8, "0");
  const ts = Date.now().toString(36);
  return `asgn-${ts}-${seq}` as AssignmentId;
}

/**
 * Create an Assignment with validation.
 * Returns the Assignment on success, or an AssignmentError[] on failure.
 */
export function createAssignment(
  fields: Omit<Assignment, "id"> & { id?: AssignmentId },
): { ok: true; assignment: Assignment } | { ok: false; errors: AssignmentError[] } {
  const errors = validateAssignment(fields);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const id = fields.id ?? generateAssignmentId();
  const assignment: Assignment = {
    id,
    role: fields.role,
    targetFiles: Object.freeze([...fields.targetFiles]),
    acceptanceCriteria: Object.freeze([...fields.acceptanceCriteria]),
    contractRef: fields.contractRef,
  };
  return { ok: true, assignment };
}

// ---------------------------------------------------------------------------
// validateAssignment
// ---------------------------------------------------------------------------

/**
 * Validate assignment fields. Returns empty array when valid.
 */
export function validateAssignment(
  fields: Partial<Pick<Assignment, "id" | "targetFiles" | "acceptanceCriteria" | "contractRef">>,
): AssignmentError[] {
  const errors: AssignmentError[] = [];

  if (fields.id !== undefined && fields.id.length === 0) {
    errors.push({ kind: "EMPTY_ID" });
  }
  if (!fields.targetFiles || fields.targetFiles.length === 0) {
    errors.push({ kind: "EMPTY_TARGET_FILES" });
  }
  if (!fields.acceptanceCriteria || fields.acceptanceCriteria.length === 0) {
    errors.push({ kind: "EMPTY_ACCEPTANCE_CRITERIA" });
  }
  if (!fields.contractRef || fields.contractRef.length === 0) {
    errors.push({ kind: "EMPTY_CONTRACT_REF" });
  }

  return errors;
}
