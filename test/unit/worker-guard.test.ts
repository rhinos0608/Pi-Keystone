/// <reference types="node" />

import { describe, it, expect } from "vitest";
import { registerWorkerGuard, type ToolPolicy } from "../../src/execution/worker-guard.js";

// ─── read-only blocks mutation ───────────────────────────────────────────────

describe("worker-guard — read-only blocks mutation", () => {
  const sessionId = "test-session-1";
  const guard = registerWorkerGuard({ kind: "read-only" }, { sessionId });

  it("allows read tools", () => {
    const result = guard.check({ toolCallId: "tc-1", toolName: "read", sessionId });
    expect(result.decision).toBe("allow");
  });

  it("denies bash", () => {
    const result = guard.check({ toolCallId: "tc-2", toolName: "bash", sessionId });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toContain("bash");
      expect(result.attestationNonce).toBe(guard.attestationNonce);
    }
  });

  it("denies write", () => {
    const result = guard.check({ toolCallId: "tc-3", toolName: "write", sessionId });
    expect(result.decision).toBe("deny");
  });

  it("denies edit", () => {
    const result = guard.check({ toolCallId: "tc-4", toolName: "edit", sessionId });
    expect(result.decision).toBe("deny");
  });
});

// ─── session mismatch ───────────────────────────────────────────────────────

describe("worker-guard — session mismatch", () => {
  const guard = registerWorkerGuard({ kind: "read-only" }, { sessionId: "correct-session" });

  it("denies when sessionId does not match", () => {
    const result = guard.check({
      toolCallId: "tc-5",
      toolName: "read",
      sessionId: "wrong-session",
    });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toContain("session mismatch");
    }
  });
});

// ─── mutation with permit ───────────────────────────────────────────────────

describe("worker-guard — mutation with permit", () => {
  const sessionId = "mut-session";
  const guard = registerWorkerGuard(
    { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
    {
      sessionId,
      lease: { leaseId: "lease-1", root: "/tmp", fencingToken: 1, expiresAt: Date.now() + 60_000 },
    },
  );

  it("allows edit/write when permit matches the bound lease", () => {
    const result = guard.check({ toolCallId: "tc-6", toolName: "write", sessionId });
    expect(result.decision).toBe("allow");
  });

  it("denies bash without an exact approved command", () => {
    const result = guard.check({ toolCallId: "tc-6b", toolName: "bash", sessionId, command: "npm test" });
    expect(result.decision).toBe("deny");
  });

  it("records a receipt for the checked call", () => {
    expect(guard.receipts.some((r) => r.toolCallId === "tc-6" && r.decision === "allow")).toBe(true);
  });

  it("denies when the permit binds to another lease", () => {
    const other = registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-other", fencingToken: 1 } },
      {
        sessionId,
        lease: { leaseId: "lease-1", root: "/tmp", fencingToken: 1, expiresAt: Date.now() + 60_000 },
      },
    );
    const result = other.check({ toolCallId: "tc-7", toolName: "write", sessionId });
    expect(result.decision).toBe("deny");
  });
});

// ─── mutation lease-root and assignment binding ───────────────────────────

describe("worker-guard — mutation lease binding", () => {
  const sessionId = "bind-session";

  it("denies when the lease root is empty", () => {
    const guard = registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
      {
        sessionId,
        lease: { leaseId: "lease-1", root: "", fencingToken: 1, expiresAt: Date.now() + 60_000 },
      },
    );
    const result = guard.check({ toolCallId: "tc-b1", toolName: "write", sessionId });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("non-empty lease root");
  });

  it("denies when the lease assignment mismatches the expected assignment", () => {
    const guard = registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
      {
        sessionId,
        assignmentId: "asgn-1",
        lease: {
          leaseId: "lease-1",
          root: "/tmp",
          fencingToken: 1,
          expiresAt: Date.now() + 60_000,
          assignmentId: "asgn-other",
        },
      },
    );
    const result = guard.check({ toolCallId: "tc-b2", toolName: "write", sessionId });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("assignment mismatch");
  });

  it("denies when the event assignment mismatches the expected assignment", () => {
    const guard = registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
      {
        sessionId,
        assignmentId: "asgn-1",
        lease: { leaseId: "lease-1", root: "/tmp", fencingToken: 1, expiresAt: Date.now() + 60_000 },
      },
    );
    const result = guard.check({
      toolCallId: "tc-b3",
      toolName: "write",
      sessionId,
      assignmentId: "asgn-other",
    });
    expect(result.decision).toBe("deny");
  });

  it("allows when lease and event assignments agree", () => {
    const guard = registerWorkerGuard(
      { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 1 } },
      {
        sessionId,
        assignmentId: "asgn-1",
        lease: {
          leaseId: "lease-1",
          root: "/tmp",
          fencingToken: 1,
          expiresAt: Date.now() + 60_000,
          assignmentId: "asgn-1",
        },
      },
    );
    const result = guard.check({
      toolCallId: "tc-b4",
      toolName: "write",
      sessionId,
      assignmentId: "asgn-1",
    });
    expect(result.decision).toBe("allow");
  });
});

// ─── attestation nonce unique per guard ─────────────────────────────────────

describe("worker-guard — attestation nonce", () => {
  it("two guards have different nonces", () => {
    const g1 = registerWorkerGuard({ kind: "read-only" }, { sessionId: "s1" });
    const g2 = registerWorkerGuard({ kind: "read-only" }, { sessionId: "s2" });
    expect(g1.attestationNonce).not.toBe(g2.attestationNonce);
  });
});


// ─── negative mutation denial — no permit ───────────────────────────────

describe("worker-guard — mutation denied without permit", () => {
  const sessionId = "no-permit-session";
  const guard = registerWorkerGuard({ kind: "mutation" }, { sessionId });

  it("denies edit when no permit token provided", () => {
    const result = guard.check({ toolCallId: "tc-np-1", toolName: "edit", sessionId });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toContain("mutation policy");
    }
  });
});
