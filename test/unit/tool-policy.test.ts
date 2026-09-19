/// <reference types="node" />

import { describe, it, expect } from "vitest";
import {
  enforceToolPolicy,
  type LeaseBinding,
  type ToolPolicy,
} from "../../src/execution/tool-policy.js";

// ─── read-only allowlist ────────────────────────────────────────────────────

describe("enforceToolPolicy — read-only allowlist", () => {
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

  it("denies unknown tools by default", () => {
    const d = enforceToolPolicy("some-new-tool", policy);
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

  it("allows find", () => {
    expect(enforceToolPolicy("find", policy).allowed).toBe(true);
  });

  it("allows ls", () => {
    expect(enforceToolPolicy("ls", policy).allowed).toBe(true);
  });

  it("allows glob", () => {
    expect(enforceToolPolicy("glob", policy).allowed).toBe(true);
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

// ─── mutation policy — structural binding ───────────────────────────────────

const LEASE: LeaseBinding = { leaseId: "lease-1", fencingToken: 7 };

describe("enforceToolPolicy — mutation structural permit", () => {
  it("allows mode-appropriate tools when permit matches the lease record", () => {
    const policy: ToolPolicy = { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 7 } };
    for (const tool of ["read", "grep", "find", "ls", "glob", "edit", "write"]) {
      expect(enforceToolPolicy(tool, policy, LEASE).allowed).toBe(true);
    }
  });

  it("denies tools outside the mutation allowlist even with a valid permit", () => {
    const policy: ToolPolicy = { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 7 } };
    for (const tool of ["some-new-tool", "exec", "mcp"]) {
      const d = enforceToolPolicy(tool, policy, LEASE);
      expect(d.allowed).toBe(false);
    }
  });

  it("rejects permit with wrong leaseId", () => {
    const policy: ToolPolicy = { kind: "mutation", permit: { leaseId: "lease-other", fencingToken: 7 } };
    const d = enforceToolPolicy("write", policy, LEASE);
    expect(d.allowed).toBe(false);
  });

  it("rejects permit with wrong fencingToken", () => {
    const policy: ToolPolicy = { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 8 } };
    const d = enforceToolPolicy("write", policy, LEASE);
    expect(d.allowed).toBe(false);
  });

  it("denies structural permit when no lease passed", () => {
    const policy: ToolPolicy = { kind: "mutation", permit: { leaseId: "lease-1", fencingToken: 7 } };
    const d = enforceToolPolicy("write", policy);
    expect(d.allowed).toBe(false);
  });

  it("denies when no permit at all", () => {
    const policy: ToolPolicy = { kind: "mutation" };
    const d = enforceToolPolicy("write", policy, LEASE);
    expect(d.allowed).toBe(false);
  });

  it("ignores legacy permitToken (never honored)", () => {
    const policy: ToolPolicy = { kind: "mutation", permitToken: "lease-1" };
    expect(enforceToolPolicy("write", policy, LEASE).allowed).toBe(false);
  });
});

// ─── mutation policy — bash exact-match ─────────────────────────────────────

describe("enforceToolPolicy — mutation bash", () => {
  const permit = { leaseId: "lease-1", fencingToken: 7 };

  it("denies bash under textual mode even with a valid permit", () => {
    const policy: ToolPolicy = { kind: "mutation", permit, mutationMode: "textual" };
    const d = enforceToolPolicy("bash", policy, LEASE, { command: "npm test" });
    expect(d.allowed).toBe(false);
  });

  it("denies bash when mode missing (defaults to textual)", () => {
    const policy: ToolPolicy = { kind: "mutation", permit };
    expect(enforceToolPolicy("bash", policy, LEASE, { command: "npm test" }).allowed).toBe(false);
  });

  it("denies bash with no approvedCommands", () => {
    const policy: ToolPolicy = { kind: "mutation", permit, mutationMode: "generated" };
    expect(enforceToolPolicy("bash", policy, LEASE, { command: "npm test" }).allowed).toBe(false);
  });

  it("allows an exact approved command in a command-capable mode", () => {
    const policy: ToolPolicy = {
      kind: "mutation",
      permit,
      mutationMode: "migration",
      approvedCommands: ["npm run migrate -- up"],
    };
    expect(enforceToolPolicy("bash", policy, LEASE, { command: "npm run migrate -- up" }).allowed).toBe(true);
  });

  it("blocks non-listed commands and prefix bypasses", () => {
    const policy: ToolPolicy = {
      kind: "mutation",
      permit,
      mutationMode: "generated",
      approvedCommands: ["npm test"],
    };
    expect(enforceToolPolicy("bash", policy, LEASE, { command: "npm test; rm -rf /" }).allowed).toBe(false);
    expect(enforceToolPolicy("bash", policy, LEASE, { command: "rm -rf /" }).allowed).toBe(false);
    expect(enforceToolPolicy("bash", policy, LEASE).allowed).toBe(false);
  });
});

// ─── mutation policy — mcp allowlist (round-2) ────────────────────────────────

describe("enforceToolPolicy — mutation mcp", () => {
  const permit = { leaseId: "lease-1", fencingToken: 7 };

  it("denies mcp without an allowedMcpTools list", () => {
    const policy: ToolPolicy = { kind: "mutation", permit };
    expect(enforceToolPolicy("mcp__ctx7__query", policy, LEASE).allowed).toBe(false);
    expect(enforceToolPolicy("mcp", policy, LEASE).allowed).toBe(false);
  });

  it("denies mcp with an empty allowedMcpTools list", () => {
    const policy: ToolPolicy = { kind: "mutation", permit, allowedMcpTools: [] };
    expect(enforceToolPolicy("mcp__ctx7__query", policy, LEASE).allowed).toBe(false);
  });

  it("allows a listed mcp tool, denies unlisted", () => {
    const policy: ToolPolicy = { kind: "mutation", permit, allowedMcpTools: ["mcp__ctx7__query"] };
    expect(enforceToolPolicy("mcp__ctx7__query", policy, LEASE).allowed).toBe(true);
    expect(enforceToolPolicy("mcp__other__tool", policy, LEASE).allowed).toBe(false);
  });
});
