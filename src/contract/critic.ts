// Independent contract critic — P5-W8
// Critiques draft GoalContract BEFORE freeze.
// Independent from the planner (draft.ts): imports only the canonical GoalContract type.

import type {
  GoalContract,
} from "./goal-contract.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

export type FindingCategory =
  | "missing-requirement"
  | "invented-requirement"
  | "unverifiable-criterion"
  | "hidden-invariant"
  | "implementation-bias"
  | "forgotten-compat";

export type CritiqueFinding = {
  category: FindingCategory;
  severity: Severity;
  message: string;
  /** Statement id when applicable (e.g. "REQ-003") */
  statementId?: string;
};

export type CritiqueResult = {
  approved: boolean;
  findings: CritiqueFinding[];
};

// ─── Biased patterns (implementation-specific terms) ─────────────────────────

const BIASED_PATTERNS: RegExp[] = [
  /\b(src\/|lib\/|dist\/)/,       // file paths
  /\b(import|require)\b/,         // import statements
  /\b[A-Z][a-z]+Provider\b/,     // provider classes
  /\bnew\s+[A-Z]/,                // constructor calls
  /\bfetch\(/,                    // fetch calls
  /\bhttp:\/\/|https:\/\//,       // URLs
  /\blocalhost\b/,                // localhost
  /\bport\s*\d+/,                 // port numbers
  /\btest[_-]/i,                  // test file names
];

// ─── Verifiability signals ─────────────────────────────────────────────────

const VERIFIABLE_HINTS: RegExp[] = [
  /\b(returns|outputs|produces|contains|matches|equals|has\b)/i,
  /\b(test|spec|assert|verify|check|valid|pass)/i,
  /\b(all|each|every|no|none|empty)\b/i,
  /\b(\d+|true|false|null)\b/,
];

// ─── Critic ──────────────────────────────────────────────────────────────────

export function critiqueContract(contract: GoalContract): CritiqueResult {
  const findings: CritiqueFinding[] = [];

  // 1. Missing requirements
  if (contract.requirements.length === 0) {
    findings.push({
      category: "missing-requirement",
      severity: "error",
      message: "Contract has no requirements — cannot validate completion",
    });
  }

  // 2. Invented requirements (derived provenance = planner-generated, not user-sourced)
  for (const stmt of contract.requirements) {
    if (stmt.provenance === "derived") {
      findings.push({
        category: "invented-requirement",
        severity: "warning",
        message: `Derived requirement may not trace to user intent: "${stmt.text}"`,
        statementId: stmt.id,
      });
    }
  }

  // 3. Forgotten compatibility constraints
  const mentionsCompat = contract.requirements.some(
    (r) => /\b(compat|backward|backwards|existing|default|legacy)\b/i.test(r.text),
  );
  const hasCompatInvariants = contract.invariants.some(
    (inv) => /\b(compat|backward|backwards|existing|default|legacy)\b/i.test(inv.text),
  );
  if (!mentionsCompat && !hasCompatInvariants && contract.requirements.length > 0) {
    findings.push({
      category: "forgotten-compat",
      severity: "warning",
      message: "No compatibility constraints in requirements or invariants — risk of breaking existing behavior",
    });
  }

  // 4. Hidden invariants (completion criteria imply invariants but none declared)
  const criteriaImplyInvariants = contract.completionCriteria.some(
    (c) => /\b(always|never|must not|should not|no .* change)\b/i.test(c.text),
  );
  if (criteriaImplyInvariants && contract.invariants.length === 0) {
    findings.push({
      category: "hidden-invariant",
      severity: "warning",
      message: "Completion criteria imply invariants but none are declared",
    });
  }

  // 5. Implementation-biased completion criteria
  for (const criterion of contract.completionCriteria) {
    for (const pattern of BIASED_PATTERNS) {
      if (pattern.test(criterion.text)) {
        findings.push({
          category: "implementation-bias",
          severity: "warning",
          message: `Criterion references implementation detail: "${criterion.text}"`,
          statementId: criterion.id,
        });
        break; // one finding per criterion
      }
    }
  }

  // 6. Unverifiable criteria — check text for verifiable signals
  for (const criterion of contract.completionCriteria) {
    const hasHint = VERIFIABLE_HINTS.some((p) => p.test(criterion.text));
    if (!hasHint && criterion.text.length > 5) {
      findings.push({
        category: "unverifiable-criterion",
        severity: "warning",
        message: `Criterion may be unverifiable: "${criterion.text}"`,
        statementId: criterion.id,
      });
    }
  }

  const approved = findings.every((f) => f.severity !== "error");
  return { approved, findings };
}
