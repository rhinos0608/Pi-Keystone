import { describe, it, expect } from "vitest";
import type { AssignmentId } from "../../src/domain/types.js";
import {
  validateEnvelope,
  createReportEnvelope,
} from "../../src/execution/report-envelope.js";

function aid(s: string): AssignmentId {
  return s as AssignmentId;
}

function freshNow() {
  return Date.now();
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

describe("ReportEnvelope", () => {
  describe("validateEnvelope", () => {
    it("accepts a valid envelope", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "sess-1",
          findings: [],
          evidenceRefs: [],
          createdAt: iso(now),
        },
        { now: () => now, maxSessionAgeMs: 60_000 },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.runId).toBe("run-1");
        expect(result.envelope.status).toBe("DELIVERED");
      }
    });

    it("rejects missing runId", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "",
          sessionId: "sess-1",
          findings: [],
          createdAt: iso(now),
        },
        { now: () => now },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === "MISSING_RUN_ID")).toBe(true);
      }
    });

    it("rejects empty sessionId", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "",
          findings: [],
          createdAt: iso(now),
        },
        { now: () => now },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === "EMPTY_SESSION_ID")).toBe(true);
      }
    });

    it("rejects stale session", () => {
      const now = freshNow();
      const createdAt = now - 100_000; // 100s ago
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "sess-1",
          findings: [],
          createdAt: iso(createdAt),
        },
        { now: () => now, maxSessionAgeMs: 60_000 },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === "SESSION_STALE")).toBe(true);
      }
    });

    it("rejects invalid finding schema", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "sess-1",
          findings: [{ id: "f1", severity: "bogus", message: "m", source: "s" }],
          createdAt: iso(now),
        },
        { now: () => now },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === "INVALID_FINDING")).toBe(true);
      }
    });

    it("rejects findings not an array", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "sess-1",
          findings: "not-array",
          createdAt: iso(now),
        },
        { now: () => now },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.kind === "INVALID_FINDING")).toBe(true);
      }
    });

    it("accepts valid findings", () => {
      const now = freshNow();
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-1",
          sessionId: "sess-1",
          findings: [
            { id: "f1", severity: "info", message: "ok", source: "test" },
            { id: "f2", severity: "error", message: "bad", source: "lint" },
          ],
          evidenceRefs: ["ref1", "ref2"],
          createdAt: iso(now),
        },
        { now: () => now },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.findings).toHaveLength(2);
        expect(result.envelope.evidenceRefs).toEqual(["ref1", "ref2"]);
      }
    });

    it("rejects multiple errors at once", () => {
      const result = validateEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "",
          sessionId: "",
          findings: "nope",
        },
        { now: () => freshNow() },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("createReportEnvelope", () => {
    it("rejects when runId omitted", () => {
      const result = createReportEnvelope({
        assignmentId: aid("a1"),
        sessionId: "sess-1",
      });
      expect(result.ok).toBe(false);
    });

    it("produces valid envelope with all fields", () => {
      const now = freshNow();
      const result = createReportEnvelope(
        {
          assignmentId: aid("a1"),
          runId: "run-42",
          sessionId: "sess-42",
          findings: [{ id: "f1", severity: "blocker", message: "stop", source: "test" }],
          evidenceRefs: ["e1"],
        },
        { now: () => now },
      );
      expect(result.ok).toBe(true);
    });
  });
});
