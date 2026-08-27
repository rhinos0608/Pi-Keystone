/**
 * Convergence — Phase 9 convergence tracking.
 *
 * Detects progress per cycle and enforces caps:
 *   - 2 same-fingerprint cycles → NO_PROGRESS
 *   - 3 repair cycles → REPAIR_LIMIT
 *   - 5 total review cycles → REVIEW_LIMIT
 *   - 2 final-audit rounds → FINAL_AUDIT_LIMIT
 *   - 8 terminal-phase dispatches → TERMINAL_DISPATCH_LIMIT
 */

import type {
  ConvergenceHistory,
  ConvergenceResult,
  ConvergenceStatus,
  ReviewCycleEntry,
} from "./types.js";

// ─── Caps ──────────────────────────────────────────────────────────────────

const CAP_SAME_FINGERPRINT_CYCLES = 2;
const CAP_REPAIR_CYCLES = 3;
const CAP_REVIEW_CYCLES = 5;
const CAP_FINAL_AUDIT_ROUNDS = 2;
const CAP_TERMINAL_DISPATCHES = 8;

// ─── checkProgress ─────────────────────────────────────────────────────────

/**
 * Analyse convergence history and return current status.
 *
 * Progress means: a previously confirmed blocker moved to fixed or dismissed
 * in a later cycle, without a new finding of same-or-higher severity appearing
 * with the same fingerprint.
 */
export function checkProgress(history: ConvergenceHistory): ConvergenceResult {
  const cycles = history.cycles;

  // Count by action type
  const reviewCycles = cycles.filter((c) => c.action === "review").length;
  const repairCycles = cycles.filter((c) => c.action === "repair").length;
  const finalAuditRounds = cycles.filter((c) => c.action === "final_audit").length;
  const terminalDispatches = cycles.filter((c) => c.action === "terminal_dispatch").length;

  // Check hard caps first (order matters — most specific first)
  if (terminalDispatches >= CAP_TERMINAL_DISPATCHES) {
    return makeResult("TERMINAL_DISPATCH_LIMIT", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
  }
  if (finalAuditRounds >= CAP_FINAL_AUDIT_ROUNDS) {
    return makeResult("FINAL_AUDIT_LIMIT", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
  }
  if (repairCycles >= CAP_REPAIR_CYCLES) {
    return makeResult("REPAIR_LIMIT", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
  }
  if (reviewCycles >= CAP_REVIEW_CYCLES) {
    return makeResult("REVIEW_LIMIT", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
  }

  // Check same-fingerprint stalling
  if (hasSameFingerprintStall(cycles)) {
    return makeResult("NO_PROGRESS", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
  }

  return makeResult("CONVERGING", reviewCycles, repairCycles, finalAuditRounds, terminalDispatches);
}

// ─── reserveCap ────────────────────────────────────────────────────────────

type CapLimit = {
  readonly action: ReviewCycleEntry["action"];
  readonly cap: number;
};

const CAP_LIMITS: readonly CapLimit[] = [
  { action: "terminal_dispatch", cap: CAP_TERMINAL_DISPATCHES },
  { action: "final_audit", cap: CAP_FINAL_AUDIT_ROUNDS },
  { action: "repair", cap: CAP_REPAIR_CYCLES },
  { action: "review", cap: CAP_REVIEW_CYCLES },
];

/**
 * Pre-flight check: would adding one more `action` hit any cap?
 * Call this BEFORE dispatching the action to get an early block.
 */
export function reserveCap(
  history: ConvergenceHistory,
  action: ReviewCycleEntry["action"],
): { allowed: boolean; reason?: string } {
  const counts = new Map<ReviewCycleEntry["action"], number>();
  for (const entry of history.cycles) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }

  for (const limit of CAP_LIMITS) {
    if (limit.action !== action) continue;
    const current = counts.get(action) ?? 0;
    if (current + 1 > limit.cap) {
      const statusName = limit.action.replace("_", "-").toUpperCase() + "_LIMIT";
      return {
        allowed: false,
        reason: `Adding "${action}" would reach ${current + 1}/${limit.cap} — ${statusName} cap`,
      };
    }
  }

  // Also check if same-fingerprint stall would trigger if this is a review
  if (action === "review") {
    const reviewOnly = history.cycles.filter((c) => c.action === "review");
    if (reviewOnly.length >= CAP_SAME_FINGERPRINT_CYCLES - 1) {
      // Would be 2nd+ consecutive same fingerprint → blocked
      const last = reviewOnly[reviewOnly.length - 1];
      if (last && reviewOnly.length >= 2) {
        const prev = reviewOnly[reviewOnly.length - 2];
        if (fingerprintKey(last.findingFingerprints) === fingerprintKey(prev.findingFingerprints)) {
          return {
            allowed: false,
            reason: `Adding "${action}" would trigger NO_PROGRESS (2 consecutive same-fingerprint reviews)`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeResult(
  status: ConvergenceStatus,
  reviewCycles: number,
  repairCycles: number,
  finalAuditRounds: number,
  terminalDispatches: number,
): ConvergenceResult {
  return { status, reviewCycles, repairCycles, finalAuditRounds, terminalDispatches };
}

/**
 * Detect same-fingerprint stall: the same set of fingerprints appearing in
 * consecutive review cycles (≥ CAP_SAME_FINGERPRINT_CYCLES times in a row).
 */
function hasSameFingerprintStall(cycles: readonly ReviewCycleEntry[]): boolean {
  if (cycles.length < CAP_SAME_FINGERPRINT_CYCLES) return false;

  // Walk backwards looking for consecutive review cycles with identical fingerprints
  const reviewOnly = cycles.filter((c) => c.action === "review");
  if (reviewOnly.length < CAP_SAME_FINGERPRINT_CYCLES) return false;

  let consecutive = 1;
  for (let i = reviewOnly.length - 1; i > 0; i--) {
    const curr = fingerprintKey(reviewOnly[i].findingFingerprints);
    const prev = fingerprintKey(reviewOnly[i - 1].findingFingerprints);
    if (curr === prev) {
      consecutive++;
      if (consecutive >= CAP_SAME_FINGERPRINT_CYCLES) return true;
    } else {
      consecutive = 1;
    }
  }

  return false;
}

function fingerprintKey(fingerprints: readonly string[]): string {
  return [...fingerprints].sort().join("|");
}
