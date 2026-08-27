import { describe, it, expect } from "vitest";
import type { FindingId } from "../../src/domain/types.js";
import type { ReviewFinding, ImpactCone } from "../../src/review/types.js";
import { reviewDiscovery } from "../../src/review/discovery.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function fid(s: string): FindingId {
  return s as FindingId;
}

function finding(overrides: Partial<ReviewFinding> & { id: string }): ReviewFinding {
  return {
    id: fid(overrides.id),
    severity: overrides.severity ?? "warn",
    message: overrides.message ?? "test message",
    filePath: overrides.filePath ?? "src/foo.ts",
    fingerprint: overrides.fingerprint ?? `fp-${overrides.id}`,
    source: overrides.source ?? "reviewer",
    reportedAt: overrides.reportedAt ?? "2025-01-01T00:00:00Z",
  };
}

const emptyCone: ImpactCone = { files: [], changedSymbols: [] };

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("reviewDiscovery", () => {
  it("returns all findings when no prior findings exist", () => {
    const f1 = finding({ id: "f1", severity: "error" });
    const f2 = finding({ id: "f2", severity: "info" });
    const result = reviewDiscovery([f1, f2], emptyCone, []);
    expect(result).toHaveLength(2);
    // Sorted: error before info
    expect(result[0].finding.id).toBe("f1");
    expect(result[1].finding.id).toBe("f2");
  });

  it("skips findings with same fingerprint and same severity", () => {
    const prior = finding({ id: "p1", severity: "error", fingerprint: "fp-shared" });
    const current = finding({ id: "c1", severity: "error", fingerprint: "fp-shared" });
    const result = reviewDiscovery([current], emptyCone, [prior]);
    expect(result).toHaveLength(0);
  });

  it("surfaces escalated findings", () => {
    const prior = finding({ id: "p1", severity: "warn", fingerprint: "fp-shared" });
    const current = finding({ id: "c1", severity: "blocker", fingerprint: "fp-shared" });
    const result = reviewDiscovery([current], emptyCone, [prior]);
    expect(result).toHaveLength(1);
    expect(result[0].finding.id).toBe("c1");
    expect(result[0].priorMatch).toBe(fid("p1"));
  });

  it("skips downgraded findings", () => {
    const prior = finding({ id: "p1", severity: "blocker", fingerprint: "fp-shared" });
    const current = finding({ id: "c1", severity: "info", fingerprint: "fp-shared" });
    const result = reviewDiscovery([current], emptyCone, [prior]);
    expect(result).toHaveLength(0);
  });

  it("attaches the impact cone to candidates", () => {
    const cone: ImpactCone = { files: ["a.ts"], changedSymbols: ["Foo"] };
    const f1 = finding({ id: "f1" });
    const result = reviewDiscovery([f1], cone, []);
    expect(result).toHaveLength(1);
    expect(result[0].affectedCone).toBe(cone);
  });

  it("sorts by severity descending (blockers first)", () => {
    const f1 = finding({ id: "info1", severity: "info" });
    const f2 = finding({ id: "blocker1", severity: "blocker" });
    const f3 = finding({ id: "warn1", severity: "warn" });
    const result = reviewDiscovery([f1, f2, f3], emptyCone, []);
    expect(result.map((c) => c.finding.id)).toEqual(["blocker1", "warn1", "info1"]);
  });

  it("returns empty for empty inputs", () => {
    const result = reviewDiscovery([], emptyCone, []);
    expect(result).toHaveLength(0);
  });
});
