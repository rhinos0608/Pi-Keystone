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
    { kind: "mutation", permitToken: "permit-abc" },
    { sessionId, lease: { root: "/tmp", fencingToken: 1, expiresAt: Date.now() + 60_000 } },
  );

  it("allows bash when permit present", () => {
    const result = guard.check({ toolCallId: "tc-6", toolName: "bash", sessionId });
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
