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
 * Classify a set of failure observations.
 *
 * FAIL: all observations produce the same fingerprint (deterministic failure).
 * FLAKY: multiple distinct fingerprints, all share the same command (non-deterministic).
 * INDETERMINATE: multiple distinct fingerprints, different commands (unclassifiable).
 */
export function classifyFailures(inputs: FailureInput[]): ClassificationResult {
  if (inputs.length === 0) {
    throw new Error("classifyFailures requires at least one input");
  }

  const fingerprints = inputs.map(computeFingerprint);
  const distinct = new Set(fingerprints);
  const distinctCount = distinct.size;

  if (distinctCount === 1) {
    return { classification: "FAIL", fingerprints, distinctCount };
  }

  // Qualifying criteria for FLAKY: all failures share the same command
  const commands = new Set(inputs.map((i) => i.command.trim()));
  if (commands.size === 1) {
    return { classification: "FLAKY", fingerprints, distinctCount };
  }

  return { classification: "INDETERMINATE", fingerprints, distinctCount };
}
