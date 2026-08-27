import { describe, it, expect } from "vitest";
import type { AssignmentId, ArtifactRef, GoalContract } from "../../src/domain/types.js";
import type { AssignmentIndex } from "../../src/execution/assignment-index.js";
import type { AuditorSession, FinalAuditInput } from "../../src/audit/final-audit.js";
import { runFinalAudit, buildEvidenceChecklist } from "../../src/audit/final-audit.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function aid(s: string): AssignmentId { return s as AssignmentId; }
function aref(s: string): ArtifactRef { return s as ArtifactRef; }

const contract: GoalContract = {
  schemaVersion: 1,
  version: 1 as any,
  goalId: "g1",
  requirements: [
    { id: "REQ-001", text: "Must work", provenance: "explicit-user", strength: "hard" },
  ],
  invariants: [
    { id: "INV-001", text: "No regression", provenance: "repo-inferred", strength: "hard" },
  ],
  completionCriteria: [
    { id: "CC-001", text: "Tests pass", provenance: "derived", strength: "soft" },
  ],
  assumptions: [],
};

function makeEntry(
  sessionId: string,
  role: string,
  appendedAt: string = "2025-01-01T00:00:00Z",
): import("../../src/execution/assignment-index.js").AssignmentIndexEntry {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    role,
    planEpoch: 0,
    mutationCapable: false,
    appendedAt,
  };
}

function auditorEntry(sessionId: string): import("../../src/execution/assignment-index.js").AssignmentIndexEntry {
  return makeEntry(sessionId, "auditor");
}

function makeIndex(entries: { sessionId: string; role: string; appendedAt?: string }[]): AssignmentIndex {
  return {
    version: 1,
    entries: entries.map((e) => makeEntry(e.sessionId, e.role, e.appendedAt)),
  };
}

function auditor(sessionId: string, outcome: "ACCEPTED" | "REJECTED"): AuditorSession {
  return {
    sessionId,
    runId: `run-${sessionId}`,
    outcome,
    findings: [],
    evidenceChecklist: [
      { artifactRef: aref("REQ-001"), description: "Must work", present: true },
      { artifactRef: aref("INV-001"), description: "No regression", present: true },
      { artifactRef: aref("CC-001"), description: "Tests pass", present: true },
    ],
  };
}

function makeInput(index: AssignmentIndex, sessions: [AuditorSession, AuditorSession]): FinalAuditInput {
  return {
    goalId: "g1",
    contract,
    baselineRef: aref("base-1"),
    deltaRef: null,
    findings: [],
    snapshotRefs: [],
    assignmentIndex: index,
    auditorSessions: sessions,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("runFinalAudit", () => {
  it("returns DONE when both auditors accept with valid identities", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("DONE");
  });

  it("rejects when both sessions share the same sessionId", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-a", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("same sessionId");
    }
  });

  it("rejects when auditor not in AssignmentIndex", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor" },
    ]); // sess-b missing
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("sess-b");
    }
  });

  it("rejects when one auditor rejects", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "REJECTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("sess-b");
    }
  });

  it("rejects when evidence checklist has missing items", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const s1: AuditorSession = {
      ...auditor("sess-a", "ACCEPTED"),
      evidenceChecklist: [
        { artifactRef: aref("REQ-001"), description: "Must work", present: false },
      ],
    };
    const input = makeInput(index, [s1, auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("Missing evidence");
    }
  });

  // ─── Collusion prevention ─────────────────────────────────────────────

  it("rejects when auditor sessionId is also used as planner", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "planner" },   // colluding entry
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("planner");
      expect(result.reason).toContain("collusion");
    }
  });

  it("rejects when auditor sessionId is also used as implementer", () => {
    const index = makeIndex([
      { sessionId: "sess-b", role: "implementer" },  // colluding entry
      { sessionId: "sess-a", role: "auditor" },
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("implementer");
      expect(result.reason).toContain("collusion");
    }
  });

  // ─── Fresh session requirement ────────────────────────────────────────

  it("rejects when auditor was registered before the last non-auditor entry", () => {
    // Non-auditor entry at 10:00, auditor at 09:00 (before non-auditor)
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor", appendedAt: "2025-01-01T09:00:00Z" },
      { sessionId: "sess-c", role: "planner", appendedAt: "2025-01-01T10:00:00Z" },
      { sessionId: "sess-b", role: "auditor", appendedAt: "2025-01-01T11:00:00Z" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("sess-a");
      expect(result.reason).toContain("not fresh");
    }
  });

  it("accepts when auditor was registered after all non-auditor entries", () => {
    // Non-auditor at 09:00, both auditors at 10:00+
    const index = makeIndex([
      { sessionId: "sess-c", role: "planner", appendedAt: "2025-01-01T09:00:00Z" },
      { sessionId: "sess-a", role: "auditor", appendedAt: "2025-01-01T10:00:00Z" },
      { sessionId: "sess-b", role: "auditor", appendedAt: "2025-01-01T11:00:00Z" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("DONE");
  });

  it("rejects when both auditors are stale (registered before non-auditor)", () => {
    const index = makeIndex([
      { sessionId: "sess-a", role: "auditor", appendedAt: "2025-01-01T08:00:00Z" },
      { sessionId: "sess-b", role: "auditor", appendedAt: "2025-01-01T08:30:00Z" },
      { sessionId: "sess-c", role: "planner", appendedAt: "2025-01-01T09:00:00Z" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
  });

  it("rejects when auditor entry has role but it's not 'auditor'", () => {
    // Entry exists but with wrong role
    const index = makeIndex([
      { sessionId: "sess-a", role: "reviewer" },  // not "auditor"
      { sessionId: "sess-b", role: "auditor" },
    ]);
    const input = makeInput(index, [auditor("sess-a", "ACCEPTED"), auditor("sess-b", "ACCEPTED")]);
    const result = runFinalAudit(input);
    expect(result.status).toBe("AUDIT_REJECTED");
    if (result.status === "AUDIT_REJECTED") {
      expect(result.reason).toContain("sess-a");
    }
  });
});

describe("buildEvidenceChecklist", () => {
  it("covers requirements, invariants, and completion criteria", () => {
    const items = buildEvidenceChecklist(contract, new Map([["REQ-001", true]]));
    expect(items).toHaveLength(3); // 1 req + 1 inv + 1 cc
    expect(items[0].present).toBe(true);  // REQ-001
    expect(items[1].present).toBe(false); // INV-001 not in map
    expect(items[2].present).toBe(false); // CC-001 not in map
  });
});
