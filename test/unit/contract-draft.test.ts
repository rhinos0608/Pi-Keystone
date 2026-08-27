import { describe, it } from "vitest";
import {
  DraftGoalContract,
  type BaselineInvariants,
  type PiCapabilities,
} from "../../src/contract/draft.ts";

// ─── Test fixtures ────────────────────────────────────────────────────────

const emptyCapabilities: PiCapabilities = {
  sendUserMessage: false,
  registerCommand: false,
  contextEvent: false,
  sessionBeforeCompact: false,
  toolCallIntercept: false,
  newSession: false,
};

const fullCapabilities: PiCapabilities = {
  sendUserMessage: true,
  registerCommand: true,
  contextEvent: true,
  sessionBeforeCompact: true,
  toolCallIntercept: true,
  newSession: true,
};

const emptyBaseline: BaselineInvariants = {
  inferredRequirements: [],
  architectureConstraints: [],
  repositoryPatterns: [],
};

// ─── User requirement preserved as explicit ───────────────────────────────

describe("DraftGoalContract", () => {
  it("preserves user requirements as explicit-user statements", () => {
    const task = "Implement a caching layer. Must reject invalid tokens.";
    const result = DraftGoalContract(task, emptyBaseline, emptyCapabilities);

    expect(result.statements.length).toBeGreaterThanOrEqual(2);

    const explicit = result.statements.filter(
      (s) => s.provenance === "explicit-user",
    );
    expect(explicit.length).toBeGreaterThanOrEqual(2);

    // First statement from "Implement a caching layer"
    expect(explicit[0].text).toContain("caching layer");
    expect(explicit[0].strength).toBe("hard"); // "Implement" is imperative

    // Second statement from "Must reject invalid tokens"
    expect(explicit[1].text).toContain("reject invalid tokens");
    expect(explicit[1].strength).toBe("hard"); // "Must" is imperative
  });

  // ─── Repo-inferred from baseline ──────────────────────────────────────

  it("includes repo-inferred statements from baseline", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: [
        "Schema version must be 1",
        "GoalId must be branded string",
      ],
      architectureConstraints: [],
      repositoryPatterns: [],
    };
    const result = DraftGoalContract("Add feature X", baseline, emptyCapabilities);

    const repoInferred = result.statements.filter(
      (s) => s.provenance === "repo-inferred",
    );
    expect(repoInferred.length).toBe(2);
    expect(repoInferred[0].text).toBe("Schema version must be 1");
    expect(repoInferred[0].strength).toBe("hard");
    expect(repoInferred[1].text).toBe("GoalId must be branded string");
  });

  // ─── Derived from architecture ────────────────────────────────────────

  it("derives completion criteria from architecture constraints", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: [],
      architectureConstraints: [
        "State transitions must follow §3A table",
        "All events require driverFence",
      ],
      repositoryPatterns: [],
    };
    const result = DraftGoalContract("Fix transition bug", baseline, emptyCapabilities);

    const derived = result.statements.filter((s) => s.provenance === "derived");
    expect(derived.length).toBe(2);
    expect(derived[0].text).toBe("State transitions must follow §3A table");
    expect(derived[0].strength).toBe("soft");

    // Architecture constraints also produce completion criteria
    const critDerived = result.completionCriteria.filter(
      (c) => c.provenance === "derived",
    );
    expect(critDerived.length).toBeGreaterThanOrEqual(2);
    expect(critDerived[0].text).toContain("§3A table");
    expect(critDerived[0].verifiable).toBe(true);
  });

  // ─── Invented requirement rejected ────────────────────────────────────

  it("does not include invented requirements outside user task and baseline", () => {
    const task = "Add caching";
    const baseline: BaselineInvariants = {
      inferredRequirements: ["Must use Redis"],
      architectureConstraints: [],
      repositoryPatterns: [],
    };
    const result = DraftGoalContract(task, baseline, emptyCapabilities);

    const allTexts = result.statements.map((s) => s.text.toLowerCase());
    // "Deploy to AWS" was never in user task or baseline
    expect(allTexts.some((t) => t.includes("deploy to aws"))).toBe(false);
    // "Use Kafka" was never in user task or baseline
    expect(allTexts.some((t) => t.includes("use kafka"))).toBe(false);

    // Only user + baseline items present
    const explicit = result.statements.filter(
      (s) => s.provenance === "explicit-user",
    );
    const repoInf = result.statements.filter(
      (s) => s.provenance === "repo-inferred",
    );
    expect(explicit.length + repoInf.length).toBe(result.statements.length);
  });

  // ─── Unverifiable criteria rejected ───────────────────────────────────

  it("rejects unverifiable completion criteria", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: [],
      architectureConstraints: [],
      // Patterns that lack verifiable signals
      repositoryPatterns: [
        "The codebase should feel maintainable",
        "Code quality is important",
      ],
    };
    const result = DraftGoalContract("Refactor module", baseline, emptyCapabilities);

    // Both should be rejected
    const rejected = result.rejectedItems.filter(
      (r) => r.reason === "unverifiable-criteria",
    );
    expect(rejected.length).toBe(2);

    // No completion criteria should come from these unverifiable patterns
    const repoCrits = result.completionCriteria.filter(
      (c) => c.provenance === "repo-inferred",
    );
    expect(repoCrits.length).toBe(0);
  });

  it("accepts verifiable completion criteria", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: [],
      architectureConstraints: [],
      repositoryPatterns: [
        "All tests must pass",
        "TypeScript typecheck has no errors",
      ],
    };
    const result = DraftGoalContract("Fix bug", baseline, emptyCapabilities);

    const repoCrits = result.completionCriteria.filter(
      (c) => c.provenance === "repo-inferred",
    );
    expect(repoCrits.length).toBe(2);
    expect(repoCrits[0].verifiable).toBe(true);
    expect(repoCrits[1].verifiable).toBe(true);
  });

  // ─── Hard vs soft classification ──────────────────────────────────────

  it("classifies imperative user requirements as hard", () => {
    const task = "Must ensure zero errors. Always validate input.";
    const result = DraftGoalContract(task, emptyBaseline, emptyCapabilities);

    const hard = result.statements.filter(
      (s) => s.provenance === "explicit-user" && s.strength === "hard",
    );
    expect(hard.length).toBe(2);
  });

  it("classifies non-imperative user requirements as soft", () => {
    const task = "The feature should be user-friendly. Better error messages.";
    const result = DraftGoalContract(task, emptyBaseline, emptyCapabilities);

    const soft = result.statements.filter(
      (s) => s.provenance === "explicit-user" && s.strength === "soft",
    );
    expect(soft.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies repo-inferred statements as hard", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: ["Schema version must be 1"],
      architectureConstraints: [],
      repositoryPatterns: [],
    };
    const result = DraftGoalContract("Task", baseline, emptyCapabilities);

    const repo = result.statements.filter(
      (s) => s.provenance === "repo-inferred",
    );
    expect(repo.every((s) => s.strength === "hard")).toBe(true);
  });

  it("classifies derived statements as soft", () => {
    const baseline: BaselineInvariants = {
      inferredRequirements: [],
      architectureConstraints: ["Constraint A"],
      repositoryPatterns: [],
    };
    const result = DraftGoalContract("Task", baseline, emptyCapabilities);

    const derived = result.statements.filter(
      (s) => s.provenance === "derived",
    );
    expect(derived.every((s) => s.strength === "soft")).toBe(true);
  });

  // ─── Capability-derived criteria ──────────────────────────────────────

  it("derives capability-dependent criteria when capabilities present", () => {
    const result = DraftGoalContract("Task", emptyBaseline, fullCapabilities);

    const derivedCrits = result.completionCriteria.filter(
      (c) => c.provenance === "derived",
    );
    expect(derivedCrits.length).toBeGreaterThanOrEqual(2);
    expect(derivedCrits.some((c) => c.text.includes("sendUserMessage"))).toBe(
      true,
    );
    expect(
      derivedCrits.some((c) => c.text.includes("session_before_compact")),
    ).toBe(true);
  });

  it("omits capability criteria when capabilities absent", () => {
    const result = DraftGoalContract("Task", emptyBaseline, emptyCapabilities);

    const derivedCrits = result.completionCriteria.filter(
      (c) => c.provenance === "derived",
    );
    expect(derivedCrits.length).toBe(0);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────

  it("returns empty contract for empty task and baseline", () => {
    const result = DraftGoalContract("", emptyBaseline, emptyCapabilities);
    expect(result.statements.length).toBe(0);
    expect(result.completionCriteria.length).toBe(0);
    expect(result.version).toBe(1);
  });

  it("assigns unique IDs to all statements and criteria", () => {
    const task = "Implement X. Must ensure Y.";
    const baseline: BaselineInvariants = {
      inferredRequirements: ["Req A", "Req B"],
      architectureConstraints: ["Constraint C"],
      repositoryPatterns: ["All tests pass"],
    };
    const result = DraftGoalContract(task, baseline, fullCapabilities);

    const stmtIds = result.statements.map((s) => s.id);
    const critIds = result.completionCriteria.map((c) => c.id);

    expect(new Set(stmtIds).size).toBe(stmtIds.length);
    expect(new Set(critIds).size).toBe(critIds.length);
  });
});
