/// <reference types="node" />

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import keystoneChildGuard, {
  AUTHORITY_BLOB_ENV,
  EXTENSION_BINDINGS_ENV,
  decideToolCall,
  parseLeaseFromAuthorityBlob,
  parseLeaseFromBindingsEnv,
  type ChildGuardLease,
} from "../../src/child/keystone-child-guard.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROOT = "/repo";
const NOW = Date.now();

function makeLease(overrides: Partial<ChildGuardLease> = {}): ChildGuardLease {
  return {
    leaseId: "lease-1",
    fencingToken: 7,
    assignmentId: "a-1" as never,
    sessionId: "sess-1",
    workerProcessIdentity: "pid-1",
    canonicalWorkspaceRoot: ROOT,
    allowedCanonicalPaths: [`${ROOT}/src/auth.ts`],
    baseDirtySignature: "sig",
    phase: "ACQUIRED",
    acquiredAt: new Date(NOW - 1_000).toISOString() as never,
    heartbeatAt: new Date(NOW - 1_000).toISOString() as never,
    expiresAt: new Date(NOW + 60_000).toISOString() as never,
    goalId: "g-1",
    baseRevision: null,
    planEpoch: 0,
    mutationMode: "textual",
    ...overrides,
  } as ChildGuardLease;
}

function blobEnv(lease: ChildGuardLease): NodeJS.ProcessEnv {
  return { [AUTHORITY_BLOB_ENV]: JSON.stringify(lease) } as NodeJS.ProcessEnv;
}

// ─── Authority transport (no task-text/sentinel) ────────────────────────────

describe("child-guard — authority transport", () => {
  it("parses lease JSON from KEYSTONE_AUTHORITY_BLOB", () => {
    const parsed = parseLeaseFromAuthorityBlob(blobEnv(makeLease()));
    expect(parsed?.leaseId).toBe("lease-1");
  });

  it("returns null when the blob env is absent", () => {
    expect(parseLeaseFromAuthorityBlob({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null on malformed blob JSON", () => {
    expect(
      parseLeaseFromAuthorityBlob({ [AUTHORITY_BLOB_ENV]: "{nope" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when required lease fields missing", () => {
    expect(
      parseLeaseFromAuthorityBlob({ [AUTHORITY_BLOB_ENV]: '{"foo":1}' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("parses lease from a keystone bindings namespace", () => {
    const env = {
      [EXTENSION_BINDINGS_ENV]: JSON.stringify({ "keystone/1": makeLease() }),
    } as NodeJS.ProcessEnv;
    expect(parseLeaseFromBindingsEnv(env)?.leaseId).toBe("lease-1");
  });

  it("loads injected lease option (tests) without env", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler); } };
    await keystoneChildGuard(pi, { lease: makeLease(), now: () => NOW });
    const handler = handlers.get("tool_call");
    const verdict = handler?.({ toolName: "write", input: { path: `${ROOT}/src/auth.ts` } });
    expect(verdict).toBeUndefined();
  });

  it("env children refresh heartbeat expiry from disk and revoke when the lease disappears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-live-lease-"));
    try {
      const target = join(dir, "src/auth.ts");
      const launchLease = makeLease({
        canonicalWorkspaceRoot: dir,
        allowedCanonicalPaths: [target],
        phase: "MUTATING",
        expiresAt: new Date(NOW + 1_000).toISOString() as never,
      });
      const persisted = {
        ...launchLease,
        heartbeatAt: new Date(NOW + 2_000).toISOString(),
        expiresAt: new Date(NOW + 60_000).toISOString(),
      };
      writeFileSync(join(dir, ".keystone-lease.json"), JSON.stringify(persisted));
      const handlers = new Map<string, (event: unknown) => unknown>();
      const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler); } };
      await keystoneChildGuard(pi, {
        env: { [EXTENSION_BINDINGS_ENV]: JSON.stringify({ "keystone/1": launchLease }) } as NodeJS.ProcessEnv,
        now: () => NOW + 5_000,
      });
      const handler = handlers.get("tool_call");
      expect(handler?.({ toolName: "write", input: { path: target } })).toBeUndefined();
      rmSync(join(dir, ".keystone-lease.json"), { force: true });
      expect(handler?.({ toolName: "write", input: { path: target } })).toMatchObject({ block: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Fail-closed unknown tools ──────────────────────────────────────────────

describe("child-guard — unknown tools fail closed", () => {
  it("denies unknown tools even with a live lease", () => {
    const d = decideToolCall({ toolName: "some-new-tool", input: {} }, makeLease(), undefined, NOW);
    expect(d?.block).toBe(true);
    expect(d?.reason).toBe("keystone: unknown tool denied");
  });

  it("denies unknown tools without a lease", () => {
    const d = decideToolCall({ toolName: "exec", input: {} }, null, undefined, NOW);
    expect(d?.block).toBe(true);
    expect(d?.reason).toBe("keystone: unknown tool denied");
  });

  it("read-only allowlist passes without a lease", () => {
    for (const tool of ["read", "grep", "find", "ls", "glob", "structured_output"]) {
      expect(decideToolCall({ toolName: tool, input: {} }, null, undefined, NOW)).toBeUndefined();
    }
  });

  it("mcp passes only when the lease names it", () => {
    expect(
      decideToolCall({ toolName: "mcp__ctx7__query", input: {} }, makeLease(), undefined, NOW)?.block,
    ).toBe(true);
    const withMcp = makeLease({ allowedMcpTools: ["mcp__ctx7__query"] });
    expect(decideToolCall({ toolName: "mcp__ctx7__query", input: {} }, withMcp, undefined, NOW)).toBeUndefined();
  });
});

// ─── Write scope (deep input walk) ──────────────────────────────────────────

describe("child-guard — write scope", () => {
  it("allows write to an in-scope path", () => {
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/auth.ts` } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d).toBeUndefined();
  });

  it("does not widen an exact file lease into a descendant subtree", () => {
    const lease = makeLease({ allowedCanonicalPaths: [`${ROOT}/new-target`] });
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/new-target/nested.ts`, content: "x" } },
      lease,
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("exact write-set");
  });

  it("blocks write to ../escape.ts", () => {
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/../escape.ts` } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("keystone:");
  });

  it("blocks write to a path outside allowedCanonicalPaths", () => {
    const d = decideToolCall(
      { toolName: "edit", input: { path: `${ROOT}/src/other.ts` } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("outside lease scope");
  });

  it("checks path strings nested in arrays and objects", () => {
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/auth.ts`, extra: { files: [`${ROOT}/src/other.ts`] } } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("outside lease scope");
  });

  it("checks nonstandard keys carrying path-shaped strings", () => {
    const d = decideToolCall(
      { toolName: "edit", input: { content: "x", dest: `${ROOT}/src/other.ts` } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
  });

  it("blocks write with no resolvable target", () => {
    const d = decideToolCall({ toolName: "edit", input: { nope: 1 } }, makeLease(), undefined, NOW);
    expect(d?.block).toBe(true);
  });

  it("blocks symlink escapes resolving outside the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-symlink-"));
    try {
      writeFileSync(join(dir, "outside.txt"), "secret");
      const linkDir = mkdtempSync(join(tmpdir(), "guard-root-"));
      try {
        symlinkSync(join(dir, "outside.txt"), join(linkDir, "link.txt"));
        const lease = makeLease({
          canonicalWorkspaceRoot: linkDir,
          allowedCanonicalPaths: [join(linkDir, "link.txt")],
        });
        const d = decideToolCall(
          { toolName: "write", input: { path: join(linkDir, "link.txt") } },
          lease,
          undefined,
          NOW,
        );
        expect(d?.block).toBe(true);
        expect(d?.reason ?? "").toContain("symlink");
      } finally {
        rmSync(linkDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps attacker-controlled path echo at 200 chars", () => {
    const long = `${ROOT}/${"x".repeat(500)}.ts`;
    const d = decideToolCall({ toolName: "edit", input: { path: long } }, makeLease(), undefined, NOW);
    expect(d?.block).toBe(true);
    expect((d?.reason ?? "").length).toBeLessThan(long.length);
    expect(d?.reason ?? "").toContain("…");
  });
});

// ─── Bash gating (exact-match-only) ─────────────────────────────────────────

describe("child-guard — bash gating", () => {
  const cmdLease = (overrides: Partial<ChildGuardLease> = {}): ChildGuardLease =>
    makeLease({ mutationMode: "generated", approvedCommands: ["npm test -- src/auth"], ...overrides });

  it("blocks bash in textual mode", () => {
    const d = decideToolCall({ toolName: "bash", input: { command: "ls" } }, makeLease({ mutationMode: "textual" }), undefined, NOW);
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("keystone:");
  });

  it("blocks bash when mode missing (defaults to textual)", () => {
    const lease = makeLease();
    delete (lease as { mutationMode?: unknown }).mutationMode;
    const d = decideToolCall({ toolName: "bash", input: {} }, lease, undefined, NOW);
    expect(d?.block).toBe(true);
  });

  it("blocks command-capable mode with no approvedCommands", () => {
    const d = decideToolCall(
      { toolName: "bash", input: { command: "npm test" } },
      makeLease({ mutationMode: "generated" }),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("no approved commands");
  });

  it("allows an exact approved command", () => {
    const d = decideToolCall(
      { toolName: "bash", input: { command: "npm test -- src/auth" } },
      cmdLease(),
      undefined,
      NOW,
    );
    expect(d).toBeUndefined();
  });

  it("normalizes whitespace before exact compare", () => {
    const d = decideToolCall(
      { toolName: "bash", input: { command: "  npm   test -- src/auth " } },
      cmdLease(),
      undefined,
      NOW,
    );
    expect(d).toBeUndefined();
  });

  it("blocks prefix/substring bypasses of an approved command", () => {
    for (const cmd of ["npm test -- src/auth; rm -rf /", "npm test -- src/authExtra", "npm test"]) {
      const d = decideToolCall({ toolName: "bash", input: { command: cmd } }, cmdLease(), undefined, NOW);
      expect(d?.block).toBe(true);
    }
  });

  it("blocks bash with no resolvable command", () => {
    const d = decideToolCall({ toolName: "bash", input: {} }, cmdLease(), undefined, NOW);
    expect(d?.block).toBe(true);
  });
});

// ─── Missing/expired lease ──────────────────────────────────────────────────

describe("child-guard — missing/expired lease", () => {
  it("blocks writes when lease absent", () => {
    const d = decideToolCall({ toolName: "write", input: { path: `${ROOT}/src/auth.ts` } }, null, undefined, NOW);
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("no authority lease");
  });

  it("blocks bash when lease absent", () => {
    expect(decideToolCall({ toolName: "bash", input: {} }, null, undefined, NOW)?.block).toBe(true);
  });

  it("blocks all mutating tools when lease expired", () => {
    const expired = makeLease({ expiresAt: new Date(NOW - 1_000).toISOString() as never });
    expect(decideToolCall({ toolName: "write", input: { path: `${ROOT}/src/auth.ts` } }, expired, undefined, NOW)?.block).toBe(true);
    expect(decideToolCall({ toolName: "bash", input: {} }, expired, undefined, NOW)?.block).toBe(true);
  });

  it("blocks null/empty toolName fail-closed as unknown tool", () => {
    for (const event of [{ input: {} }, { toolName: "", input: {} }, { toolName: null, input: {} }]) {
      const d = decideToolCall(event as never, makeLease(), undefined, NOW);
      expect(d?.block).toBe(true);
      expect(d?.reason).toBe("keystone: unknown tool denied");
    }
  });

  it("never leaks lease contents in block reasons", () => {
    const expired = makeLease({ expiresAt: new Date(NOW - 1_000).toISOString() as never });
    const d = decideToolCall({ toolName: "write", input: { path: `${ROOT}/src/auth.ts` } }, expired, undefined, NOW);
    expect(d?.reason ?? "").not.toContain("lease-1");
    expect(d?.reason ?? "").not.toContain("sig");
  });
});

// ─── Extension wiring ───────────────────────────────────────────────────────

describe("child-guard — extension wiring", () => {
  it("registers a tool_call handler that blocks without authority", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler); } };
    await keystoneChildGuard(pi);
    const handler = handlers.get("tool_call");
    expect(handler).toBeDefined();
    const verdict = handler?.({ toolName: "write", input: { path: "/repo/src/auth.ts" } }) as { block?: boolean; reason?: string };
    expect(verdict?.block).toBe(true);
    const read = handler?.({ toolName: "read", input: {} });
    expect(read).toBeUndefined();
    const unknown = handler?.({ toolName: "mystery-tool", input: {} }) as { block?: boolean };
    expect(unknown?.block).toBe(true);
  });

  it("loads lease identity from authority blob and live authority from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-authority-blob-"));
    try {
      const target = join(dir, "src/auth.ts");
      const lease = makeLease({
        canonicalWorkspaceRoot: dir,
        allowedCanonicalPaths: [target],
        phase: "MUTATING",
      });
      writeFileSync(join(dir, ".keystone-lease.json"), JSON.stringify(lease));
      const handlers = new Map<string, (event: unknown) => unknown>();
      const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler); } };
      await keystoneChildGuard(pi, { env: blobEnv(lease), now: () => NOW });
      const handler = handlers.get("tool_call");
      const verdict = handler?.({ toolName: "write", input: { path: target } });
      expect(verdict).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Round-2 regression: symlink-parent escape + path-key scoping ─────────────

describe("child-guard — round-2 regressions", () => {
  it("blocks symlink-parent escape: allowed/link/newfile where link -> outside and leaf absent", () => {
    const outside = mkdtempSync(join(tmpdir(), "guard-outside-"));
    const root = mkdtempSync(join(tmpdir(), "guard-allowed-"));
    try {
      const link = join(root, "link");
      symlinkSync(outside, link);
      const lease = makeLease({
        canonicalWorkspaceRoot: root,
        allowedCanonicalPaths: [join(root, "link")],
      });
      const d = decideToolCall(
        { toolName: "write", input: { path: join(link, "newfile") } },
        lease,
        undefined,
        NOW,
      );
      expect(d?.block).toBe(true);
      expect(d?.reason ?? "").toContain("symlink");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores content strings when path keys present (no overblock)", () => {
    const lease = makeLease({
      canonicalWorkspaceRoot: ROOT,
      allowedCanonicalPaths: [`${ROOT}/src/auth.ts`],
    });
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/auth.ts`, content: "see /etc/passwd for details" } },
      lease,
      undefined,
      NOW,
    );
    expect(d).toBeUndefined();
  });

  it("blocks decoy-key fail-open: in-scope path must not mask out-of-scope outputPath", () => {
    const lease = makeLease({
      canonicalWorkspaceRoot: ROOT,
      allowedCanonicalPaths: [`${ROOT}/src`],
    });
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/auth.ts`, outputPath: `${ROOT}/secret/evil.ts` } },
      lease,
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("outside lease scope");
  });

  it("blocks bare-filename bypass under a path key: in-scope path + outputPath evil.sh", () => {
    const lease = makeLease({
      canonicalWorkspaceRoot: ROOT,
      allowedCanonicalPaths: [`${ROOT}/src`],
    });
    const d = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/auth.ts`, outputPath: "evil.sh" } },
      lease,
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("outside lease scope");
  });

  it("blocks write with no recognized path key fail-closed", () => {
    const d = decideToolCall(
      { toolName: "write", input: { content: "hello" } },
      makeLease(),
      undefined,
      NOW,
    );
    expect(d?.block).toBe(true);
    expect(d?.reason ?? "").toContain("no path key");
  });
});
