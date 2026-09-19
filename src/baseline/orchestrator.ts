// Baseline orchestrator — captures worktree state + runs ecosystem checks.
// Returns a frozen EcosystemBaseline for downstream reconciliation.
// Legacy hardcoded-npx baseline (runBaseline/TIER_ZERO_CHECKS) was deleted:
// all callers use captureEcosystemBaseline.

import type {
  EcosystemBaseline,
  EcosystemCheckId,
  EcosystemCheckResult,
  EcosystemWorktreeSummary,
  FailureFingerprint,
} from "./types.js";
import { detectEcosystem, runEcosystemCheckCaptured } from "./runner.js";
import { captureSnapshot } from "./snapshot.js";
import { parseFailureFingerprints } from "./failure-fingerprint.js";
import { createHash } from "node:crypto";

// ─── Task 6: ecosystem baseline ─────────────────────────────────────────────
//
// Baseline semantics: dirty and red repos are VALID baselines. Nothing here
// forbids, stashes, or cleans dirt — dirt is recorded into dirtySignature and
// the worktree summary, failures into the fingerprint ledger.

const ECOSYSTEM_CHECK_ORDER: readonly EcosystemCheckId[] = ["typecheck", "test", "lint"];

const EMPTY_DIRTY_SIGNATURE = createHash("sha256").update("").digest("hex");

export type CaptureEcosystemBaselineOptions = {
  maxMs?: number;
};

/**
 * captureEcosystemBaseline(root): detect ecosystem, run mapped checks via
 * repository package scripts via execFile, parse failure fingerprints, and
 * record the same content-sensitive workspace identity used by S0/S1.
 * Worktree buckets and dirtySignature come from captureSnapshot so baseline,
 * approval, and release freshness all share one snapshot semantics.
 */
export async function captureEcosystemBaseline(
  root: string,
  opts?: CaptureEcosystemBaselineOptions,
): Promise<EcosystemBaseline> {
  const maxMs = opts?.maxMs ?? 60_000;
  const ecosystem = detectEcosystem(root);
  let revision = "unknown";
  let summary: EcosystemWorktreeSummary = { staged: [], modified: [], untracked: [] };
  let dirtySignature = EMPTY_DIRTY_SIGNATURE;
  try {
    // Reuse the canonical S0/S1 snapshot semantics so baseline workspace
    // identity is content-sensitive and preserves staged vs unstaged dirt.
    // Maintaining a second status-only signature here let edits to an already
    // dirty file keep the same baseline token.
    const snapshot = await captureSnapshot(root);
    revision = snapshot.revision ?? "unknown";
    summary = {
      staged: [...snapshot.staged],
      modified: [...snapshot.modified],
      untracked: [...snapshot.untracked],
    };
    dirtySignature = snapshot.dirtySignature;
  } catch {
    // Not a git repo (or git unavailable): dirty/red is still a valid baseline.
  }
  let typecheck: EcosystemCheckResult | undefined;
  let test: EcosystemCheckResult | undefined;
  let lint: EcosystemCheckResult | undefined;
  const fingerprints: FailureFingerprint[] = [];
  for (const checkId of ECOSYSTEM_CHECK_ORDER) {
    const captured = await runEcosystemCheckCaptured(root, checkId, { maxMs });
    const hasScript = checkId === "typecheck" ? true : ecosystem.scripts[checkId] !== undefined;
    if (checkId === "typecheck") typecheck = captured.result;
    else if (checkId === "test") test = hasScript ? captured.result : undefined;
    else lint = hasScript ? captured.result : undefined;
    // Fingerprints are emitted ONLY on FAIL outcome with a parser hit.
    // FLAKY means pass-on-retry: no failure evidence to own.
    if (captured.result.status === "FAIL") {
      for (const fp of parseFailureFingerprints(checkId, captured.stdout, captured.stderr, "FAIL")) {
        if (!fingerprints.some((seen) => seen.id === fp.id)) {
          fingerprints.push({ id: fp.id, checkId, file: fp.file, line: fp.line, diagnostic: fp.diagnostic, hash: fp.hash });
        }
      }
    }
  }
  const contentHashes: Record<string, string> = {};
  for (const fp of fingerprints) contentHashes[fp.id] = fp.hash;
  return {
    revision,
    dirtySignature,
    worktree: summary,
    checks: {
      typecheck: typecheck ?? { checkId: "typecheck", status: "UNAVAILABLE", command: "typecheck: no script", exitCode: null, durationMs: 0, version: null, retried: false },
      ...(test ? { test } : {}),
      ...(lint ? { lint } : {}),
    },
    failureFingerprints: fingerprints,
    contentHashes,
    capturedAt: new Date().toISOString(),
  };
}
