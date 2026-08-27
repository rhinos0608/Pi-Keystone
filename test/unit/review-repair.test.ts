import { describe, it, expect } from "vitest";
import type { FindingId, AssignmentId } from "../../src/domain/types.js";
import type { ReviewFinding, ImpactCone, RepairAssignment } from "../../src/review/types.js";
import { dispatchRepair } from "../../src/review/repair.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function fid(s: string): FindingId { return s as FindingId; }
function aid(s: string): AssignmentId { return s as AssignmentId; }

const cone: ImpactCone = { files: ["src/a.ts"], changedSymbols: ["Foo"] };
const assignment: RepairAssignment = {
  assignmentId: aid("asgn-1"),
  targetFiles: ["src/a.ts"],
  changedSymbols: ["Foo"],
};
const finding: ReviewFinding = {
  id: fid("f1"),
  severity: "error",
  message: "bad thing",
  filePath: "src/a.ts",
  fingerprint: "fp-1",
  source: "reviewer",
  reportedAt: "2025-01-01T00:00:00Z",
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("dispatchRepair", () => {
  it("creates a repair dispatch with correct binding", () => {
    const result = dispatchRepair(finding, assignment, [], cone);
    expect(result.findingId).toBe(fid("f1"));
    expect(result.assignmentId).toBe(aid("asgn-1"));
    expect(result.impactCone).toBe(cone);
    expect(result.previousFindings).toEqual([]);
  });

  it("carries previous finding IDs", () => {
    const prev = [fid("old-1"), fid("old-2")];
    const result = dispatchRepair(finding, assignment, prev, cone);
    expect(result.previousFindings).toEqual(prev);
  });

  it("throws on empty finding ID", () => {
    const badFinding = { ...finding, id: "" as FindingId };
    expect(() => dispatchRepair(badFinding, assignment, [], cone)).toThrow(
      "finding.id must be non-empty",
    );
  });

  it("throws on empty assignment ID", () => {
    const badAssignment = { ...assignment, assignmentId: "" as AssignmentId };
    expect(() => dispatchRepair(finding, badAssignment, [], cone)).toThrow(
      "assignment.assignmentId must be non-empty",
    );
  });
});
