/// <reference types="node" />

import { describe, it, expect } from "vitest";
import {
  enforceToolPolicy,
  type ToolPolicy,
} from "../../src/execution/tool-policy.js";

// ─── read-only policy ───────────────────────────────────────────────────────

describe("enforceToolPolicy — read-only", () => {
  const policy: ToolPolicy = { kind: "read-only" };

  it("denies bash", () => {
    const d = enforceToolPolicy("bash", policy);
    expect(d.allowed).toBe(false);
  });

  it("denies write", () => {
    const d = enforceToolPolicy("write", policy);
    expect(d.allowed).toBe(false);
  });

  it("denies edit", () => {
    const d = enforceToolPolicy("edit", policy);
    expect(d.allowed).toBe(false);
  });

  it("denies mcp", () => {
    const d = enforceToolPolicy("mcp", policy);
    expect(d.allowed).toBe(false);
  });

  it("allows read", () => {
    const d = enforceToolPolicy("read", policy);
    expect(d.allowed).toBe(true);
  });

  it("allows grep", () => {
    const d = enforceToolPolicy("grep", policy);
    expect(d.allowed).toBe(true);
  });
});

// ─── restricted policy ──────────────────────────────────────────────────────

describe("enforceToolPolicy — restricted", () => {
  const policy: ToolPolicy = { kind: "restricted", allowed: ["read", "grep"] };

  it("allows listed tool", () => {
    const d = enforceToolPolicy("read", policy);
    expect(d.allowed).toBe(true);
  });

  it("denies unlisted tool", () => {
    const d = enforceToolPolicy("bash", policy);
    expect(d.allowed).toBe(false);
  });
});

// ─── mutation policy ────────────────────────────────────────────────────────

describe("enforceToolPolicy — mutation", () => {
  it("allows when permit token present", () => {
    const policy: ToolPolicy = { kind: "mutation", permitToken: "tok-123" };
    const d = enforceToolPolicy("bash", policy);
    expect(d.allowed).toBe(true);
  });

  it("denies when no permit token", () => {
    const policy: ToolPolicy = { kind: "mutation" };
    const d = enforceToolPolicy("bash", policy);
    expect(d.allowed).toBe(false);
  });
});
