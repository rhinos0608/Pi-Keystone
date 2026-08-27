/**
 * FinalAudit — Phase 10 dual-auditor final review.
 *
 * Runs two fresh independent auditor sessions with distinct identities
 * verified against the AssignmentIndex. Both must accept for the goal
 * to transition to DONE. An evidence checklist covers all artifacts
 * referenced in the contract.
 */

import type { AssignmentId, ArtifactRef, ISO8601 } from "../domain/types.js";
import type { GoalContract, ContractStatement } from "../contract/goal-contract.js";
import type { AssignmentIndex, AssignmentIndexEntry } from "../execution/assignment-index.js";
import type { ReviewFinding } from "../review/types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type AuditOutcome = "ACCEPTED" | "REJECTED";

export type AuditorSession = {
  readonly sessionId: string;
  readonly runId: string;
  readonly outcome: AuditOutcome;
  readonly findings: readonly ReviewFinding[];
  readonly evidenceChecklist: readonly EvidenceCheckItem[];
};

export type EvidenceCheckItem = {
  readonly artifactRef: ArtifactRef;
  readonly description: string;
  readonly present: boolean;
};

export type FinalAuditResult =
  | { readonly status: "DONE"; readonly audits: readonly AuditorSession[] }
  | {
      readonly status: "AUDIT_REJECTED";
      readonly audits: readonly AuditorSession[];
      readonly reason: string;
    };

export type FinalAuditInput = {
  readonly goalId: string;
  readonly contract: GoalContract;
  readonly baselineRef: ArtifactRef | null;
  readonly deltaRef: ArtifactRef | null;
  readonly findings: readonly ReviewFinding[];
  readonly snapshotRefs: readonly ArtifactRef[];
  readonly assignmentIndex: AssignmentIndex;
  /** Two auditor sessions to validate. Must have distinct identities. */
  readonly auditorSessions: [AuditorSession, AuditorSession];
};

// ─── runFinalAudit ─────────────────────────────────────────────────────────

/**
 * Run two independent auditor sessions and check both accept.
 *
 * Validates:
 * 1. Auditor sessions have distinct session IDs
 * 2. Both identities exist in the AssignmentIndex with role "auditor"
 * 3. Both identities are NOT shared with planner/implementer roles (collusion prevention)
 * 4. Both identities were registered AFTER the last non-auditor entry (fresh session)
 * 5. Both accept
 * 6. Evidence checklist covers all contract artifacts
 */
export function runFinalAudit(input: FinalAuditInput): FinalAuditResult {
  const [a1, a2] = input.auditorSessions;

  // Distinct identities
  if (a1.sessionId === a2.sessionId) {
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: "Both auditor sessions share the same sessionId; distinct identities required",
    };
  }

  // Both identities must be validated
  const valid1 = isRegisteredAuditor(input.assignmentIndex, a1);
  const valid2 = isRegisteredAuditor(input.assignmentIndex, a2);

  if (!valid1.ok) {
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: `Auditor session "${a1.sessionId}": ${valid1.reason}`,
    };
  }
  if (!valid2.ok) {
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: `Auditor session "${a2.sessionId}": ${valid2.reason}`,
    };
  }

  // Empty evidence checklist
  if (a1.evidenceChecklist.length === 0 || a2.evidenceChecklist.length === 0) {
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: "empty evidence checklist",
    };
  }

  // Both must accept
  if (a1.outcome !== "ACCEPTED" || a2.outcome !== "ACCEPTED") {
    const rejectors = [a1, a2].filter((a) => a.outcome !== "ACCEPTED").map((a) => a.sessionId);
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: `Auditor(s) rejected: ${rejectors.join(", ")}`,
    };
  }

  // Verify evidence checklist completeness
  const missing = input.auditorSessions.flatMap((session) =>
    session.evidenceChecklist.filter((item) => !item.present),
  );
  if (missing.length > 0) {
    return {
      status: "AUDIT_REJECTED",
      audits: input.auditorSessions,
      reason: `Missing evidence artifacts: ${missing.map((m) => m.description).join(", ")}`,
    };
  }

  return { status: "DONE", audits: input.auditorSessions };
}

// ─── Evidence checklist builder ────────────────────────────────────────────

/**
 * Build an evidence checklist from contract statements.
 * Each requirement, invariant, and completion criterion maps to an artifact ref.
 */
export function buildEvidenceChecklist(
  contract: GoalContract,
  knownArtifacts: Map<string, boolean>,
): EvidenceCheckItem[] {
  const items: EvidenceCheckItem[] = [];

  for (const section of [contract.requirements, contract.invariants, contract.completionCriteria]) {
    for (const stmt of section) {
      items.push({
        artifactRef: stmt.id as unknown as ArtifactRef,
        description: stmt.text,
        present: knownArtifacts.get(stmt.id) ?? false,
      });
    }
  }

  return items;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type AuditorValidation = { ok: true } | { ok: false; reason: string };

/**
 * Enhanced auditor identity validation:
 * 1. sessionId exists in AssignmentIndex with role "auditor"
 * 2. sessionId is NOT shared with any planner/implementer entry (collusion check)
 * 3. auditor registration happened AFTER the last non-auditor entry (fresh session)
 */
function isRegisteredAuditor(index: AssignmentIndex, session: AuditorSession): AuditorValidation {
  // 1. Must exist as auditor
  const auditorEntry = index.entries.find(
    (e) => e.sessionId === session.sessionId && e.role === "auditor",
  );
  if (!auditorEntry) {
    return { ok: false, reason: "not found in AssignmentIndex with role \"auditor\"" };
  }

  // 2. Must NOT be shared with planner or implementer (collusion prevention)
  const colludingEntry = index.entries.find(
    (e) =>
      e.sessionId === session.sessionId &&
      (e.role === "planner" || e.role === "implementer"),
  );
  if (colludingEntry) {
    return {
      ok: false,
      reason: `sessionId shared with ${colludingEntry.role} role (collusion risk)`,
    };
  }

  // 3. Auditor must be registered AFTER the last non-auditor entry (fresh session)
  let lastNonAuditorIndex = -1;
  for (let i = 0; i < index.entries.length; i++) {
    if (index.entries[i].role !== "auditor") {
      lastNonAuditorIndex = i;
    }
  }
  // Find auditor entry index in the array
  const auditorIndex = index.entries.findIndex(
    (e) => e.sessionId === session.sessionId && e.role === "auditor",
  );
  if (auditorIndex <= lastNonAuditorIndex) {
    return {
      ok: false,
      reason: "auditor session not fresh (registered before last non-auditor entry)",
    };
  }

  return { ok: true };
}
