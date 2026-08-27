/**
 * ReviewDiscovery — Phase 9 review slice.
 *
 * Produces ReviewCandidate[] from fresh reviewer output, the affected impact
 * cone, and prior findings. Deduplicates by fingerprint; surfaces only new or
 * escalated findings.
 */

import type {
  ReviewFinding,
  ReviewCandidate,
  ImpactCone,
  ConvergenceHistory,
} from "./types.js";

// ─── reviewDiscovery ───────────────────────────────────────────────────────

/**
 * Build review candidates from fresh reviewer output.
 *
 * Deduplicates by fingerprint against prior findings. Only surfaces findings
 * that are new (no prior match) or escalated (higher severity than prior match).
 */
export function reviewDiscovery(
  findings: readonly ReviewFinding[],
  cone: ImpactCone,
  priorFindings: readonly ReviewFinding[],
  _history?: ConvergenceHistory,
): readonly ReviewCandidate[] {
  const priorByFingerprint = new Map<string, ReviewFinding>();
  for (const pf of priorFindings) {
    const existing = priorByFingerprint.get(pf.fingerprint);
    if (!existing || severityRank(pf.severity) > severityRank(existing.severity)) {
      priorByFingerprint.set(pf.fingerprint, pf);
    }
  }

  const candidates: ReviewCandidate[] = [];

  for (const finding of findings) {
    const prior = priorByFingerprint.get(finding.fingerprint);

    if (!prior) {
      // New finding — always surface
      candidates.push({
        finding,
        affectedCone: cone,
        priorMatch: null,
      });
      continue;
    }

    // Escalated severity — surface as candidate
    if (severityRank(finding.severity) > severityRank(prior.severity)) {
      candidates.push({
        finding,
        affectedCone: cone,
        priorMatch: prior.id,
      });
    }
    // Same or lower severity — skip (already tracked)
  }

  // Sort: blockers first, then errors, then warnings, then info
  candidates.sort(
    (a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity),
  );

  return candidates;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function severityRank(s: string): number {
  const ranks: Record<string, number> = { info: 0, warn: 1, error: 2, blocker: 3 };
  return ranks[s] ?? -1;
}
