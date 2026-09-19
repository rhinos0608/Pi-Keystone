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
import type { EvidenceManifest } from "../evidence/types.js";

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

/**
 * Assertion-source refs for one hard requirement. A requirement is
 * satisfied only when every referenced assertion resolves to a passing
 * chain in the evidence manifest. No refs (or no manifest) means the
 * requirement is unverifiable and fails closed.
 */
export type RequirementSourceRefs = {
  readonly requirementId: string;
  readonly assertionIds: readonly string[];
};

export type AuditPolicy = "verification-only" | "single-review" | "dual-auditor";

export type CompletionInput = {
  readonly contract: GoalContract;
  readonly verification: VerificationResult;
  readonly findings: readonly ReviewFinding[];
  readonly audit?: FinalAuditResult;
  /** Required evidence depth. Defaults to the legacy dual-auditor policy. */
  readonly auditPolicy?: AuditPolicy;
  /** Single-review acceptance used only when auditPolicy is single-review. */
  readonly reviewAccepted?: boolean;
  /** Evidence manifest backing requirement/criterion evaluation. */
  readonly evidenceManifest?: EvidenceManifest;
  /** Per-requirement assertion-source refs into the manifest. */
  readonly requirementSources?: readonly RequirementSourceRefs[];
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
 * Fail-closed: hard requirements and completion criteria evaluate ONLY
 * against the evidence manifest (no manifest → unsatisfied). When a
 * manifest is present, the verification-passed predicate requires BOTH
 * complete manifest coverage and the global deterministic verification signal.
 *
 * Logic:
 * - All predicates satisfied + derived verification passed + audit DONE → DONE
 * - Any permanent missing evidence → BLOCKED
 * - Any blocker-severity finding present → FAILED (inconsistent state)
 * - Any unsatisfied repairable predicate → REPAIRING
 * - Otherwise → FAILED
 */
export function evaluateCompletion(input: CompletionInput): CompletionGateResult {
  const verificationPassed = deriveVerificationPassed(input);
  const predicates = buildPredicates(input, verificationPassed);

  const allSatisfied = predicates.every((p) => p.satisfied);
  const hasRepairable = predicates.some((p) => !p.satisfied && p.repairable);
  const hasPermanentMissing = predicates.some((p) => !p.satisfied && p.permanentMissing);
  const hasBlockerFindings = input.findings.some((f) => f.severity === "blocker");
  const auditDone = deriveAuditAccepted(input, verificationPassed);

  // Determine status with priority order
  let status: CompletionStatus;
  if (allSatisfied && verificationPassed && auditDone) {
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

function buildPredicates(input: CompletionInput, verificationPassed: boolean): CompletionPredicate[] {
  const preds: CompletionPredicate[] = [];

  // 1. Verification passed — derived from manifest coverage when a manifest
  // is present; legacy global signal otherwise.
  preds.push({
    id: "verification-passed",
    description: input.evidenceManifest
      ? "Evidence manifest coverage is complete (derived)"
      : "All verification checks passed",
    satisfied: verificationPassed,
    repairable: true,
    permanentMissing: false,
  });

  // 2. Depth-appropriate independent evidence accepted.
  const auditPolicy = input.auditPolicy ?? "dual-auditor";
  preds.push({
    id: "audit-accepted",
    description: auditPolicy === "verification-only"
      ? "Approved quick path requires deterministic verification only"
      : auditPolicy === "single-review"
        ? "Approved standard path requires one independent review"
        : "Final audit accepted by both auditors",
    satisfied: deriveAuditAccepted(input, verificationPassed),
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

  // 4. Hard requirements — evaluated from the evidence graph. A requirement
  // is satisfied only when its assertion chain passes; an unverifiable
  // requirement (no refs, no manifest, unknown assertion, non-passing
  // verdict) fails closed and is never auto-satisfied.
  const hardReqs = input.contract.requirements.filter((r) => r.strength === "hard");
  for (const req of hardReqs) {
    const satisfied = isRequirementSatisfied(input, req);
    preds.push({
      id: `req-addressed-${req.id}`,
      description: satisfied
        ? `Requirement ${req.id} verified via evidence chain`
        : `Requirement ${req.id} lacks a passing evidence chain`,
      satisfied,
      repairable: false,
      permanentMissing: false,
    });
  }

  // 5. Completion criteria — fail-closed: a criterion needs both its
  // evidence chain and the global deterministic verification result. A
  // complete manifest proves coverage, not that the current checks passed.
  for (const crit of input.contract.completionCriteria) {
    const satisfied = verificationPassed && input.evidenceManifest
      ? isCriterionCovered(input.evidenceManifest, crit.id)
      : false;
    preds.push({
      id: `criteria-met-${crit.id}`,
      description: `Completion criterion ${crit.id} met`,
      satisfied,
      repairable: true,
      permanentMissing: false,
    });
  }

  return preds;
}

/**
 * Derive the verification-passed predicate: when a manifest is present,
 * require both complete manifest coverage and input.verification.passed;
 * with no manifest, use the global verification signal alone.
 */
function deriveVerificationPassed(input: CompletionInput): boolean {
  if (input.evidenceManifest) {
    // Manifest coverage proves every criterion has an evidence chain, but it
    // does not prove the deterministic verification stage itself passed.
    // Require both so a complete manifest cannot mask a failing test/baseline
    // signal at the final gate.
    return input.verification.passed && input.evidenceManifest.coverage.uncovered.length === 0;
  }
  return input.verification.passed;
}

function deriveAuditAccepted(input: CompletionInput, verificationPassed: boolean): boolean {
  switch (input.auditPolicy ?? "dual-auditor") {
    case "verification-only":
      return verificationPassed;
    case "single-review":
      return input.reviewAccepted === true;
    case "dual-auditor":
      return input.audit?.status === "DONE";
  }
}

/**
 * A hard requirement is satisfied only when every referenced assertion
 * resolves to a passing chain in the evidence manifest. Fail-closed:
 * missing refs, missing manifest, or any non-passing verdict → false.
 */
function isRequirementSatisfied(input: CompletionInput, req: ContractStatement): boolean {
  const manifest = input.evidenceManifest;
  if (!manifest) return false;
  const refs = input.requirementSources?.find((s) => s.requirementId === req.id);
  if (!refs || refs.assertionIds.length === 0) return false;
  const byId = new Map<string, "pass" | "fail" | "skipped">();
  for (const chain of manifest.chains) {
    for (const a of chain.assertions) byId.set(a.id, a.verdict);
  }
  return refs.assertionIds.every((id) => byId.get(id) === "pass");
}

/** A criterion is covered when its chain holds at least one passing assertion. */
function isCriterionCovered(manifest: EvidenceManifest, criterionId: string): boolean {
  const chain = manifest.chains.find((c) => c.criterionId === criterionId);
  if (!chain) return false;
  return chain.assertions.some((a) => a.verdict === "pass");
}
