/// <reference types="node" />

import { describe, it, expect } from "vitest";
import { redactString, redactObject } from "../../src/observability/redaction.js";

// ─── Round-2: full lease field set ────────────────────────────────────────────

describe("redaction — lease field set (round-2)", () => {
  it("redacts full lease field set in JSON strings", () => {
    for (const key of [
      "leaseId",
      "fencingToken",
      "assignmentId",
      "sessionId",
      "goalId",
      "workerProcessIdentity",
      "canonicalWorkspaceRoot",
      "allowedCanonicalPaths",
      "approvedCommands",
      "allowedMcpTools",
      "dirtySignature",
    ]) {
      const value = key === "allowedCanonicalPaths" ? '["/repo/src"]' : '"secret-value"';
      const out = redactString(`{"${key}": ${value}}`);
      expect(out).not.toContain("secret-value");
      expect(out).not.toContain("/repo/src");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("redactObject redacts non-string lease values by key", () => {
    const result = redactObject({
      fencingToken: 7,
      allowedCanonicalPaths: ["/repo/src"],
      sessionId: "sess-1",
      clean: 42,
    });
    expect(result.fencingToken).toEqual("[REDACTED]");
    expect(result.allowedCanonicalPaths).toEqual("[REDACTED]");
    expect(result.sessionId).toEqual("[REDACTED]");
    expect(result.clean).toEqual(42);
  });
});
