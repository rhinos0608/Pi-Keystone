// Canonical failure fingerprinting
// Fingerprint = sha256(normalized command + normalized stderr + exit code)
// Same failure → same fingerprint. Deterministic.

import { createHash } from "node:crypto";

export type FailureInput = {
  command: string;
  stderr: string;
  exitCode: number;
};

export type FailureClassification = "FAIL" | "FLAKY" | "INDETERMINATE";

// ── Task 6: parsed failure fingerprints ───────────────────────────────────────
// Best-effort parsers over captured stdout/stderr. Never throw on unparseable
// output — unparseable non-empty output yields one generic fingerprint so the
// failure is still owned by the ledger.

/** Single parsed failure before hashing. */
export type ParsedFailure = {
  checkId: string;
  file: string;
  line?: number;
  diagnostic: string;
};

/** Parsed failure with sha256 content hash (id === hash). */
export type HashedFailure = ParsedFailure & {
  id: string;
  hash: string;
};

/** Hash a parsed failure: sha256(checkId + file + line + diagnostic). */
export function hashParsedFailure(f: ParsedFailure): HashedFailure {
  const normalized = [f.checkId.trim(), f.file.trim(), String(f.line ?? ""), f.diagnostic.trim()].join("\x00");
  const hash = createHash("sha256").update(normalized).digest("hex");
  return { ...f, id: hash, hash };
}

const TSC_RE = /^([^\s(]+)\((\d+)(?:,(\d+))?\):\s*error\s+(TS\d+:\s*.*)$/gm;
const VITEST_FAIL_FILE_RE = /^\s*FAIL\s+(\S+?)(?:\s+[>\-].*)?$/gm;
const VITEST_FAIL_NAMED_RE = /^\s*FAIL\s+(\S+)\s*>\s*(.+?)\s*$/gm;
const VITEST_CROSS_RE = /^\s*[×x✗]\s+(.+?)\s*$/gm;
const JEST_BULLET_RE = /^\s*●\s*(.+?)\s*›\s*(.+?)\s*$/gm;
const ESLINT_STYLISH_RE = /^([^\s:]+):(\d+):(\d+):?\s+(.*)$/gm;
const GENERIC_MESSAGE_RE = /^\s*(?:error|Error|ERROR)[\s:](.+?)\s*$/gm;

/** Parse tsc output: `src/a.ts(12,5): error TS2322: ...` lines. */
export function parseTscOutput(output: string, checkId = "typecheck"): HashedFailure[] {
  const out: HashedFailure[] = [];
  TSC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TSC_RE.exec(output)) !== null) {
    out.push(
      hashParsedFailure({
        checkId,
        file: m[1],
        line: Number.parseInt(m[2], 10),
        diagnostic: m[4].trim().slice(0, 500),
      }),
    );
  }
  return out;
}

/** Parse vitest/jest output (best-effort): FAIL file lines + test names. */
export function parseTestOutput(output: string, checkId = "test"): HashedFailure[] {
  const out: HashedFailure[] = [];
  const files = new Set<string>();
  VITEST_FAIL_FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VITEST_FAIL_FILE_RE.exec(output)) !== null) {
    files.add(m[1].trim());
  }
  const names: string[] = [];
  VITEST_FAIL_NAMED_RE.lastIndex = 0;
  while ((m = VITEST_FAIL_NAMED_RE.exec(output)) !== null) {
    names.push(`${m[1].trim()} > ${m[2].trim()}`.slice(0, 500));
  }
  VITEST_CROSS_RE.lastIndex = 0;
  while ((m = VITEST_CROSS_RE.exec(output)) !== null) {
    names.push(m[1].trim().slice(0, 500));
  }
  JEST_BULLET_RE.lastIndex = 0;
  while ((m = JEST_BULLET_RE.exec(output)) !== null) {
    names.push(`${m[1].trim()} › ${m[2].trim()}`.slice(0, 500));
  }
  const fileList = [...files];
  if (names.length === 0 && fileList.length === 0) return out;
  if (names.length === 0) {
    return fileList.map((f) => hashParsedFailure({ checkId, file: f, diagnostic: `failing file ${f}`.slice(0, 500) }));
  }
  // Named failures: attribute a file ONLY on an exact 1:1 (one failing file
  // and one failing test). Otherwise file is "unknown" — never round-robin
  // test names across files (misattribution).
  const soleFile = fileList.length === 1 && names.length === 1 ? fileList[0] : "unknown";
  return names.map((name) =>
    hashParsedFailure({
      checkId,
      file: soleFile,
      diagnostic: name,
    }),
  );
}

/** Parse eslint output (best-effort): `file:line:col message` lines. */
export function parseEslintOutput(output: string, checkId = "lint"): HashedFailure[] {
  const out: HashedFailure[] = [];
  ESLINT_STYLISH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESLINT_STYLISH_RE.exec(output)) !== null) {
    out.push(
      hashParsedFailure({
        checkId,
        file: m[1].trim(),
        line: Number.parseInt(m[2], 10),
        diagnostic: m[4].trim().slice(0, 500),
      }),
    );
  }
  return out;
}

/** Parse generic error lines so unparseable failures stay in the ledger. */
export function parseGenericOutput(output: string, checkId: string): HashedFailure[] {
  const out: HashedFailure[] = [];
  GENERIC_MESSAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GENERIC_MESSAGE_RE.exec(output)) !== null && out.length < 50) {
    const diagnostic = m[1].trim().slice(0, 500);
    if (diagnostic.length > 0) {
      out.push(hashParsedFailure({ checkId, file: "unknown", diagnostic }));
    }
  }
  return out;
}

/** A captured output line no parser claimed. Excluded from ownership math. */
export type QuarantinedMarker = {
  readonly checkId: string;
  readonly line: string;
  readonly reason: "unparsed-output" | "warning-only";
};

const WARNING_LINE_RE = /\bwarn(ing)?\b/i;

/**
 * Collect quarantined markers for output lines no tool parser claimed:
 * warning lines and otherwise unparsed non-empty lines. These stay out of
 * fingerprint/ownership math; they are evidence-preservation only.
 */
export function quarantineUnparsedOutput(
  checkId: string,
  stdout: string,
  stderr: string,
  limit = 50,
  claimedFingerprints?: readonly HashedFailure[],
): QuarantinedMarker[] {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const claimed = (claimedFingerprints ?? parseFailureFingerprints(checkId, stdout, stderr, "FAIL")).map((f) => f.diagnostic);
  // Index diagnostic heads so claimed lines usually resolve with O(1)/bucket
  // lookups instead of scanning every claimed diagnostic per candidate line.
  const heads = claimed.map((d) => d.slice(0, 120));
  const headSet = new Set(heads);
  const buckets = new Map<string, string[]>();
  for (const h of heads) {
    const key = h.slice(0, 24);
    const list = buckets.get(key) ?? [];
    list.push(h);
    buckets.set(key, list);
  }
  const scan = (list: readonly string[], head: string, line: string): boolean =>
    list.some((d) => d.includes(head) || line.includes(d));
  const isClaimed = (line: string): boolean => {
    const head = line.slice(0, 120);
    if (headSet.has(head)) return true;
    const bucket = buckets.get(head.slice(0, 24));
    if (bucket && scan(bucket, head, line)) return true;
    // Fallback preserves the original cross-bucket substring semantics.
    return scan(heads, head, line);
  };
  const out: QuarantinedMarker[] = [];
  for (const line of lines) {
    if (out.length >= limit) break;
    if (isClaimed(line)) continue;
    out.push({
      checkId,
      line: line.slice(0, 500),
      reason: WARNING_LINE_RE.test(line) ? "warning-only" : "unparsed-output",
    });
  }
  return out;
}

/**
 * Dispatch to the per-tool parser. Fingerprints are emitted ONLY on FAIL
 * outcome with a parser hit: unparsed or warning-only output yields no
 * fingerprints (use quarantineUnparsedOutput to preserve those lines —
 * quarantined markers are excluded from ownership math).
 */
export function parseFailureFingerprints(
  checkId: string,
  stdout: string,
  stderr: string,
  outcome: "FAIL" | "PASS" | "FLAKY" | "TIMEOUT" | "UNAVAILABLE" | "SKIPPED" = "FAIL",
): HashedFailure[] {
  if (outcome !== "FAIL") return [];
  const combined = `${stdout}\n${stderr}`;
  if (combined.trim().length === 0) return [];
  let parsed: HashedFailure[];
  if (checkId === "typecheck") parsed = parseTscOutput(combined, checkId);
  else if (checkId === "test") parsed = parseTestOutput(combined, checkId);
  else if (checkId === "lint") parsed = parseEslintOutput(combined, checkId);
  else parsed = parseGenericOutput(combined, checkId);
  return parsed;
}

// ── stderr normalization ────────────────────────────────────────────────────

// Strip ISO-8601 timestamps: 2024-01-15T10:30:00.000Z, 2024-01-15T10:30:00+00:00
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

// Common date-time formats: 2024-01-15 10:30:00, 01/15/2024 10:30:00
const DATETIME_RE = /\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}:\d{2}/g;

// Absolute paths: /foo/bar/baz.ts
const UNIX_PATH_RE = /(?:^|\s)\/[^\s:]+/g;

// Windows paths: C:\foo\bar\baz.ts — normalize drive letter + path
const WIN_PATH_RE = /(?:^|\s)[A-Z]:\\[^\s:]+/g;

// PID-style numbers after "pid" or "PID"
const PID_RE = /\b(?:pid|PID)\s*[:=]?\s*\d+/g;

export function normalizeStderr(stderr: string): string {
  return stderr
    .replace(TIMESTAMP_RE, "<TIMESTAMP>")
    .replace(DATETIME_RE, "<TIMESTAMP>")
    .replace(UNIX_PATH_RE, (m) => m.replace(/\/[^\s:]+/g, "/<PATH>"))
    .replace(WIN_PATH_RE, "<WINPATH>")
    .replace(PID_RE, "PID=<PID>")
    .replace(/\s+/g, " ")
    .trim();
}

// ── fingerprint computation ─────────────────────────────────────────────────

export function computeFingerprint(input: FailureInput): string {
  const normalized = [
    input.command.trim(),
    normalizeStderr(input.stderr),
    String(input.exitCode),
  ].join("\x00");

  return createHash("sha256").update(normalized).digest("hex");
}

// ── classification ──────────────────────────────────────────────────────────

export type ClassificationResult = {
  classification: FailureClassification;
  fingerprints: string[];
  distinctCount: number;
};

/**
 * Core failure-outcome classifier over precomputed fingerprints.
 * Single helper behind both retry classification and the legacy entrypoint.
 */
export function classifyFailureOutcome(
  fingerprints: readonly string[],
  commands: readonly string[],
): FailureClassification {
  if (fingerprints.length === 0) {
    throw new Error("classifyFailureOutcome requires at least one fingerprint");
  }
  if (new Set(fingerprints).size === 1) return "FAIL";
  if (new Set(commands.map((c) => c.trim())).size === 1) return "FLAKY";
  return "INDETERMINATE";
}

/**
 * Classify a set of failure observations.
 *
 * FAIL: all observations produce the same fingerprint (deterministic failure).
 * FLAKY: multiple distinct fingerprints, all share the same command (non-deterministic).
 * INDETERMINATE: multiple distinct fingerprints, different commands (unclassifiable).
 *
 * @deprecated Prefer {@link classifyFailureOutcome} over precomputed
 * fingerprints. Kept as a delegating wrapper.
 */
export function classifyFailures(inputs: FailureInput[]): ClassificationResult {
  if (inputs.length === 0) {
    throw new Error("classifyFailures requires at least one input");
  }

  const fingerprints = inputs.map(computeFingerprint);
  const classification = classifyFailureOutcome(
    fingerprints,
    inputs.map((i) => i.command),
  );
  return { classification, fingerprints, distinctCount: new Set(fingerprints).size };
}
