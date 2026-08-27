import { describe, it, expect } from "vitest";
import { compileContext, issueAuthority } from "../../src/context/compiler.js";
import type {
  CompilerConfig,
  ContextRole,
  EntityRef,
  Finding,
  GoalStore,
  SnapshotRefs,
  ContractRef,
  Assignment,
  VerificationResult,
} from "../../src/context/types.js";
import { DEFAULT_TOKEN_BUDGET } from "../../src/context/types.js";

// ── Test fixtures ──────────────────────────────────────────────────

const contracts: ContractRef[] = [
  { id: "c1", kind: "goal", storeKey: "goals/1" },
  { id: "c2", kind: "plan", storeKey: "plans/1" },
  { id: "c3", kind: "assignment", storeKey: "assignments/1" },
  { id: "c4", kind: "verification", storeKey: "verifications/1" },
];

const entities: EntityRef[] = [
  { id: "e1", kind: "file", label: "src/foo.ts", tokenCost: 200 },
  { id: "e2", kind: "file", label: "src/bar.ts", tokenCost: 300 },
  { id: "e3", kind: "file", label: "src/baz.ts", tokenCost: 500 },
];

const findings: Finding[] = [
  { id: "f1", severity: "P1", message: "type mismatch", source: "reviewer", tokenCost: 80 },
  { id: "f2", severity: "P2", message: "unused import", source: "reviewer", tokenCost: 60 },
];

const verificationResults: VerificationResult[] = [
  { contractId: "c4", passed: true, details: "all checks pass", tokenCost: 150 },
];

const assignment: Assignment = {
  id: "a1",
  goalId: "c1",
  workerRole: "worker",
  scope: [entities[0], entities[1]],
  instructions: "fix the type error",
  tokenCost: 400,
};

const baseline: SnapshotRefs["baseline"] = {
  snapshotId: "snap-1",
  timestamp: "2025-01-01T00:00:00Z",
  checksum: "abc123",
};

function makeStore(overrides?: Partial<GoalStore>): GoalStore {
  return {
    contracts,
    baseline,
    findings,
    entities,
    assignment,
    verificationResults,
    ...overrides,
  };
}

// ── Role inclusion / exclusion ─────────────────────────────────────

describe("compileContext — role inclusion", () => {
  it("planner gets contracts with kind goal+plan, baseline, read-only tools", () => {
    const view = compileContext("planner", makeStore(), { baseline });
    const kinds = view.contractRefs.map((c) => c.kind);

    expect(kinds).toContain("goal");
    expect(kinds).toContain("plan");
    expect(kinds).not.toContain("assignment");
    expect(kinds).not.toContain("verification");
    expect(view.baseline).not.toBeNull();
    expect(view.assignment).toBeNull();
    expect(view.verificationResults).toHaveLength(0);
    // planner has read-only tools only
    const toolNames = view.tools.map((t) => t.name);
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
  });

  it("worker gets assignment + scope entities, no baseline, read-only tools", () => {
    const view = compileContext("worker", makeStore(), { baseline });
    expect(view.assignment).not.toBeNull();
    expect(view.assignment!.id).toBe("a1");
    expect(view.baseline).toBeNull();
    expect(view.verificationResults).toHaveLength(0);
    // Worker sees no global findings
    expect(view.findings).toHaveLength(0);
    // Worker gets read-only tools
    const toolNames = view.tools.map((t) => t.name);
    expect(toolNames).not.toContain("bash");
  });

  it("reviewer gets findings + verification, no mutation tools", () => {
    const view = compileContext("reviewer", makeStore(), { baseline });
    expect(view.findings.length).toBeGreaterThan(0);
    expect(view.verificationResults.length).toBeGreaterThan(0);
    expect(view.assignment).toBeNull();
    // Reviewer has read-only tools only
    const toolNames = view.tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("bash");
  });

  it("orchestrator sees all contract kinds and has mutation tools", () => {
    const view = compileContext("orchestrator", makeStore(), { baseline });
    const kinds = view.contractRefs.map((c) => c.kind);
    expect(kinds).toContain("goal");
    expect(kinds).toContain("plan");
    expect(kinds).toContain("assignment");
    expect(kinds).toContain("verification");
    expect(view.findings.length).toBeGreaterThan(0);
    expect(view.verificationResults.length).toBeGreaterThan(0);
    const toolNames = view.tools.map((t) => t.name);
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("bash");
  });
});

// ── Required fields ────────────────────────────────────────────────

describe("compileContext — required fields", () => {
  const roles: ContextRole[] = ["planner", "worker", "reviewer", "orchestrator"];

  for (const role of roles) {
    it(`${role}: all required fields present`, () => {
      const view = compileContext(role, makeStore(), { baseline });
      expect(view).toHaveProperty("role");
      expect(view).toHaveProperty("budget");
      expect(view).toHaveProperty("entities");
      expect(view).toHaveProperty("findings");
      expect(view).toHaveProperty("baseline");
      expect(view).toHaveProperty("contractRefs");
      expect(view).toHaveProperty("assignment");
      expect(view).toHaveProperty("verificationResults");
      expect(view).toHaveProperty("tools");
      expect(view.budget).toHaveProperty("hardLimit");
      expect(view.budget).toHaveProperty("consumed");
      expect(view.budget).toHaveProperty("remaining");
    });
  }
});

// ── Budget enforcement ─────────────────────────────────────────────

describe("compileContext — budget enforcement", () => {
  it("stays within default budget", () => {
    const view = compileContext("planner", makeStore());
    expect(view.budget.hardLimit).toBe(DEFAULT_TOKEN_BUDGET);
    expect(view.budget.consumed + view.budget.remaining).toBe(DEFAULT_TOKEN_BUDGET);
    expect(view.budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it("respects custom budget limit", () => {
    const config: CompilerConfig = { budgetLimit: 500 };
    const view = compileContext("planner", makeStore(), undefined, config);
    expect(view.budget.hardLimit).toBe(500);
    expect(view.budget.consumed + view.budget.remaining).toBe(500);
  });

  it("fills greedily by cheapest first", () => {
    // Very small budget — only cheapest items fit
    const config: CompilerConfig = { budgetLimit: 160 };
    const view = compileContext("reviewer", makeStore(), { baseline }, config);
    // Should include findings (60, 80) and possibly a verification (150)
    // But 60+80=140 fits, 140+150=290 exceeds 160
    const totalCost =
      view.findings.reduce((s, f) => s + f.tokenCost, 0) +
      view.verificationResults.reduce((s, v) => s + v.tokenCost, 0);
    expect(totalCost).toBeLessThanOrEqual(160);
  });
});

// ── Overflow handling ──────────────────────────────────────────────

describe("compileContext — overflow handling", () => {
  it("produces empty collections when budget is zero", () => {
    const config: CompilerConfig = { budgetLimit: 0 };
    const view = compileContext("planner", makeStore(), { baseline }, config);
    expect(view.contractRefs).toHaveLength(0);
    expect(view.findings).toHaveLength(0);
    expect(view.entities).toHaveLength(0);
    expect(view.verificationResults).toHaveLength(0);
    expect(view.budget.consumed).toBe(0);
    expect(view.budget.remaining).toBe(0);
  });

  it("assignment excluded when budget cannot cover it", () => {
    // assignment costs 400; give just enough for contracts but not assignment
    const config: CompilerConfig = { budgetLimit: 210 };
    const view = compileContext("worker", makeStore(), undefined, config);
    // 210 budget, 100 for goal contract, 100 for assignment contract, 10 left — not enough for assignment (400)
    expect(view.assignment).toBeNull();
  });

  it("large entity list truncated to fit budget", () => {
    const bigEntities: EntityRef[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      kind: "file",
      label: `src/file${i}.ts`,
      tokenCost: 300,
    }));
    const store = makeStore({ entities: bigEntities });
    const config: CompilerConfig = { budgetLimit: 1000 };
    const view = compileContext("planner", store, undefined, config);
    // 1000 budget, ~300 per entity = max 3 entities (900)
    expect(view.entities.length).toBeLessThanOrEqual(4);
    expect(view.entities.length).toBeGreaterThan(0);
  });
});

// ── Frozen output ──────────────────────────────────────────────────

describe("compileContext — frozen output", () => {
  it("GoalContextView is frozen", () => {
    const view = compileContext("planner", makeStore(), { baseline });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.budget)).toBe(true);
    expect(Object.isFrozen(view.entities)).toBe(true);
    expect(Object.isFrozen(view.findings)).toBe(true);
    expect(Object.isFrozen(view.contractRefs)).toBe(true);
    expect(Object.isFrozen(view.tools)).toBe(true);
  });
});

// ── issueAuthority ─────────────────────────────────────────────────

describe("issueAuthority", () => {
  it("reviewer receipt has no mutation tools", () => {
    const receipt = issueAuthority("reviewer");
    expect(receipt.role).toBe("reviewer");
    expect(receipt.allowedTools).not.toContain("write");
    expect(receipt.allowedTools).not.toContain("edit");
    expect(receipt.allowedTools).not.toContain("bash");
    expect(receipt.lease).toBeUndefined();
  });

  it("worker receipt can carry a lease", () => {
    const lease = {
      assignmentId: "a1",
      entityIds: ["e1"],
      expiresAt: "2025-12-31T23:59:59Z",
      tokenCost: 0,
    };
    const receipt = issueAuthority("worker", lease);
    expect(receipt.lease).toBeDefined();
    expect(receipt.lease!.assignmentId).toBe("a1");
  });
});
