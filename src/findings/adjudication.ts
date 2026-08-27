/**
 * Adjudication — confirms or dismisses findings based on evidence.
 *
 * For executable P0/P1 findings, independent reproduction is required.
 * Confirm requires evidence that the finding is valid.
 * Dismiss requires evidence that the finding is a false positive or no longer applicable.
 */

import type {
  FindingRecord,
  FindingSeverity,
} from "./ledger.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type AdjudicationDecision = "confirmed" | "dismissed";

export type AdjudicationResult = {
  /** The finding ID that was adjudicated. */
  readonly findingId: string;
  /** Final decision. */
  readonly decision: AdjudicationDecision;
  /** The severity of the finding. */
  readonly severity: FindingSeverity;
  /** Whether independent reproduction was required (P0/P1). */
  readonly reproductionRequired: boolean;
  /** Whether reproduction was attempted and succeeded. */
  readonly reproductionAttempted: boolean;
  /** Human-readable reasoning. */
  readonly reason: string;
};

export type ReproductionEvidence = {
  /** Whether the issue was reproduced independently. */
  readonly reproduced: boolean;
  /** Command or action that reproduced the issue. */
  readonly reproductionCommand?: string;
  /** Output from reproduction attempt. */
  readonly output?: string;
  /** Exit code if a command was run. */
  readonly exitCode?: number;
};

export type AdjudicationEvidence = {
  /** Descriptions supporting the decision. */
  readonly descriptions: readonly string[];
  /** Reproduction evidence (required for P0/P1). */
  readonly reproduction?: ReproductionEvidence;
};

// ─── Constants ────────────────────────────────────────────────────────────

const HIGH_SEVERITY: readonly FindingSeverity[] = ["P0", "P1"];

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Adjudicate a finding: confirm it's valid or dismiss it as false positive.
 *
 * Rules:
 *   - P0 and P1 findings require independent reproduction
 *     when confirming. Without reproduction evidence, confirmation is refused.
 *   - Dismissal requires at least one descriptive reason.
 *   - P2 and P3 findings can be confirmed/dismissed on description alone.
 *
 * @returns AdjudicationResult (does NOT mutate the finding — caller applies via ledger)
 */
export function adjudicate(
  finding: FindingRecord,
  evidence: AdjudicationEvidence,
  decision: AdjudicationDecision,
): AdjudicationResult {
  const isHighSeverity = HIGH_SEVERITY.includes(finding.severity);
  const reproductionRequired = isHighSeverity && decision === "confirmed";

  // Validate: high-severity confirmation needs reproduction
  if (reproductionRequired) {
    if (!evidence.reproduction) {
      return {
        findingId: finding.id,
        decision: "dismissed", // Cannot confirm without reproduction
        severity: finding.severity,
        reproductionRequired: true,
        reproductionAttempted: false,
        reason: `Cannot confirm ${finding.severity} finding without independent reproduction evidence`,
      };
    }

    if (!evidence.reproduction.reproduced) {
      return {
        findingId: finding.id,
        decision: "dismissed",
        severity: finding.severity,
        reproductionRequired: true,
        reproductionAttempted: true,
        reason: `Independent reproduction failed: finding cannot be confirmed`,
      };
    }

    return {
      findingId: finding.id,
      decision: "confirmed",
      severity: finding.severity,
      reproductionRequired: true,
      reproductionAttempted: true,
      reason: `Confirmed via independent reproduction${
        evidence.reproduction.reproductionCommand
          ? ` (${evidence.reproduction.reproductionCommand})`
          : ""
      }`,
    };
  }

  // Dismissal path
  if (decision === "dismissed") {
    if (evidence.descriptions.length === 0) {
      return {
        findingId: finding.id,
        decision: "dismissed",
        severity: finding.severity,
        reproductionRequired: false,
        reproductionAttempted: false,
        reason: "Dismissed: no reasoning provided (warning: dismissal without evidence)",
      };
    }

    return {
      findingId: finding.id,
      decision: "dismissed",
      severity: finding.severity,
      reproductionRequired: false,
      reproductionAttempted: false,
      reason: `Dismissed: ${evidence.descriptions[0]}`,
    };
  }

  // Low-severity confirmation (P2/P3)
  return {
    findingId: finding.id,
    decision: "confirmed",
    severity: finding.severity,
    reproductionRequired: false,
    reproductionAttempted: false,
    reason: evidence.descriptions.length > 0
      ? `Confirmed: ${evidence.descriptions[0]}`
      : "Confirmed: no additional reasoning provided",
  };
}
