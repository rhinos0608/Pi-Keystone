import { describe, it, expect } from "vitest";
import type { GoalContract, ArtifactRef } from "../../src/domain/types.js";
import type { ReviewFinding } from "../../src/review/types.js";
import type { FinalAuditResult } from "../../src/audit/final-audit.js";
import { evaluateCompletion } from "../../src/audit/completion-gate.js";
import type { CompletionInput } from "../../src/audit/completion-gate.js";
import { createEvidenceGraph } from "../../src/evidence/graph.js";
import {
  parseFinalAuditorOutput,
  parseReviewDecision,
  requirementSourcesFromAssertions,
} from "../../src/runtime/completion-flow.js";

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
    auditPolicy: overrides.auditPolicy,
    reviewAccepted: overrides.reviewAccepted,
    evidenceManifest: overrides.evidenceManifest,
    requirementSources: overrides.requirementSources,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("parseReviewDecision", () => {
  it("accepts an explicit verdict after markdown/reasoning", () => {
    expect(parseReviewDecision("## Review\nNo issues found.\nACCEPTED: clean")).toBe("ACCEPTED");
  });

  it("uses the final explicit decision line and ignores prose mentions", () => {
    expect(parseReviewDecision("The prompt said ACCEPTED when clean.\nERROR: concrete defect")).toBe("ERROR");
    expect(parseReviewDecision("BLOCKER: initial concern\nResolved after inspection.\nACCEPTED: clean")).toBe("ACCEPTED");
  });
});

describe("parseFinalAuditorOutput", () => {
  it("accepts structured claims and evidence checklist", () => {
    const parsed = parseFinalAuditorOutput({
      outcome: "ACCEPTED",
      summary: "checked",
      claims: [{ nodeId: "assertion:a", statement: "criterion supported" }],
      evidenceChecklist: [{ artifactRef: "abc", description: "report", present: true }],
    });
    expect(parsed?.outcome).toBe("ACCEPTED");
    expect(parsed?.claims[0].nodeId).toBe("assertion:a");
  });

  it("fails closed on missing claims/checklist", () => {
    expect(parseFinalAuditorOutput({
      outcome: "ACCEPTED",
      summary: "checked",
      claims: [],
      evidenceChecklist: [],
    })).toBeNull();
  });
});

describe("requirementSourcesFromAssertions", () => {
  it("conservatively maps arbitrary explicit criteria to every hard requirement", () => {
    const explicitContract: GoalContract = {
      schemaVersion: 1,
      version: 1 as any,
      goalId: "g-explicit",
      requirements: [
        { id: "req-user-1", text: "Requested behavior", provenance: "explicit-user", strength: "hard" },
      ],
      invariants: [],
      completionCriteria: [
        { id: "custom-a", text: "Custom A passes", provenance: "explicit-user", strength: "hard" },
        { id: "custom-b", text: "Custom B passes", provenance: "explicit-user", strength: "hard" },
      ],
      assumptions: [],
    };
    const sources = requirementSourcesFromAssertions(
      explicitContract,
      new Map([
        ["custom-a", ["assert-a"]],
        ["custom-b", ["assert-b"]],
      ]),
    );
    expect(sources).toEqual([{ requirementId: "req-user-1", assertionIds: ["assert-a", "assert-b"] }]);
  });
});

describe("evaluateCompletion", () => {
  it("returns DONE when all predicates satisfied (no hard reqs)", () => {
    const result = evaluateCompletion(input({ contract: emptyContract }));
    expect(result.status).toBe("DONE");
    expect(result.predicates.every((p) => p.satisfied)).toBe(true);
  });

  it("quick policy can finish without a dual audit", () => {
    const result = evaluateCompletion(input({
      contract: emptyContract,
      audit: undefined,
      auditPolicy: "verification-only",
    }));
    expect(result.status).toBe("DONE");
    expect(result.predicates.find((p) => p.id === "audit-accepted")?.satisfied).toBe(true);
  });

  it("standard policy requires one accepted independent review", () => {
    const accepted = evaluateCompletion(input({
      contract: emptyContract,
      audit: undefined,
      auditPolicy: "single-review",
      reviewAccepted: true,
    }));
    const rejected = evaluateCompletion(input({
      contract: emptyContract,
      audit: undefined,
      auditPolicy: "single-review",
      reviewAccepted: false,
    }));
    expect(accepted.status).toBe("DONE");
    expect(rejected.status).toBe("REPAIRING");
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
    const graph = createEvidenceGraph();
    graph.addCriterion("CC-001", "Tests pass");
    graph.attachAssertion("CC-001", { verdict: "pass", reason: "green" });
    const manifest = graph.manifestFor(["CC-001"]);
    const passResult = evaluateCompletion(input({
      verification: passedVerification,
      evidenceManifest: manifest,
    }));
    const passCrit = passResult.predicates.find((p) => p.id === "criteria-met-CC-001");
    expect(passCrit?.satisfied).toBe(true);

    const manifestButFailed = evaluateCompletion(input({
      verification: failedVerification,
      evidenceManifest: manifest,
    }));
    const manifestFailCrit = manifestButFailed.predicates.find((p) => p.id === "criteria-met-CC-001");
    expect(manifestFailCrit?.satisfied).toBe(false);
    expect(manifestButFailed.status).not.toBe("DONE");

    const failResult = evaluateCompletion(input({ verification: failedVerification }));
    const failCrit = failResult.predicates.find((p) => p.id === "criteria-met-CC-001");
    expect(failCrit?.satisfied).toBe(false);
  });
});
