/**
 * Finding fingerprint — stable, deterministic hash from claim + target entities.
 *
 * Same claim + same targets → same fingerprint, regardless of observation context.
 * Enables deduplication: multiple observations of the same issue merge under one fingerprint.
 */

import { createHash } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────

export type FindingFingerprint = string & { readonly __brand: "FindingFingerprint" };

// ─── Core ─────────────────────────────────────────────────────────────────

/**
 * Compute a stable fingerprint for a finding from its claim and target entities.
 *
 * @param claim         - The finding's claim/description
 * @param targetEntities - Entity paths or identifiers the finding targets
 * @returns A 64-character hex SHA-256 fingerprint
 */
export function computeFindingFingerprint(
  claim: string,
  targetEntities: readonly string[],
): FindingFingerprint {
  const normalizedClaim = claim.trim().toLowerCase();
  const sortedEntities = [...targetEntities]
    .map((e) => e.trim().toLowerCase())
    .sort();

  const payload = [normalizedClaim, ...sortedEntities].join("\x00");
  const hash = createHash("sha256").update(payload).digest("hex");
  return hash as FindingFingerprint;
}

/**
 * Check if two findings share the same fingerprint (are the same issue).
 */
export function sameFinding(
  fp1: FindingFingerprint,
  fp2: FindingFingerprint,
): boolean {
  return fp1 === fp2;
}
