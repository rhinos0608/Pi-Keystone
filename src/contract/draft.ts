// Contract drafting: user requirements + repo invariants → GoalContract.
// Rejects invented requirements and unverifiable criteria.

import type { PiCapabilities } from "../runtime/feature-detect.js";
import type {
  ContractStatement as CanonicalStatement,
  StatementProvenance as CanonicalProvenance,
  StatementStrength as CanonicalStrength,
} from "./goal-contract.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type Provenance = CanonicalProvenance;
export type StatementStrength = CanonicalStrength;
export type RejectionReason = "invented-requirement" | "unverifiable-criteria";

/**
 * Draft-module statement. Re-derived from the canonical readonly shape in
 * goal-contract.ts (same id/text/provenance/strength fields); this alias
 * keeps the draft module API stable while unifying the family.
 */
export type ContractStatement = CanonicalStatement;

/**
 * Draft completion criterion: canonical statement shape plus the draft-time
 * verifiability flag. Rejected (unverifiable) candidates never reach this type.
 */
export type CompletionCriterion = CanonicalStatement & {
  readonly verifiable: boolean;
};

export type RejectedItem = {
  text: string;
  reason: RejectionReason;
};

export type GoalContract = {
  version: number;
  statements: ContractStatement[];
  completionCriteria: CompletionCriterion[];
  rejectedItems: RejectedItem[];
};

/** Repo-inferred baseline invariants extracted from codebase analysis. */
export type BaselineInvariants = {
  inferredRequirements: string[];
  architectureConstraints: string[];
  repositoryPatterns: string[];
};

// ─── Drafting ─────────────────────────────────────────────────────────────

/**
 * Draft a GoalContract from user task + repo baseline + capabilities.
 *
 * - User requirements → explicit-user statements (hard if imperative, soft otherwise)
 * - Baseline invariants → repo-inferred statements (hard)
 * - Architecture constraints + capabilities → derived completion criteria
 * - Invented requirements (not from user or baseline) are rejected
 * - Unverifiable criteria are rejected
 */
export function DraftGoalContract(
  task: string,
  baseline: BaselineInvariants,
  capabilities: PiCapabilities,
): GoalContract {
  const statements: ContractStatement[] = [];
  const completionCriteria: CompletionCriterion[] = [];
  const rejectedItems: RejectedItem[] = [];

  // --- User requirements → explicit-user statements ---
  const userReqs = extractUserRequirements(task);
  for (const req of userReqs) {
    statements.push({
      id: `user-${statements.length + 1}`,
      text: req,
      provenance: "explicit-user",
      strength: isImperative(req) ? "hard" : "soft",
    });
  }

  // --- Repo-inferred invariants ---
  for (const req of baseline.inferredRequirements) {
    statements.push({
      id: `repo-${statements.length + 1}`,
      text: req,
      provenance: "repo-inferred",
      strength: "hard",
    });
  }

  // --- Derived: architecture constraints → soft statements ---
  for (const constraint of baseline.architectureConstraints) {
    statements.push({
      id: `derived-${statements.length + 1}`,
      text: constraint,
      provenance: "derived",
      strength: "soft",
    });
  }

  // --- Derived completion criteria from architecture + capabilities ---
  const derivedCriteria = deriveCompletionCriteria(
    baseline.architectureConstraints,
    capabilities,
  );
  for (const c of derivedCriteria) {
    const verifiable = isVerifiable(c);
    if (!verifiable) {
      rejectedItems.push({ text: c, reason: "unverifiable-criteria" });
      continue;
    }
    completionCriteria.push({
      id: `crit-${completionCriteria.length + 1}`,
      text: c,
      verifiable: true,
      provenance: "derived",
      strength: "soft",
    });
  }

  // --- Repo patterns → derived verifiable criteria ---
  for (const pattern of baseline.repositoryPatterns) {
    const verifiable = isVerifiable(pattern);
    if (!verifiable) {
      rejectedItems.push({ text: pattern, reason: "unverifiable-criteria" });
      continue;
    }
    completionCriteria.push({
      id: `crit-${completionCriteria.length + 1}`,
      text: pattern,
      verifiable: true,
      provenance: "repo-inferred",
      strength: "hard",
    });
  }

  return {
    version: 1,
    statements,
    completionCriteria,
    rejectedItems,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract discrete user requirements from task text.
 * Splits on sentence boundaries and filters empties.
 */
function extractUserRequirements(task: string): string[] {
  if (!task.trim()) return [];
  const parts = task
    .split(/[.\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [task.trim()];
}

/** Imperative sentences are hard requirements. */
function isImperative(text: string): boolean {
  const imperativeStarters = [
    "must",
    "shall",
    "need",
    "require",
    "implement",
    "add",
    "fix",
    "remove",
    "ensure",
    "reject",
    "prevent",
    "always",
    "never",
  ];
  const lower = text.toLowerCase().trim();
  return imperativeStarters.some((s) => lower.startsWith(s));
}

/**
 * Check if a criterion can be verified through tooling (tests, typecheck, lint, build).
 * Vague/aspirational criteria without verifiable signals are rejected.
 */
function isVerifiable(text: string): boolean {
  const lower = text.toLowerCase();
  const verifiableSignals = [
    "test",
    "typecheck",
    "lint",
    "build",
    "compiles",
    "pass",
    "fail",
    "error",
    "check",
    "validate",
    "assert",
    "must",
    "shall",
    "require",
    "reject",
    "prevent",
    "no ",
    "contains",
    "exports",
    "returns",
    "throws",
    "matches",
    "equals",
    "exists",
  ];
  return verifiableSignals.some((s) => lower.includes(s));
}

/** Derive completion criteria from architecture constraints + capabilities. */
function deriveCompletionCriteria(
  constraints: string[],
  capabilities: PiCapabilities,
): string[] {
  const criteria: string[] = [];

  for (const c of constraints) {
    criteria.push(`Verify: ${c}`);
  }

  if (capabilities.sendUserMessage) {
    criteria.push("sendUserMessage must return without throwing");
  }
  if (capabilities.sessionBeforeCompact) {
    criteria.push("session_before_compact returns ContinuationContext or null");
  }

  return criteria;
}
