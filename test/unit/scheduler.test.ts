import { describe, it, expect } from "vitest";
import type { AssignmentId, ArtifactRef } from "../../src/domain/types.js";
import { createAssignment } from "../../src/execution/assignment.js";
import type { ReportEnvelope } from "../../src/execution/report-envelope.js";
import type { ScheduledAssignment, DispatchResult } from "../../src/execution/scheduler.js";
import { resolveOrder, executeSchedule } from "../../src/execution/scheduler.js";
import { ISO8601 } from "../../src/domain/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function aid(s: string): AssignmentId {
  return s as AssignmentId;
}

function makeAssignment(id: string) {
  const result = createAssignment({
    id: aid(id),
    role: "implementer",
    targetFiles: ["src/x.ts"],
    acceptanceCriteria: ["works"],
    contractRef: "ref-1" as ArtifactRef,
  });
  if (!result.ok) throw new Error(`fixture failed for ${id}`);
  return result.assignment;
}

function makeReport(aid: AssignmentId): ReportEnvelope {
  return {
    assignmentId: aid,
    runId: "run-test",
    sessionId: "sess-test",
    findings: [],
    evidenceRefs: [],
    status: "DELIVERED",
    createdAt: new Date().toISOString() as ISO8601,
  };
}

function wrap(id: string, deps: string[] = []): ScheduledAssignment {
  return {
    assignment: makeAssignment(id),
    dependsOn: deps.map(aid),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("DAG scheduler", () => {
  describe("resolveOrder", () => {
    it("returns single layer for independent assignments", () => {
      const result = resolveOrder([wrap("a"), wrap("b"), wrap("c")]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers).toHaveLength(1);
        expect(result.layers[0].sort()).toEqual(["a", "b", "c"].sort());
      }
    });

    it("chains dependent assignments into separate layers", () => {
      // a → b → c
      const result = resolveOrder([wrap("c", ["b"]), wrap("b", ["a"]), wrap("a")]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers).toHaveLength(3);
        expect(result.layers[0]).toEqual(["a"]);
        expect(result.layers[1]).toEqual(["b"]);
        expect(result.layers[2]).toEqual(["c"]);
      }
    });

    it("merges independent chains into same layer", () => {
      // a and b are independent, c depends on both
      const result = resolveOrder([wrap("a"), wrap("b"), wrap("c", ["a", "b"])]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layers).toHaveLength(2);
        expect(result.layers[0].sort()).toEqual(["a", "b"]);
        expect(result.layers[1]).toEqual(["c"]);
      }
    });

    it("detects cycles", () => {
      const result = resolveOrder([wrap("a", ["b"]), wrap("b", ["a"])]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].kind).toBe("CYCLE_DETECTED");
      }
    });

    it("detects duplicate IDs", () => {
      const result = resolveOrder([wrap("a"), wrap("a")]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].kind).toBe("DUPLICATE_ID");
      }
    });

    it("detects unknown dependencies", () => {
      const result = resolveOrder([wrap("a", ["nonexistent"])]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].kind).toBe("UNKNOWN_DEPENDENCY");
      }
    });
  });

  describe("executeSchedule", () => {
    it("dispatches independent slices in parallel", async () => {
      const scheduled = [wrap("a"), wrap("b"), wrap("c")];

      const result = await executeSchedule(scheduled, async (assignment) => {
        return makeReport(assignment.id);
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(3);
        // All in one layer
        expect(result.results.every((r) => r.layerIndex === 0)).toBe(true);
      }
    });

    it("executes layers sequentially, parallel within layer", async () => {
      const executionOrder: string[] = [];
      // a → b, c is independent
      const scheduled = [wrap("a"), wrap("b", ["a"]), wrap("c")];

      const result = await executeSchedule(scheduled, async (assignment) => {
        executionOrder.push(assignment.id);
        return makeReport(assignment.id);
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toHaveLength(3);
        // a must come before b
        const idxA = executionOrder.indexOf("a");
        const idxB = executionOrder.indexOf("b");
        expect(idxA).toBeLessThan(idxB);
      }
    });

    it("propagates executor errors", async () => {
      const scheduled = [wrap("a")];
      await expect(
        executeSchedule(scheduled, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    it("returns errors from invalid DAG", async () => {
      const scheduled = [wrap("a", ["nonexistent"])];
      const result = await executeSchedule(scheduled, async () => makeReport(aid("x")));
      expect(result.ok).toBe(false);
    });
  });
});
