import { describe, it, expect } from "vitest";
import {
  evaluateCriterion,
  type Evidence,
  type HardProof,
} from "../../src/verification/criterion-evaluator.js";
import type { CompletionCriterion } from "../../src/contract/draft.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeCriterion(overrides: Partial<CompletionCriterion>): CompletionCriterion {
  return {
    id: "crit-1",
    text: "tests must pass",
    verifiable: true,
    provenance: "derived",
    strength: "hard",
    ...overrides,
  };
}

function makeProof(overrides: Partial<HardProof>): HardProof {
  return {
    kind: "command-output",
    command: "npm test",
    exitCode: 0,
    success: true,
    output: "3 tests passed",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("evaluateCriterion", () => {
  // ─── Hard criterion — satisfied ───────────────────────────────────

  it("satisfies hard criterion with matching successful proof", () => {
    const crit = makeCriterion({ text: "typecheck passes", strength: "hard" });
    const evidence: Evidence = {
      hardProofs: [makeProof({ command: "tsc --noEmit", success: true, output: "typecheck passes with no errors" })],
      descriptions: [],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("satisfied");
    expect(result.hardProofs).toHaveLength(1);
    expect(result.hardProofs[0].command).toBe("tsc --noEmit");
  });

  it("satisfies hard criterion when proof output contains keyword", () => {
    const crit = makeCriterion({ text: "lint check clean", strength: "hard" });
    const evidence: Evidence = {
      hardProofs: [makeProof({ command: "eslint .", success: true, output: "0 errors found, all checks clean" })],
      descriptions: [],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("satisfied");
  });

  // ─── Hard criterion — unsatisfied ─────────────────────────────────

  it("unsatisfied when proofs exist but none match keywords", () => {
    const crit = makeCriterion({ text: "build compiles", strength: "hard" });
    const evidence: Evidence = {
      hardProofs: [makeProof({ command: "npm test", success: true, output: "tests passed" })],
      descriptions: [],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("unsatisfied");
  });

  it("unsatisfied when matching proof failed", () => {
    const crit = makeCriterion({ text: "tests pass", strength: "hard" });
    const evidence: Evidence = {
      hardProofs: [makeProof({ command: "npm test", success: false, exitCode: 1, output: "1 test failed" })],
      descriptions: [],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("unsatisfied");
  });

  // ─── Hard criterion — insufficient evidence ───────────────────────

  it("insufficient-evidence when no hard proofs provided", () => {
    const crit = makeCriterion({ text: "tests pass", strength: "hard" });
    const evidence: Evidence = { hardProofs: [], descriptions: [] };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("insufficient-evidence");
  });

  // ─── Soft criterion — satisfied ───────────────────────────────────

  it("satisfies soft criterion with matching description", () => {
    const crit = makeCriterion({ text: "code is readable", strength: "soft" });
    const evidence: Evidence = {
      hardProofs: [],
      descriptions: ["Code readability improved, all functions have clear names"],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("satisfied");
  });

  // ─── Soft criterion — insufficient evidence ───────────────────────

  it("insufficient-evidence for soft criterion with no descriptions", () => {
    const crit = makeCriterion({ text: "code is readable", strength: "soft" });
    const evidence: Evidence = { hardProofs: [], descriptions: [] };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("insufficient-evidence");
  });

  it("insufficient-evidence for soft criterion with unmatched descriptions", () => {
    const crit = makeCriterion({ text: "performance is optimized", strength: "soft" });
    const evidence: Evidence = {
      hardProofs: [],
      descriptions: ["Code formatting looks good"],
    };
    const result = evaluateCriterion(crit, evidence);
    expect(result.verdict).toBe("insufficient-evidence");
  });

  // ─── Metadata ─────────────────────────────────────────────────────

  it("returns criterion metadata in result", () => {
    const crit = makeCriterion({ id: "crit-42", text: "deploy works", strength: "soft" });
    const evidence: Evidence = { hardProofs: [], descriptions: ["deploy works"] };
    const result = evaluateCriterion(crit, evidence);
    expect(result.criterionId).toBe("crit-42");
    expect(result.criterionText).toBe("deploy works");
    expect(typeof result.reason).toBe("string");
  });
});
