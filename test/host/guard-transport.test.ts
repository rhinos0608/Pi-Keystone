/**
 * Task 9 falsifier: "mutation child cannot write outside scope".
 *
 * Verifies the guard transport chain end-to-end with a deterministic fake
 * child bus (no model/API keys needed — labeled [fake-child]):
 *   executeMutation spawn params → extensionBindings → guard parse → gate.
 *
 * Transport contract (Round-1 P2): `extensionBindings` under `keystone/1`
 * is the SOLE machine transport (PI_SUBAGENT_EXTENSION_BINDINGS env on the
 * detached-runner path). Task-text sentinel transport is removed.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssignmentId } from "../../src/domain/types.js";
import type { MutationLease } from "../../src/domain/types.js";
import {
  executeMutation,
  dispatchMutation,
  authorityBindings,
  KEYSTONE_BINDING_NAMESPACE,
} from "../../src/execution/mutation-launcher.js";
import {
  decideToolCall,
  parseLeaseFromBindingsEnv,
  EXTENSION_BINDINGS_ENV,
  type ChildGuardLease,
} from "../../src/child/keystone-child-guard.js";
import type { SubagentRpcClient } from "../../src/rpc/subagent-rpc-client.js";
import type { AsyncCompletePayload, SpawnResult } from "../../src/rpc/types.js";
import type { ContextView } from "../../src/execution/read-only-launcher.js";
import { acquireLease, advanceLeasePhase, releaseLease } from "../../src/execution/mutation-lease.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROOT = "/repo/host-ladder";
const NOW = Date.now();

function iso(offsetMs = 0): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeLease(overrides: Partial<MutationLease> = {}): MutationLease {
  return {
    leaseId: "lease-host-1",
    fencingToken: 7,
    assignmentId: "a-host-1" as AssignmentId,
    sessionId: "sess-host-1",
    workerProcessIdentity: "pid-host-1",
    canonicalWorkspaceRoot: ROOT,
    allowedCanonicalPaths: [`${ROOT}/src/version.ts`],
    baseDirtySignature: "sig-host",
    phase: "ACQUIRED",
    acquiredAt: iso(-1_000) as never,
    heartbeatAt: iso(-1_000) as never,
    expiresAt: iso(60_000) as never,
    ...overrides,
  };
}

const ASSIGNMENT = {
  id: "a-host-1" as AssignmentId,
  description: "Add export keystoneVersion to src/version.ts",
  targetFiles: ["src/version.ts"],
};

const CONTEXT: ContextView = {
  goalId: "goal-host-1",
  task: "Add export keystoneVersion to src/version.ts",
  workspace: ROOT,
  targetFiles: ["src/version.ts"],
};

function fakeClient(runId: string, spawned: unknown[]): SubagentRpcClient {
  return {
    spawn: async (params: unknown) => {
      spawned.push(params);
      return { text: "spawned", details: { mode: "async", asyncId: "a", asyncDir: "d", runId } } as SpawnResult;
    },
    onAsyncComplete: (_h: (p: AsyncCompletePayload) => void) => () => {},
  } as unknown as SubagentRpcClient;
}

// ─── Falsifier ──────────────────────────────────────────────────────────────

describe("host falsifier [fake-child]: mutation child cannot write outside scope", () => {
  it("bindings transport: spawn extensionBindings parse and gate writes", () => {
    const lease = makeLease();
    const bindings = authorityBindings(lease);
    // Simulate the runner-path child env: canonical JSON under
    // PI_SUBAGENT_EXTENSION_BINDINGS (mirrors pi-subagents child-launch.ts).
    const childEnv: NodeJS.ProcessEnv = {
      [EXTENSION_BINDINGS_ENV]: JSON.stringify(bindings),
    };
    const parsed = parseLeaseFromBindingsEnv(childEnv);
    expect(parsed?.leaseId).toBe(lease.leaseId);
    expect(parsed?.allowedCanonicalPaths).toEqual([`${ROOT}/src/version.ts`]);

    expect(
      decideToolCall(
        { toolName: "edit", input: { path: `${ROOT}/src/version.ts` } },
        parsed,
        undefined,
        NOW,
      ),
    ).toBeUndefined();

    const blocked = decideToolCall(
      { toolName: "edit", input: { path: `${ROOT}/src/other.ts` } },
      parsed,
      undefined,
      NOW,
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason ?? "").toContain("outside lease scope");
  });

  it("executeMutation spawn carries bindings-only transport (no task-text sentinel)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keystone-host-transport-"));
    try {
      const acquired = acquireLease({
        goalId: "goal-host-1",
        assignmentId: ASSIGNMENT.id,
        sessionId: "sess-host-1",
        root,
        writeSet: ["src/version.ts"],
        ttlMs: 120_000,
      });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) throw new Error(acquired.reason);
      const ready = advanceLeasePhase(root, acquired.lease.leaseId, "AUTHORITY_READY");
      expect(ready.ok).toBe(true);
      if (!ready.ok) throw new Error(ready.reason);
      const lease = ready.lease;
      const delegation = dispatchMutation(ASSIGNMENT, { ...CONTEXT, workspace: root }, lease, undefined, {
        writeSet: ["src/version.ts"],
      }).turns[1]!.delegation;
      const spawned: unknown[] = [];
      await executeMutation(lease, delegation, fakeClient("run-host-1", spawned), {
        ensureBridges: () => {},
      });

      const params = spawned[0] as { task: string; extensionBindings: Record<string, unknown> };
      expect(params.task).toBe(delegation.task);
      expect(params.task).not.toContain("KEYSTONE-AUTHORITY");
      const fromBindings = parseLeaseFromBindingsEnv({
        [EXTENSION_BINDINGS_ENV]: JSON.stringify(params.extensionBindings),
      });
      expect(fromBindings?.leaseId).toBe(lease.leaseId);
      expect(params.extensionBindings[KEYSTONE_BINDING_NAMESPACE]).toMatchObject({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      });

      const blocked = decideToolCall(
        { toolName: "write", input: { path: "/etc/passwd" } },
        fromBindings as ChildGuardLease,
        undefined,
        NOW,
      );
      expect(blocked?.block).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale lease via bindings env blocks even in-scope writes", () => {
    const stale = makeLease({ expiresAt: iso(-60_000) as never });
    const parsed = parseLeaseFromBindingsEnv({
      [EXTENSION_BINDINGS_ENV]: JSON.stringify(authorityBindings(stale)),
    });
    const blocked = decideToolCall(
      { toolName: "write", input: { path: `${ROOT}/src/version.ts` } },
      parsed,
      undefined,
      NOW,
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason ?? "").toContain("keystone:");
  });
});
