import { describe, it } from "vitest";
import { critiqueContract } from "../../src/contract/critic.ts";
import type { CritiqueResult } from "../../src/contract/critic.ts";
import type { GoalContract } from "../../src/contract/goal-contract.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stmt(id: string, text: string, provenance: "explicit-user" | "repo-inferred" | "derived" = "explicit-user") {
  return { id, text, provenance, strength: "hard" as const };
}

function makeContract(overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    schemaVersion: 1,
    version: 1 as GoalContract["version"],
    goalId: "test-goal-001",
    requirements: [
      stmt("REQ-1", "dark mode toggle must persist user preference across sessions"),
      stmt("REQ-2", "settings page must support toggling the active theme"),
    ],
    invariants: [
      stmt("INV-1", "existing light mode behavior must remain default"),
    ],
    completionCriteria: [
      stmt("CRIT-1", "toggle returns correct theme state"),
      stmt("CRIT-2", "each session loads the saved preference"),
    ],
    assumptions: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("critiqueContract", () => {
  it("approves a clean contract with no findings", () => {
    const result: CritiqueResult = critiqueContract(makeContract());
    expect(result.approved).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("detects missing requirements", () => {
    const result = critiqueContract(makeContract({ requirements: [] }));
    expect(result.approved).toBe(false);
    const missing = result.findings.filter((f) => f.category === "missing-requirement");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("error");
  });

  it("detects invented requirement (derived provenance)", () => {
    const result = critiqueContract(
      makeContract({
        requirements: [
          stmt("REQ-1", "dark mode toggle must persist user preference across sessions"),
          stmt("REQ-D1", "quantum entanglement state must be preserved across decoherence events", "derived"),
        ],
      }),
    );
    expect(result.approved).toBe(true); // warning only
    const invented = result.findings.filter((f) => f.category === "invented-requirement");
    expect(invented.length).toBeGreaterThanOrEqual(1);
    expect(invented[0].statementId).toBe("REQ-D1");
    expect(invented[0].message).toContain("quantum entanglement");
  });

  it("detects unverifiable criterion", () => {
    const result = critiqueContract(
      makeContract({
        completionCriteria: [
          stmt("CRIT-1", "toggle returns correct theme state"),
          stmt("CRIT-U1", "it just feels right and is good enough"),
        ],
      }),
    );
    const unverifiable = result.findings.filter((f) => f.category === "unverifiable-criterion");
    expect(unverifiable.length).toBe(1);
    expect(unverifiable[0].statementId).toBe("CRIT-U1");
    expect(unverifiable[0].message).toContain("feels right");
  });

  it("detects hidden invariant when criteria imply invariants", () => {
    const result = critiqueContract(
      makeContract({
        completionCriteria: [
          stmt("CRIT-1", "existing API must never break"),
          stmt("CRIT-2", "all endpoints must return valid JSON"),
        ],
        invariants: [],
      }),
    );
    const hidden = result.findings.filter((f) => f.category === "hidden-invariant");
    expect(hidden.length).toBe(1);
    expect(hidden[0].message).toContain("imply invariants");
  });

  it("detects implementation-biased finish criterion", () => {
    const result = critiqueContract(
      makeContract({
        completionCriteria: [
          stmt("CRIT-1", "toggle returns correct theme state"),
          stmt("CRIT-I1", "src/components/Toggle.tsx renders without errors"),
        ],
      }),
    );
    const biased = result.findings.filter((f) => f.category === "implementation-bias");
    expect(biased.length).toBe(1);
    expect(biased[0].statementId).toBe("CRIT-I1");
    expect(biased[0].message).toContain("src/components/Toggle.tsx");
  });

  it("verifies critic independence: no imports from planner modules", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(
      new URL("../../src/contract/critic.ts", import.meta.url),
      "utf-8",
    );
    // Must not import from planner (draft.ts) or runtime/store/continuation
    expect(source).not.toMatch(/from\s+['"]\.\/draft\.js/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/(runtime|store|continuation)/);
    expect(source).not.toMatch(/from\s+['"]\.\.\/domain\//);
  });
});
