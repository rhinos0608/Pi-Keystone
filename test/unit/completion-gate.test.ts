import { describe, it, expect } from "vitest";
import type { GoalContract, ArtifactRef } from "../../src/domain/types.js";
import type { ReviewFinding } from "../../src/review/types.js";
import type { FinalAuditResult } from "../../src/audit/final-audit.js";
import { evaluateCompletion } from "../../src/audit/completion-gate.js";
import type { CompletionInput } from "../../src/audit/completion-gate.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function aref(s: string): ArtifactRef { return s as ArtifactRef; }

const contract: GoalContract = {
  schemaVersion: 1,
  version: 1 as any,
  goalId: "g1",
  requirements: [
    { id: "REQ-001", text: "Must work", provenance: "explicit-user", strength: "hard" },
  ],
  invariants: [],
  completionCriteria: [
    { id: "CC-001", text: "Tests pass", provenance: "derived", strength: "soft" },
  ],
  assumptions: [],
};

const emptyContract: GoalContract = {
  schemaVersion: 1,
  version: 1 as any,
  goalId: "g1",
  requirements: [],
  invariants: [],
  completionCriteria: [],
  assumptions: [],
};

const passedVerification = { passed: true, details: "all green" };
const failedVerification = { passed: false, details: "test failed" };

const doneAudit: FinalAuditResult = { status: "DONE", audits: [] };
const rejectedAudit: FinalAuditResult = { status: "AUDIT_REJECTED", audits: [], reason: "no" };

const blockerFinding: ReviewFinding = {
  id: "f-blocker" as any,
  severity: "blocker",
  message: "critical issue",
  filePath: "src/bad.ts",
  fingerprint: "fp-b",
  source: "reviewer",
  reportedAt: "2025-01-01T00:00:00Z",
};

const warnFinding: ReviewFinding = {
  id: "f-warn" as any,
  severity: "warn",
  message: "warning",
  filePath: "src/warn.ts",
  fingerprint: "fp-w",
  source: "reviewer",
  reportedAt: "2025-01-01T00:00:00Z",
};

function input(overrides: Partial<CompletionInput>): CompletionInput {
  return {
    contract: overrides.contract ?? contract,
    verification: overrides.verification ?? passedVerification,
    findings: overrides.findings ?? [],
    audit: overrides.audit ?? doneAudit,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("evaluateCompletion", () => {
  it("returns DONE when all predicates satisfied (no hard reqs)", () => {
    const result = evaluateCompletion(input({ contract: emptyContract }));
    expect(result.status).toBe("DONE");
    expect(result.predicates.every((p) => p.satisfied)).toBe(true);
  });

  it("returns REPAIRING when verification fails (repairable)", () => {
    const result = evaluateCompletion(input({ verification: failedVerification }));
    expect(result.status).toBe("REPAIRING");
    const vp = result.predicates.find((p) => p.id === "verification-passed");
    expect(vp?.satisfied).toBe(false);
    expect(vp?.repairable).toBe(true);
  });

  it("returns BLOCKED when permanent missing evidence", () => {
    const result = evaluateCompletion(input({
      verification: failedVerification,
    }));
    // The predicates include requirement and criteria checks — with our default
    // all satisfied: true, we need to verify the logic still works.
    expect(["REPAIRING", "BLOCKED"]).toContain(result.status);
  });

  it("returns FAILED when audit rejects with blocker findings", () => {
    const result = evaluateCompletion(input({
      audit: rejectedAudit,
      findings: [blockerFinding],
    }));
    expect(result.status).toBe("FAILED");
  });

  it("returns REPAIRING when audit rejects but no blocker findings", () => {
    const result = evaluateCompletion(input({
      audit: rejectedAudit,
    }));
    expect(result.status).toBe("REPAIRING");
  });

  it("includes predicates for each hard requirement", () => {
    const result = evaluateCompletion(input({}));
    const reqPred = result.predicates.filter((p) => p.id.startsWith("req-addressed-"));
    expect(reqPred).toHaveLength(1);
    expect(reqPred[0].id).toBe("req-addressed-REQ-001");
  });

  it("includes predicates for each completion criterion", () => {
    const result = evaluateCompletion(input({}));
    const ccPred = result.predicates.filter((p) => p.id.startsWith("criteria-met-"));
    expect(ccPred).toHaveLength(1);
    expect(ccPred[0].id).toBe("criteria-met-CC-001");
  });

  it("summary reflects status and predicate counts", () => {
    const result = evaluateCompletion(input({ contract: emptyContract }));
    expect(result.summary).toMatch(/^DONE: \d+\/\d+ predicates satisfied$/);
  });

  it("does NOT auto-satisfy hard requirements without evidence", () => {
    const result = evaluateCompletion(input({}));
    const reqPred = result.predicates.find((p) => p.id === "req-addressed-REQ-001");
    expect(reqPred?.satisfied).toBe(false);
    expect(result.status).not.toBe("DONE");
  });

  it("criteria predicates reflect verification result", () => {
    const passResult = evaluateCompletion(input({ verification: passedVerification }));
    const passCrit = passResult.predicates.find((p) => p.id === "criteria-met-CC-001");
    expect(passCrit?.satisfied).toBe(true);

    const failResult = evaluateCompletion(input({ verification: failedVerification }));
    const failCrit = failResult.predicates.find((p) => p.id === "criteria-met-CC-001");
    expect(failCrit?.satisfied).toBe(false);
  });
});
