import { describe, it, expect } from "vitest";
import {
  createEvidenceGraph,
  type AssertionInput,
} from "../../src/evidence/graph.js";
import { UnknownCriterionError } from "../../src/evidence/types.js";
import {
  evaluateCriteria,
  toCriterionEvaluation,
  evaluateCriterion,
  type Evidence,
} from "../../src/verification/criterion-evaluator.js";
import { runVerificationPerCriterion } from "../../src/verification/verification-run.js";
import { evaluateCompletion } from "../../src/audit/completion-gate.js";
import { runFinalAudit } from "../../src/audit/final-audit.js";
import type { CompletionCriterion } from "../../src/contract/draft.js";
import type { GoalContract, ArtifactRef } from "../../src/domain/types.js";
import type { AssignmentIndex } from "../../src/execution/assignment-index.js";
import type { AuditorSession } from "../../src/audit/final-audit.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function crit(id: string, text = "tests pass"): CompletionCriterion {
  return { id, text, verifiable: true, provenance: "derived", strength: "hard" };
}

function proofEvidence(): Evidence {
  return {
    hardProofs: [
      { kind: "command-output", command: "npm test", exitCode: 0, success: true, output: "tests pass" },
    ],
    descriptions: [],
  };
}

function contractWithReq(): GoalContract {
  return {
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
}

function makeIndex(): AssignmentIndex {
  const entry = (sessionId: string) => ({
    runId: `run-${sessionId}`,
    sessionId,
    role: "auditor",
    planEpoch: 0,
    mutationCapable: false,
    appendedAt: "2025-01-01T00:00:00Z",
  });
  return { version: 1, entries: [entry("sess-a"), entry("sess-b")] } as unknown as AssignmentIndex;
}

function auditorWithClaims(sessionId: string, claims: AuditorSession["claims"]): AuditorSession {
  return {
    sessionId,
    runId: `run-${sessionId}`,
    outcome: "ACCEPTED",
    findings: [],
    evidenceChecklist: [
      { artifactRef: "REQ-001" as unknown as ArtifactRef, description: "Must work", present: true },
    ],
    claims,
  };
}

// ─── Evidence graph ───────────────────────────────────────────────────────

describe("evidence graph", () => {
  it("resolves chains per criterion with coverage summary", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "pass", reason: "npm test green" });
    g.attachRun(a1, { runId: "run-1" });
    g.attachSnapshot("CC-001", "rev-1");
    g.addCriterion("CC-002", "Lint clean");
    const m = g.manifestFor(["CC-001", "CC-002"]);
    expect(m.chains).toHaveLength(2);
    expect(m.chains[0].assertions[0].runIds).toEqual([`run:run-1`]);
    expect(m.chains[0].snapshotRevisionId).toBe("snapshot:CC-001:rev-1");
    expect(m.coverage).toMatchObject({ total: 2, covered: 1, uncovered: ["CC-002"] });
    expect(m.nodeIds).toContain(a1);
  });

  it("manifestFor rejects unknown criteria with a typed error", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001");
    expect(() => g.manifestFor(["CC-001", "NOPE"])).toThrowError(UnknownCriterionError);
  });

  it("attachAssertion to an unknown criterion rejects", () => {
    const g = createEvidenceGraph();
    const bad: AssertionInput = { verdict: "pass" };
    expect(() => g.attachAssertion("GHOST", bad)).toThrowError(UnknownCriterionError);
  });

  it("pass+fail assertions leave the criterion uncovered (fail-closed conflict policy)", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    g.attachAssertion("CC-001", { verdict: "pass", reason: "green on retry" });
    g.attachAssertion("CC-001", { verdict: "fail", reason: "red on main" });
    const m = g.manifestFor(["CC-001"]);
    expect(m.coverage.covered).toBe(0);
    expect(m.coverage.uncovered).toEqual(["CC-001"]);
  });
});

// ─── Per-criterion evaluation ─────────────────────────────────────────────

describe("per-criterion results", () => {
  it("evaluateCriteria records pass/fail/skipped with reason and refs", () => {
    const results = evaluateCriteria([
      { criterion: crit("c1"), evidence: proofEvidence() },
      { criterion: crit("c2", "deploy works"), evidence: { hardProofs: [], descriptions: [] } },
    ]);
    expect(results[0]).toMatchObject({ criterionId: "c1", status: "pass" });
    expect(results[0].evidenceRefs).toContain("npm test");
    expect(typeof results[0].reason).toBe("string");
    // "deploy works" has no matching evidence → insufficient-evidence → skipped
    expect(results[1].status).toBe("skipped");
  });

  it("toCriterionEvaluation maps unsatisfied to fail", () => {
    const r = evaluateCriterion(crit("c9"), {
      hardProofs: [
        { kind: "command-output", command: "npm test", exitCode: 1, success: false, output: "tests pass but failed" },
      ],
      descriptions: [],
    });
    // keyword matches but proof failed → unsatisfied → fail
    expect(toCriterionEvaluation(r, {
      hardProofs: [
        { kind: "command-output", command: "npm test", exitCode: 1, success: false, output: "x" },
      ],
      descriptions: [],
    }).status).toBe("fail");
  });

  it("runVerificationPerCriterion is PASS only when every criterion passes", () => {
    const all = runVerificationPerCriterion([
      { criterion: crit("c1"), evidence: proofEvidence() },
    ]);
    expect(all.overall).toBe("PASS");
    expect(all.perCriterion).toHaveLength(1);
    const mixed = runVerificationPerCriterion([
      { criterion: crit("c1"), evidence: proofEvidence() },
      { criterion: crit("c2", "deploy works"), evidence: { hardProofs: [], descriptions: [] } },
    ]);
    expect(mixed.overall).toBe("FAIL"); // skipped fails closed
  });
});

// ─── Completion gate from evidence ────────────────────────────────────────

describe("completion gate from evidence graph", () => {
  const verification = { passed: true, details: "all green" };
  const audit = { status: "DONE" as const, audits: [] };

  it("hard-requirement goal completes ONLY when the evidence chain passes", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "pass", reason: "green" });
    const manifest = g.manifestFor(["CC-001"]);

    // No refs → fail-closed, not DONE
    const noRefs = evaluateCompletion({
      contract: contractWithReq(),
      verification,
      findings: [],
      audit,
      evidenceManifest: manifest,
      requirementSources: [],
    });
    expect(noRefs.predicates.find((p) => p.id === "req-addressed-REQ-001")?.satisfied).toBe(false);
    expect(noRefs.status).not.toBe("DONE");

    // Passing chain → DONE
    const done = evaluateCompletion({
      contract: contractWithReq(),
      verification,
      findings: [],
      audit,
      evidenceManifest: manifest,
      requirementSources: [{ requirementId: "REQ-001", assertionIds: [a1] }],
    });
    expect(done.predicates.find((p) => p.id === "req-addressed-REQ-001")?.satisfied).toBe(true);
    expect(done.status).toBe("DONE");
  });

  it("failing assertion chain keeps the requirement unsatisfied", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "fail", reason: "red" });
    const manifest = g.manifestFor(["CC-001"]);
    const result = evaluateCompletion({
      contract: contractWithReq(),
      verification,
      findings: [],
      audit,
      evidenceManifest: manifest,
      requirementSources: [{ requirementId: "REQ-001", assertionIds: [a1] }],
    });
    expect(result.predicates.find((p) => p.id === "req-addressed-REQ-001")?.satisfied).toBe(false);
    expect(result.status).not.toBe("DONE");
  });
});

// ─── Final audit against manifest ─────────────────────────────────────────

describe("final audit against manifest", () => {
  it("rejects an auditor claim referencing an unknown manifest ID", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "pass", reason: "green" });
    const manifest = g.manifestFor(["CC-001"]);
    const input = {
      goalId: "g1",
      contract: contractWithReq(),
      baselineRef: null,
      deltaRef: null,
      findings: [],
      snapshotRefs: [],
      assignmentIndex: makeIndex(),
      auditorSessions: [
        auditorWithClaims("sess-a", [{ nodeId: a1, statement: "verified" }]),
        auditorWithClaims("sess-b", [{ nodeId: "assertion:CC-001:999", statement: "bogus" }]),
      ] as [AuditorSession, AuditorSession],
      manifest,
    };
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("UnknownEvidenceIdError");
      expect(result.reason).toContain("assertion:CC-001:999");
    }
  });

  it("accepts when all claims reference manifest IDs and coverage is complete", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "pass", reason: "green" });
    g.attachArtifact(a1, "REQ-001");
    const manifest = g.manifestFor(["CC-001"]);
    const input = {
      goalId: "g1",
      contract: contractWithReq(),
      baselineRef: null,
      deltaRef: null,
      findings: [],
      snapshotRefs: [],
      assignmentIndex: makeIndex(),
      auditorSessions: [
        auditorWithClaims("sess-a", [{ nodeId: a1, statement: "verified" }]),
        auditorWithClaims("sess-b", [{ nodeId: "criterion:CC-001", statement: "in scope" }]),
      ] as [AuditorSession, AuditorSession],
      manifest,
    };
    expect(runFinalAudit(input).status).toBe("DONE");
  });

  it("rejects when manifest coverage is incomplete", () => {
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const manifest = g.manifestFor(["CC-001"]); // no passing assertion
    const input = {
      goalId: "g1",
      contract: contractWithReq(),
      baselineRef: null,
      deltaRef: null,
      findings: [],
      snapshotRefs: [],
      assignmentIndex: makeIndex(),
      auditorSessions: [
        auditorWithClaims("sess-a", []),
        auditorWithClaims("sess-b", []),
      ] as [AuditorSession, AuditorSession],
      manifest,
    };
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("coverage");
    }
  });
});

// ─── Completion report with evidence ──────────────────────────────────────

describe("completion report with evidence", () => {
  it("renders predicate statuses and coverage when evidence is provided", async () => {
    const { createGoalRecord } = await import("../../src/domain/goal-record.js");
    const { formatCompletion } = await import("../../src/ui/completion-report.js");
    const g = createEvidenceGraph();
    g.addCriterion("CC-001", "Tests pass");
    const a1 = g.attachAssertion("CC-001", { verdict: "pass", reason: "green" });
    const manifest = g.manifestFor(["CC-001"]);
    const gate = evaluateCompletion({
      contract: contractWithReq(),
      verification: { passed: true, details: "all green" },
      findings: [],
      audit: { status: "DONE", audits: [] },
      evidenceManifest: manifest,
      requirementSources: [{ requirementId: "REQ-001", assertionIds: [a1] }],
    });
    const goal = {
      ...createGoalRecord(
        "goal-1" as any,
        "add login",
        { requestedRoot: "/tmp/t", canonicalRoot: "/tmp/t", projectKey: "k", vcs: "git" } as any,
        {
          snapshotId: "s" as any, observedAt: new Date().toISOString() as any,
          gitHead: "h", branch: "main", graphRevision: 1, dirtySignature: "d", capabilityDigest: "c",
        } as any,
      ),
      state: "DONE" as const,
    };
    const report = formatCompletion(goal, {
      gate,
      manifestNodeIds: manifest.nodeIds,
      coverage: manifest.coverage,
    });
    expect(report.predicates?.find((pr) => pr.id === "req-addressed-REQ-001")?.satisfied).toBe(true);
    expect(report.coverage).toMatchObject({ total: 1, covered: 1 });
    const satisfied = gate.predicates.filter((pr) => pr.satisfied).length;
    expect(report.summary).toContain(`${satisfied}/${gate.predicates.length} predicates satisfied`);
    expect(report.evidenceRefs).toContain(a1);
  });
});
