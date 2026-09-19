/**
 * ReportEnvelope — wraps assignment execution results with validation.
 *
 * Validates: runId present, session fresh (< maxAgeMs), findings schema correct.
 */

import type { AssignmentId, ISO8601 } from "../domain/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ReportStatus = "PENDING" | "DELIVERED" | "STALE" | "INVALID";

export type Finding = {
  readonly id: string;
  readonly severity: "info" | "warn" | "error" | "blocker";
  readonly message: string;
  readonly source: string;
};

export type ReportEnvelope = {
  readonly assignmentId: AssignmentId;
  readonly runId: string;
  readonly sessionId: string;
  readonly findings: readonly Finding[];
  readonly evidenceRefs: readonly string[];
  /** Optional typed child result preserved for higher-level protocols (audit, verifier, etc.). */
  readonly structuredOutput?: unknown;
  readonly status: ReportStatus;
  readonly createdAt: ISO8601;
};

// ─── Validation errors ──────────────────────────────────────────────────────

export type EnvelopeError =
  | { kind: "MISSING_RUN_ID" }
  | { kind: "EMPTY_SESSION_ID" }
  | { kind: "SESSION_STALE"; ageMs: number; maxAgeMs: number }
  | { kind: "INVALID_FINDING"; index: number; reason: string };

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_SESSION_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateFinding(f: unknown, index: number): EnvelopeError | null {
  if (typeof f !== "object" || f === null) {
    return { kind: "INVALID_FINDING", index, reason: "not an object" };
  }
  const obj = f as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    return { kind: "INVALID_FINDING", index, reason: "missing or empty id" };
  }
  if (!["info", "warn", "error", "blocker"].includes(obj.severity as string)) {
    return { kind: "INVALID_FINDING", index, reason: `invalid severity: ${obj.severity}` };
  }
  if (typeof obj.message !== "string" || obj.message.length === 0) {
    return { kind: "INVALID_FINDING", index, reason: "missing or empty message" };
  }
  if (typeof obj.source !== "string" || obj.source.length === 0) {
    return { kind: "INVALID_FINDING", index, reason: "missing or empty source" };
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate a raw object as a ReportEnvelope.
 * Returns { ok: true, envelope } or { ok: false, errors }.
 */
export function validateEnvelope(
  raw: Record<string, unknown>,
  opts?: { maxSessionAgeMs?: number; now?: () => number },
): { ok: true; envelope: ReportEnvelope } | { ok: false; errors: EnvelopeError[] } {
  const maxAgeMs = opts?.maxSessionAgeMs ?? DEFAULT_MAX_SESSION_AGE_MS;
  const nowMs = opts?.now?.() ?? Date.now();
  const errors: EnvelopeError[] = [];

  // runId must be present and non-empty
  if (typeof raw.runId !== "string" || raw.runId.length === 0) {
    errors.push({ kind: "MISSING_RUN_ID" });
  }

  // sessionId must be present and non-empty
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    errors.push({ kind: "EMPTY_SESSION_ID" });
  }

  // session freshness
  if (typeof raw.createdAt === "string" && raw.createdAt.length > 0) {
    const createdMs = new Date(raw.createdAt).getTime();
    if (!Number.isNaN(createdMs)) {
      const ageMs = nowMs - createdMs;
      if (ageMs > maxAgeMs) {
        errors.push({ kind: "SESSION_STALE", ageMs, maxAgeMs });
      }
    }
  }

  // findings must be an array with valid schema
  if (!Array.isArray(raw.findings)) {
    errors.push({ kind: "INVALID_FINDING", index: -1, reason: "findings is not an array" });
  } else {
    for (let i = 0; i < raw.findings.length; i++) {
      const err = validateFinding(raw.findings[i], i);
      if (err) errors.push(err);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const envelope: ReportEnvelope = {
    assignmentId: raw.assignmentId as AssignmentId,
    runId: raw.runId as string,
    sessionId: raw.sessionId as string,
    findings: Object.freeze([...(raw.findings as Finding[])]) as readonly Finding[],
    evidenceRefs: Object.freeze(
      Array.isArray(raw.evidenceRefs)
        ? (raw.evidenceRefs as unknown[]).map(String)
        : [],
    ) as readonly string[],
    ...(raw.structuredOutput !== undefined ? { structuredOutput: raw.structuredOutput } : {}),
    status: "DELIVERED",
    createdAt: raw.createdAt as ISO8601,
  };

  return { ok: true, envelope };
}

/**
 * Create a ReportEnvelope with inline validation.
 */
export function createReportEnvelope(
  fields: {
    assignmentId: AssignmentId;
    runId?: string;
    sessionId: string;
    findings?: readonly Finding[];
    evidenceRefs?: readonly string[];
    structuredOutput?: unknown;
    createdAt?: ISO8601;
  },
  opts?: { maxSessionAgeMs?: number; now?: () => number },
): { ok: true; envelope: ReportEnvelope } | { ok: false; errors: EnvelopeError[] } {
  return validateEnvelope(
    {
      assignmentId: fields.assignmentId,
      runId: fields.runId ?? "",
      sessionId: fields.sessionId,
      findings: fields.findings ?? [],
      evidenceRefs: fields.evidenceRefs ?? [],
      ...(fields.structuredOutput !== undefined ? { structuredOutput: fields.structuredOutput } : {}),
      createdAt: fields.createdAt ?? (new Date().toISOString() as ISO8601),
    },
    opts,
  );
}
