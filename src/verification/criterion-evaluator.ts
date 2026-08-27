/**
 * Criterion evaluator — evaluates a single completion criterion against evidence.
 *
 * Hard-proof checks require concrete tool-output evidence (test pass, typecheck pass,
 * build success). Soft criteria accept descriptive text as evidence.
 */

import type { CompletionCriterion } from "../contract/draft.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type CriterionVerdict = "satisfied" | "unsatisfied" | "insufficient-evidence";

export type HardProof = {
  readonly kind: "command-output";
  /** The command that was run. */
  readonly command: string;
  /** Exit code from the command. */
  readonly exitCode: number;
  /** Whether the command succeeded (exit 0). */
  readonly success: boolean;
  /** Truncated stdout/stderr. */
  readonly output: string;
};

export type CriterionResult = {
  /** The criterion that was evaluated. */
  readonly criterionId: string;
  /** The criterion text. */
  readonly criterionText: string;
  /** Verdict. */
  readonly verdict: CriterionVerdict;
  /** Hard-proof checks that were examined (for hard-strength criteria). */
  readonly hardProofs: readonly HardProof[];
  /** Human-readable explanation. */
  readonly reason: string;
};

// ─── Evidence ─────────────────────────────────────────────────────────────

export type Evidence = {
  /** Hard proofs: command outputs with exit codes. */
  readonly hardProofs: readonly HardProof[];
  /** Soft evidence: human-readable descriptions. */
  readonly descriptions: readonly string[];
};

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a completion criterion against collected evidence.
 *
 * For hard-strength criteria:
 *   - Requires at least one matching hard proof (command output where success=true
 *     and command contains criterion keywords)
 *   - No matching proof → "insufficient-evidence"
 *
 * For soft-strength criteria:
 *   - Any description matching criterion keywords → "satisfied"
 *   - No matching description → "insufficient-evidence"
 */
export function evaluateCriterion(
  criterion: CompletionCriterion,
  evidence: Evidence,
): CriterionResult {
  const keywords = extractKeywords(criterion.text);

  if (criterion.strength === "hard") {
    return evaluateHard(criterion, evidence, keywords);
  }
  return evaluateSoft(criterion, evidence, keywords);
}

// ─── Hard evaluation ──────────────────────────────────────────────────────

function evaluateHard(
  criterion: CompletionCriterion,
  evidence: Evidence,
  keywords: string[],
): CriterionResult {
  const matchingProofs: HardProof[] = [];

  for (const proof of evidence.hardProofs) {
    if (!proof.success) continue;
    const proofText = `${proof.command} ${proof.output}`.toLowerCase();
    if (keywords.some((kw) => proofText.includes(kw))) {
      matchingProofs.push(proof);
    }
  }

  if (matchingProofs.length > 0) {
    return {
      criterionId: criterion.id,
      criterionText: criterion.text,
      verdict: "satisfied",
      hardProofs: matchingProofs,
      reason: `${matchingProofs.length} hard proof(s) match criterion keywords`,
    };
  }

  // Check if there are any proofs at all — if none, insufficient evidence
  if (evidence.hardProofs.length === 0) {
    return {
      criterionId: criterion.id,
      criterionText: criterion.text,
      verdict: "insufficient-evidence",
      hardProofs: [],
      reason: "no hard proofs provided",
    };
  }

  // Proofs exist but none match
  return {
    criterionId: criterion.id,
    criterionText: criterion.text,
    verdict: "unsatisfied",
    hardProofs: evidence.hardProofs,
    reason: `${evidence.hardProofs.length} proof(s) provided but none match criterion keywords`,
  };
}

// ─── Soft evaluation ──────────────────────────────────────────────────────

function evaluateSoft(
  criterion: CompletionCriterion,
  evidence: Evidence,
  keywords: string[],
): CriterionResult {
  const matchingDescriptions = evidence.descriptions.filter((desc) => {
    const lower = desc.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  });

  if (matchingDescriptions.length > 0) {
    return {
      criterionId: criterion.id,
      criterionText: criterion.text,
      verdict: "satisfied",
      hardProofs: [],
      reason: `${matchingDescriptions.length} description(s) match criterion keywords`,
    };
  }

  return {
    criterionId: criterion.id,
    criterionText: criterion.text,
    verdict: "insufficient-evidence",
    hardProofs: [],
    reason: evidence.descriptions.length === 0
      ? "no evidence provided"
      : "provided evidence does not match criterion keywords",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract lowercase keywords from criterion text for matching.
 * Filters out stop words and short tokens.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "must", "and", "or", "but", "in",
    "on", "at", "to", "for", "of", "with", "by", "from", "as", "into", "that",
    "this", "it", "its", "no", "not", "all", "each", "every", "any"]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
}
