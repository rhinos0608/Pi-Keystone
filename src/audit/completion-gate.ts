/**
 * CompletionGate — Phase 10 machine-readable completion evaluation.
 *
 * Evaluates whether a goal satisfies all completion predicates.
 * All predicates true → DONE. Repairable false → REPAIRING.
 * Permanent missing evidence → BLOCKED. Inconsistent state → FAILED.
 */

import type { ArtifactRef } from "../domain/types.js";
import type { GoalContract, ContractStatement } from "../contract/goal-contract.js";
import type { ReviewFinding } from "../review/types.js";
import type { FinalAuditResult } from "./final-audit.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type CompletionStatus =
  | "DONE"
  | "REPAIRING"
  | "BLOCKED"
  | "FAILED";

export type CompletionPredicate = {
  /** Unique identifier for this predicate. */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** Whether the predicate is currently satisfied. */
  readonly satisfied: boolean;
  /** Whether this predicate can be repaired if unsatisfied. */
  readonly repairable: boolean;
  /** Whether absence of evidence for this predicate is permanent. */
  readonly permanentMissing: boolean;
};

export type VerificationResult = {
  readonly passed: boolean;
  readonly details: string;
};

export type CompletionInput = {
  readonly contract: GoalContract;
  readonly verification: VerificationResult;
  readonly findings: readonly ReviewFinding[];
  readonly audit: FinalAuditResult;
};

export type CompletionGateResult = {
  readonly status: CompletionStatus;
  readonly predicates: readonly CompletionPredicate[];
  readonly summary: string;
};

// ─── evaluateCompletion ────────────────────────────────────────────────────

/**
 * Evaluate all completion predicates and determine gate status.
 *
 * Logic:
 * - All predicates satisfied + verification passed + audit DONE → DONE
 * - Any permanent missing evidence → BLOCKED
 * - Any blocker-severity finding present → FAILED (inconsistent state)
 * - Any unsatisfied repairable predicate → REPAIRING
 * - Otherwise → FAILED
 */
export function evaluateCompletion(input: CompletionInput): CompletionGateResult {
  const predicates = buildPredicates(input);

  const allSatisfied = predicates.every((p) => p.satisfied);
  const hasRepairable = predicates.some((p) => !p.satisfied && p.repairable);
  const hasPermanentMissing = predicates.some((p) => !p.satisfied && p.permanentMissing);
  const hasBlockerFindings = input.findings.some((f) => f.severity === "blocker");
  const auditDone = input.audit.status === "DONE";

  // Determine status with priority order
  let status: CompletionStatus;
  if (allSatisfied && input.verification.passed && auditDone) {
    status = "DONE";
  } else if (hasPermanentMissing) {
    status = "BLOCKED";
  } else if (hasBlockerFindings) {
    status = "FAILED";
  } else if (hasRepairable) {
    status = "REPAIRING";
  } else {
    // Unsatisfied non-repairable predicates without permanent missing
    status = "FAILED";
  }

  const satisfied = predicates.filter((p) => p.satisfied).length;
  const summary = `${status}: ${satisfied}/${predicates.length} predicates satisfied`;

  return { status, predicates, summary };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildPredicates(input: CompletionInput): CompletionPredicate[] {
  const preds: CompletionPredicate[] = [];

  // 1. Verification passed
  preds.push({
    id: "verification-passed",
    description: "All verification checks passed",
    satisfied: input.verification.passed,
    repairable: true,
    permanentMissing: false,
  });

  // 2. Audit accepted
  preds.push({
    id: "audit-accepted",
    description: "Final audit accepted by both auditors",
    satisfied: input.audit.status === "DONE",
    repairable: true,
    permanentMissing: false,
  });

  // 3. No blocker-level findings
  preds.push({
    id: "no-blocker-findings",
    description: "No open blocker-severity findings remain",
    satisfied: !input.findings.some((f) => f.severity === "blocker"),
    repairable: true,
    permanentMissing: false,
  });

  // 4. All requirements addressed (each hard requirement has evidence)
  const hardReqs = input.contract.requirements.filter((r) => r.strength === "hard");
  for (const req of hardReqs) {
    preds.push({
      id: `req-addressed-${req.id}`,
      description: `Requirement ${req.id} addressed`,
      satisfied: false, // No evidence mechanism for requirement claims yet; never auto-satisfy
      repairable: false,
      permanentMissing: false,
    });
  }

  // 5. Completion criteria met
  for (const crit of input.contract.completionCriteria) {
    preds.push({
      id: `criteria-met-${crit.id}`,
      description: `Completion criterion ${crit.id} met`,
      satisfied: input.verification.passed,
      repairable: true,
      permanentMissing: false,
    });
  }

  return preds;
}
