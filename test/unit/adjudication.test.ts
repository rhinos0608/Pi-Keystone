import { describe, it, expect } from "vitest";
import { adjudicate, type AdjudicationEvidence, type ReproductionEvidence } from "../../src/findings/adjudication.js";
import type { FindingRecord } from "../../src/findings/ledger.js";
import { computeFindingFingerprint } from "../../src/findings/fingerprint.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeFinding(severity: "P0" | "P1" | "P2" | "P3"): FindingRecord {
  const now = "2025-01-01T00:00:00.000Z";
  const claim = `test finding (${severity})`;
  return {
    id: `finding-${severity}`,
    fingerprint: computeFindingFingerprint(claim, ["entity"]),
    claim,
    targetEntities: ["entity"],
    severity,
    status: "candidate",
    source: "test",
    filePath: "src/test.ts",
    observations: [{ at: now, context: "test" }],
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("adjudicate", () => {
  // ─── P0 — requires reproduction ─────────────────────────────────

  it("confirms P0 only with successful reproduction", () => {
    const finding = makeFinding("P0");
    const evidence: AdjudicationEvidence = {
      descriptions: ["Bug confirmed"],
      reproduction: { reproduced: true, reproductionCommand: "npm test", output: "1 failed" },
    };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("confirmed");
    expect(result.reproductionRequired).toBe(true);
    expect(result.reproductionAttempted).toBe(true);
  });

  it("rejects P0 confirmation without reproduction", () => {
    const finding = makeFinding("P0");
    const evidence: AdjudicationEvidence = {
      descriptions: ["Looks like a bug"],
    };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("dismissed");
    expect(result.reason).toContain("without independent reproduction");
  });

  it("rejects P0 when reproduction fails", () => {
    const finding = makeFinding("P0");
    const evidence: AdjudicationEvidence = {
      descriptions: ["Bug reported"],
      reproduction: { reproduced: false },
    };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("dismissed");
    expect(result.reproductionAttempted).toBe(true);
  });

  // ─── P1 — same as P0 ────────────────────────────────────────────

  it("confirms P1 with reproduction", () => {
    const finding = makeFinding("P1");
    const evidence: AdjudicationEvidence = {
      descriptions: ["Error confirmed"],
      reproduction: { reproduced: true, reproductionCommand: "node check.js" },
    };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("confirmed");
    expect(result.reproductionRequired).toBe(true);
  });

  it("rejects P1 confirmation without reproduction", () => {
    const finding = makeFinding("P1");
    const evidence: AdjudicationEvidence = { descriptions: ["Seems wrong"] };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("dismissed");
  });

  // ─── P2 — no reproduction needed ────────────────────────────────

  it("confirms P2 without reproduction", () => {
    const finding = makeFinding("P2");
    const evidence: AdjudicationEvidence = { descriptions: ["Style issue confirmed"] };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("confirmed");
    expect(result.reproductionRequired).toBe(false);
  });

  // ─── P3 — no reproduction needed ────────────────────────────────

  it("confirms P3 without reproduction", () => {
    const finding = makeFinding("P3");
    const evidence: AdjudicationEvidence = { descriptions: ["Noted"] };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.decision).toBe("confirmed");
    expect(result.reproductionRequired).toBe(false);
  });

  // ─── Dismissal ────────────────────────────────────────────────────

  it("dismisses finding with reason", () => {
    const finding = makeFinding("P1");
    const evidence: AdjudicationEvidence = {
      descriptions: ["False positive: test is expected to fail"],
    };
    const result = adjudicate(finding, evidence, "dismissed");
    expect(result.decision).toBe("dismissed");
    expect(result.reason).toContain("False positive");
  });

  it("dismisses high-severity without reproduction (dismissal is always allowed)", () => {
    const finding = makeFinding("P0");
    const evidence: AdjudicationEvidence = {
      descriptions: ["Not applicable anymore"],
    };
    const result = adjudicate(finding, evidence, "dismissed");
    expect(result.decision).toBe("dismissed");
    expect(result.reproductionRequired).toBe(false); // not required for dismissal
  });

  it("dismisses even without descriptions (warning)", () => {
    const finding = makeFinding("P2");
    const evidence: AdjudicationEvidence = { descriptions: [] };
    const result = adjudicate(finding, evidence, "dismissed");
    expect(result.decision).toBe("dismissed");
    expect(result.reason).toContain("no reasoning provided");
  });

  // ─── Metadata ─────────────────────────────────────────────────────

  it("includes findingId and severity in result", () => {
    const finding = makeFinding("P2");
    const evidence: AdjudicationEvidence = { descriptions: ["ok"] };
    const result = adjudicate(finding, evidence, "confirmed");
    expect(result.findingId).toBe(finding.id);
    expect(result.severity).toBe("P2");
  });
});
