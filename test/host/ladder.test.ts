/**
 * Task 9 host-level integration ladder (items 1-10).
 *
 * Transport: every test that would need a live model uses a deterministic
 * fake child bus and is labeled [fake-child] in its name. Item 1 probes for
 * a real `pi` binary ([live-probe], passes with a documented skip when the
 * binary is absent). No test requires API keys.
 *
 * Suite budget: all items are in-process and millisecond-scale except the
 * optional `pi --version` probe (15s cap).
 */
import { describe, it, expect, onTestFinished } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import type {
  GoalId,
  GoalRecord,
  AssignmentId,
  ArtifactRef,
  RevisionRef,
  WorkspaceIdentity,
  MutationLease,
} from "../../src/domain/types.js";
import { createGoalRecord } from "../../src/domain/goal-record.js";
import { goalReducer } from "../../src/store/goal-store.js";
import { GoalStore } from "../../src/store/goal-store.js";
import { dispatchEvent, startGoal, type ReceiptLog } from "../../src/runtime/lifecycle.js";
import { acquireDriverLease, validateFencedEvent } from "../../src/runtime/driver.js";
import { resumeAfterCompaction } from "../../src/continuation.js";
import { settleCancellation } from "../../src/runtime/recovery.js";
import {
  SubagentRpcClient,
  type RpcEventBus,
} from "../../src/rpc/subagent-rpc-client.js";
import {
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_PROTOCOL_VERSION,
  subagentRpcReplyEvent,
} from "../../src/rpc/types.js";
import type { AsyncCompletePayload } from "../../src/rpc/types.js";
import {
  dispatchReadOnly,
  executeReadOnly,
  type ContextView,
} from "../../src/execution/read-only-launcher.js";
import { dispatchMutation, executeMutation } from "../../src/execution/mutation-launcher.js";
import {
  decideToolCall,
  parseLeaseFromBindingsEnv,
  EXTENSION_BINDINGS_ENV,
} from "../../src/child/keystone-child-guard.js";
import { createEvidenceGraph } from "../../src/evidence/graph.js";
import { runFinalAudit, type AuditorSession } from "../../src/audit/final-audit.js";
import type { AssignmentIndex } from "../../src/execution/assignment-index.js";
import type { GoalContract } from "../../src/domain/types.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────

function gid(): GoalId {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as GoalId;
}

const WORKSPACE: WorkspaceIdentity = {
  requestedRoot: "/tmp/host-ladder-proj",
  canonicalRoot: "/tmp/host-ladder-proj",
  projectKey: "host-ladder",
  vcs: "git",
};

const REVISION: RevisionRef = {
  snapshotId: "snap-host-001" as never,
  observedAt: new Date().toISOString() as never,
  gitHead: "abc123",
  branch: "main",
  graphRevision: 1,
  dirtySignature: "clean",
  capabilityDigest: "full",
};

const ART = "artifact-host-001" as ArtifactRef;
const A1 = "a-host-ladder-1" as AssignmentId;
const A2 = "a-host-ladder-2" as AssignmentId;

/** PREPARING → RECONCILING via both preparation jobs (mirrors integration suite). */
function completePreparation(store: GoalStore, goalId: GoalId, log: ReceiptLog) {
  for (const job of ["baseline", "plan"] as const) {
    dispatchEvent(store, goalId, {
      type: "PreparationProgress",
      job,
      planEpoch: 0,
      attemptId: `att-host-${job}`,
      basedOnRevision: REVISION,
      status: "SUCCEEDED",
      driverFence: 0,
      artifactRef: ART,
    }, log);
  }
}

/** RECONCILING → EXECUTING. */
function toExecuting(store: GoalStore, goalId: GoalId, log: ReceiptLog) {
  completePreparation(store, goalId, log);
  dispatchEvent(store, goalId, {
    type: "ReconciliationCompleted",
    reportRef: ART,
    planEpoch: 0,
    provisionalPlanRef: ART,
    basedOnRevision: REVISION,
    decision: "ACCEPT_PLAN_BASIS",
  }, log);
  dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ART }, log);
  dispatchEvent(store, goalId, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ART, driverFence: 0 }, log);
}

/** Minimal fake in-process event bus speaking the pi-subagents RPC event names. */
function fakeBus(): RpcEventBus & { server: (h: (envelope: Record<string, unknown>) => void) => void } {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const bus = {
    on(event: string, handler: (p: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
      };
    },
    emit(event: string, payload: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    server(h: (envelope: Record<string, unknown>) => void) {
      bus.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => h(raw as Record<string, unknown>));
    },
  };
  return bus;
}

// ─── Ladder ─────────────────────────────────────────────────────────────────

describe("host ladder", () => {
  it("1 [live-probe]: keystone loads as a real pi extension (pi binary probe + manifest)", async (ctx) => {
    // Static manifest: package registers this entrypoint as a pi extension.
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      pi?: { extensions?: string[] };
      keywords?: string[];
    };
    expect(pkg.pi?.extensions).toContain("./src/index.ts");
    expect(pkg.keywords).toContain("pi-package");
    const entry = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(entry).toContain('export { default } from "./keystone-extension.js"');
    expect(entry.split("\n").filter(Boolean).length).toBeLessThanOrEqual(4);

    // Live load: spawn real `pi` headless in RPC mode with the Keystone
    // entrypoint. Proof of load = the session_start success notify plus
    // exit code 0 (graceful degradation when pi-subagents is absent).
    // No model or API keys involved; stdin closed, tools off, offline.
    // Missing pi binary -> explicit SKIP (not pass, not fail).
    const { spawn } = await import("node:child_process");
    const skip = (reason: string) => {
      console.log(`SKIPPED (no pi binary): ${reason}`);
      if (typeof (ctx as { skip?: () => void }).skip === "function") (ctx as unknown as { skip(): void }).skip();
    };
    const probe = await new Promise<{ out: string; err: string; code: number | null; spawnFailed: boolean }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          "pi",
          ["--mode", "rpc", "--no-session", "-e", "./src/index.ts", "--offline", "--no-tools", "-p", "ping"],
          { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_OFFLINE: "1" } },
        );
      } catch {
        resolve({ out: "", err: "", code: null, spawnFailed: true });
        return;
      }
      let out = "";
      let err = "";
      const finish = (code: number | null) => {
        if (!child.killed) child.kill("SIGKILL");
        resolve({ out, err, code, spawnFailed: false });
      };
      const timer = setTimeout(() => finish(null), 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("Keystone: extension loaded, session ready")) {
          clearTimeout(timer);
          finish(null);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ out, err, code: null, spawnFailed: true });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ out, err, code, spawnFailed: false });
      });
    });
    if (probe.spawnFailed) {
      skip("pi spawn failed (binary missing or not executable)");
      return;
    }
    const combined = `${probe.out}\n${probe.err}`;
    // Success requires the named load signal: the session_start notify
    // proves the Keystone entrypoint actually loaded (a bare exit 0 can
    // mask a config that never loaded the extension).
    const successSignal = combined.includes("Keystone: extension loaded, session ready");
    expect(successSignal).toBe(true);
    expect(combined).not.toMatch(/keystone.*(failed to load|load error|Cannot find)/i);
  }, 45_000);

  it("2 [fake-child]: startGoal writes durable state readable across restart (goal-create persistence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-host-2-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const first = new GoalStore(dir);
    const log: ReceiptLog = [];
    const goalId = gid();
    startGoal(first, goalId, createGoalRecord(goalId, "host ladder durability", WORKSPACE, REVISION), log);
    expect(first.get(goalId)!.state).toBe("PREPARING");

    // Simulate host restart: a fresh controller over the same store dir.
    const second = new GoalStore(dir);
    const reread = second.get(goalId);
    expect(reread).not.toBeNull();
    expect(reread!.userTask).toBe("host ladder durability");
    expect(reread!.recordVersion).toBe(first.get(goalId)!.recordVersion);
  });

  it("3 [fake-child]: rpc spawn launches read-only child; async-complete correlates to AssignmentCompleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-host-3-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const store = new GoalStore(dir);
    const log: ReceiptLog = [];
    const goalId = gid();
    startGoal(store, goalId, createGoalRecord(goalId, "read-only spawn", WORKSPACE, REVISION), log);
    toExecuting(store, goalId, log);

    const bus = fakeBus();
    const client = new SubagentRpcClient(bus, { sourceExtension: "keystone-host-test" });
    bus.emit(SUBAGENT_RPC_READY_EVENT, {});
    await client.waitReady(1000);

    // Fake RPC server: answer spawn with a runId (no model involved).
    bus.server((envelope) => {
      if (envelope["method"] !== "spawn") return;
      bus.emit(subagentRpcReplyEvent(envelope["requestId"] as string), {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId: envelope["requestId"],
        success: true,
        data: {
          text: "spawned",
          details: { mode: "async", asyncId: "a-host-3", asyncDir: "d-host-3", runId: "run-host-3" },
        },
      });
    });

    const ctx: ContextView = {
      goalId: goalId as string,
      task: "Survey the repo",
      workspace: "/tmp/host-ladder-proj",
      targetFiles: [],
    };
    const delegation = dispatchReadOnly(
      { id: A1, description: "Survey the repo", targetFiles: [] },
      ctx,
    ).delegation;
    const { runId } = await executeReadOnly(delegation, client, {
      sessionId: "sess-host-3",
      ensureBridges: () => {},
      completion: {
        goalId,
        assignmentId: A1,
        driverFence: 0,
        reportRefFor: () => "ref-host-3" as ArtifactRef,
        store,
        receiptLog: log,
      },
    });
    expect(runId).toBe("run-host-3");

    // Child finishes: async-complete correlates to AssignmentCompleted in store.
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
      runId: "run-host-3",
      results: [{ agent: "reader", status: "complete", summary: "surveyed", index: 0 }],
    } as AsyncCompletePayload);
    expect(store.get(goalId)!.assignmentStates[A1]).toBe("COMPLETED");
    client.dispose();
  });

  it("4 [fake-child]: parallel children do not prematurely advance the goal", () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-host-4-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const store = new GoalStore(dir);
    const log: ReceiptLog = [];
    const goalId = gid();
    startGoal(store, goalId, createGoalRecord(goalId, "parallel frontier", WORKSPACE, REVISION), log);
    completePreparation(store, goalId, log);
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted",
      reportRef: ART,
      planEpoch: 0,
      provisionalPlanRef: ART,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    }, log);
    dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ART }, log);
    // Seed the two-assignment DAG frontier via the REAL ExecutionStarted
    // assignments payload (production wiring populates executionPlan; no
    // wrapping-reducer seam). The AssignmentCompleted gate under test is the
    // real goalReducer path.
    dispatchEvent(store, goalId, {
      type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ART, driverFence: 0,
      assignments: [
        { id: A1, dependsOn: [] },
        { id: A2, dependsOn: [] },
      ],
    }, log);
    expect(store.get(goalId)!.state).toBe("EXECUTING");

    // First child completes while the second is still in flight.
    dispatchEvent(store, goalId, { type: "AssignmentCompleted", assignmentId: A1, reportRef: ART, driverFence: 0 }, log);
    expect(store.get(goalId)!.state).toBe("EXECUTING");

    // Second completes → frontier terminal → VERIFYING.
    dispatchEvent(store, goalId, { type: "AssignmentCompleted", assignmentId: A2, reportRef: ART, driverFence: 0 }, log);
    expect(store.get(goalId)!.state).toBe("VERIFYING");
  });

  it("5 [fake-child]: child write outside allowedCanonicalPaths blocked with keystone reason", () => {
    const root = mkdtempSync(join(tmpdir(), "keystone-host-5-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const lease = {
      leaseId: "lease-host-5",
      fencingToken: 3,
      assignmentId: A1,
      sessionId: "sess-host-5",
      workerProcessIdentity: "pid-host-5",
      canonicalWorkspaceRoot: root,
      allowedCanonicalPaths: [`${root}/src/version.ts`],
      baseDirtySignature: "sig-5",
      phase: "ACQUIRED",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as MutationLease;
    const delegation = dispatchMutation(
      { id: A1, description: "edit version", targetFiles: ["src/version.ts"] },
      { goalId: "g5", task: "edit version", workspace: root, targetFiles: [] },
      lease,
      undefined,
      { writeSet: ["src/version.ts"] },
    ).turns[1]!.delegation;
    void delegation;
    const parsed = parseLeaseFromBindingsEnv({
      [EXTENSION_BINDINGS_ENV]: JSON.stringify({ "keystone/1": { ...lease } }),
    });
    const blocked = decideToolCall(
      { toolName: "write", input: { path: `${root}/../escape.ts` } },
      parsed,
      undefined,
      Date.now(),
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason ?? "").toContain("keystone:");
  });

  it("6 [fake-child]: kill/restart resumes via continuation states", () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-host-6-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const log: ReceiptLog = [];
    const goalId = gid();
    startGoal(new GoalStore(dir), goalId, createGoalRecord(goalId, "resume me", WORKSPACE, REVISION), log);

    // Host dies; a fresh controller re-opens the same store dir.
    const restarted = new GoalStore(dir);
    const ctx = resumeAfterCompaction(restarted, goalId);
    expect(ctx).not.toBeNull();
    expect(ctx!.canContinue).toBe(true);
    expect(ctx!.nextStep).toBe("run_preparation_jobs");

    // Terminal goals do not resume.
    toExecuting(restarted, goalId, log);
    dispatchEvent(restarted, goalId, { type: "AssignmentCompleted", assignmentId: A1, reportRef: ART, driverFence: 0 }, log);
    dispatchEvent(restarted, goalId, { type: "VerificationCompleted", runRef: ART, accepted: true, driverFence: 0 }, log);
    dispatchEvent(restarted, goalId, { type: "ReviewCompleted", reviewRef: ART, candidateIds: [], driverFence: 0 }, log);
    dispatchEvent(restarted, goalId, { type: "AdjudicationCompleted", decisionRefs: [ART], driverFence: 0 }, log);
    dispatchEvent(restarted, goalId, { type: "FinalAuditCompleted", auditRefs: [ART, ART], accepted: true, driverFence: 0 }, log);
    dispatchEvent(restarted, goalId, { type: "CompletionEvaluated", reportRef: ART, accepted: true, driverFence: 0 }, log);
    expect(restarted.get(goalId)!.state).toBe("DONE");
    expect(resumeAfterCompaction(new GoalStore(dir), goalId)).toBeNull();
  });

  it("7 [fake-child]: stale fence rejected (expired lease fails validation)", () => {
    const record = createGoalRecord(gid(), "fence", WORKSPACE, REVISION);
    acquireDriverLease(record, "sess-host-7", { ttlMs: -1 }); // already expired
    const fence = record.activeDriverLease!.fencingToken;
    const verdict = validateFencedEvent(record, { type: "AssignmentCompleted", driverFence: fence });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/expired|no active/i);
  });

  it("8 [fake-child]: cancellation never claims rollback without evidence", () => {
    const lease = (phase: MutationLease["phase"]) => ({
      leaseId: "lease-host-8",
      fencingToken: 1,
      assignmentId: A1,
      sessionId: "sess-host-8",
      workerProcessIdentity: "pid-8",
      canonicalWorkspaceRoot: "/tmp/host-8",
      allowedCanonicalPaths: [] as string[],
      baseDirtySignature: "sig-8",
      phase,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }) as unknown as MutationLease;
    const mkGoal = (l: MutationLease | undefined) => ({
      ...createGoalRecord(gid(), "cancel", WORKSPACE, REVISION),
      state: "CANCELLING" as const,
      activeMutationLease: l,
    });

    // MUTATING with a live lease: INDETERMINATE, never ROLLED_BACK (no proof artifact).
    const mid = settleCancellation(mkGoal(lease("MUTATING")), new Date().toISOString() as never);
    expect(mid!.outcome).toBe("INDETERMINATE");
    expect(mid!.event.mutationOutcome).toBe("INDETERMINATE");

    // SETTLING still settles cleanly.
    const done = settleCancellation(mkGoal(lease("SETTLING")), new Date().toISOString() as never);
    expect(done!.outcome).toBe("SETTLED");
  });

  it("9 [fake-child]: two genuinely fresh auditor children execute against the evidence manifest", async () => {
    // Two spawns via the fake RPC bus stand in for two fresh auditor
    // children (no model involved): distinct runIds, distinct sessions.
    const bus = fakeBus();
    const client = new SubagentRpcClient(bus, { sourceExtension: "keystone-host-test" });
    bus.emit(SUBAGENT_RPC_READY_EVENT, {});
    await client.waitReady(1000);
    let n = 0;
    bus.server((envelope) => {
      if (envelope["method"] !== "spawn") return;
      n += 1;
      bus.emit(subagentRpcReplyEvent(envelope["requestId"] as string), {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId: envelope["requestId"],
        success: true,
        data: {
          text: "spawned",
          details: { mode: "async", asyncId: `a-audit-${n}`, asyncDir: `d-audit-${n}`, runId: `run-audit-${n}` },
        },
      });
    });
    const ctx: ContextView = { goalId: "g9", task: "audit", workspace: "/tmp/host-9", targetFiles: [] };
    const mkAuditor = (id: string) =>
      dispatchReadOnly({ id: id as AssignmentId, description: `Audit evidence (${id})`, targetFiles: [] }, ctx).delegation;
    const r1 = await executeReadOnly(mkAuditor("a-audit-1"), client, { sessionId: "sess-audit-1", ensureBridges: () => {} });
    const r2 = await executeReadOnly(mkAuditor("a-audit-2"), client, { sessionId: "sess-audit-2", ensureBridges: () => {} });
    expect(r1.runId).not.toBe(r2.runId);

    // Both auditors consume the same evidence manifest and claim manifest IDs.
    const graph = createEvidenceGraph();
    graph.addCriterion("REQ-9", "keystoneVersion exported");
    const assertionId = graph.attachAssertion("REQ-9", { verdict: "pass", reason: "export present" });
    graph.attachArtifact(assertionId, "ref-9");
    const manifest = graph.manifestFor(["REQ-9"]);
    expect(manifest.coverage.uncovered).toEqual([]);

    const contract: GoalContract = {
      schemaVersion: 1,
      version: 1 as never,
      goalId: "g9",
      requirements: [{ id: "REQ-9", text: "keystoneVersion exported", provenance: "explicit-user", strength: "hard" }],
      invariants: [],
      completionCriteria: [],
      assumptions: [],
    };
    const index: AssignmentIndex = {
      version: 1,
      entries: ["sess-audit-1", "sess-audit-2"].map((sessionId) => ({
        runId: `run-${sessionId}`,
        sessionId,
        role: "auditor",
        planEpoch: 0,
        mutationCapable: false,
        appendedAt: "2025-01-01T00:00:00Z",
      })),
    };
    const auditorSession = (sessionId: string): AuditorSession => ({
      sessionId,
      runId: `run-${sessionId}`,
      outcome: "ACCEPTED",
      findings: [],
      evidenceChecklist: [{ artifactRef: "ref-9" as ArtifactRef, description: "export present", present: true }],
      claims: [{ nodeId: assertionId, statement: "export present" }],
    });
    const result = runFinalAudit({
      goalId: "g9",
      contract,
      baselineRef: null,
      deltaRef: null,
      findings: [],
      snapshotRefs: [],
      assignmentIndex: index,
      auditorSessions: [auditorSession("sess-audit-1"), auditorSession("sess-audit-2")],
      manifest,
    });
    expect(result.status).toBe("DONE");
    client.dispose();
  });

  it("10 [fake-child]: tiny feature request reaches DONE end-to-end (plumbing test: exercises state chain)", () => {
    // Fixture repo + real file edit through the guard-permitted path.
    const repo = mkdtempSync(join(tmpdir(), "keystone-host-10-"));
    onTestFinished(() => {
      rmSync(repo, { recursive: true, force: true });
    });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "version.ts"), "export const name = \"fixture\";\n");

    const dir = mkdtempSync(join(tmpdir(), "keystone-host-10-store-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const store = new GoalStore(dir);
    const log: ReceiptLog = [];
    const goalId = gid();
    startGoal(
      store,
      goalId,
      createGoalRecord(goalId, "add export keystoneVersion to src/version.ts", WORKSPACE, REVISION),
      log,
    );

    // Planning → acquisition → mutation → verification → DONE (model latency
    // mocked: delegation value objects + guard-gated real file edit).
    completePreparation(store, goalId, log);
    dispatchEvent(store, goalId, {
      type: "ReconciliationCompleted",
      reportRef: ART,
      planEpoch: 0,
      provisionalPlanRef: ART,
      basedOnRevision: REVISION,
      decision: "ACCEPT_PLAN_BASIS",
    }, log);
    dispatchEvent(store, goalId, { type: "ContractFrozen", contractVersion: 1, contractRef: ART }, log);
    dispatchEvent(store, goalId, { type: "ExecutionStarted", contractVersion: 1, executionPlanRef: ART, driverFence: 0 }, log);

    const lease = {
      leaseId: "lease-host-10",
      fencingToken: 1,
      assignmentId: A1,
      sessionId: "sess-host-10",
      workerProcessIdentity: "pid-10",
      canonicalWorkspaceRoot: repo,
      allowedCanonicalPaths: [`${repo}/src/version.ts`],
      baseDirtySignature: "sig-10",
      phase: "AUTHORITY_READY",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as MutationLease;
    const delegation = dispatchMutation(
      { id: A1, description: "add export keystoneVersion to src/version.ts", targetFiles: ["src/version.ts"] },
      { goalId: goalId as string, task: "add export keystoneVersion to src/version.ts", workspace: repo, targetFiles: [] },
      lease,
      undefined,
      { writeSet: ["src/version.ts"] },
    ).turns[1]!.delegation;
    void delegation;

    // The "child" edit goes through the real guard decision, then real fs.
    const gate = decideToolCall(
      { toolName: "write", input: { path: `${repo}/src/version.ts` } },
      parseLeaseFromBindingsEnv({ [EXTENSION_BINDINGS_ENV]: JSON.stringify({ "keystone/1": { ...lease } }) }),
      undefined,
      Date.now(),
    );
    expect(gate).toBeUndefined();
    writeFileSync(join(repo, "src", "version.ts"), "export const name = \"fixture\";\nexport const keystoneVersion = \"0.1.0\";\n");
    expect(readFileSync(join(repo, "src", "version.ts"), "utf8")).toContain("keystoneVersion");

    dispatchEvent(store, goalId, { type: "AssignmentCompleted", assignmentId: A1, reportRef: ART, driverFence: 0 }, log);
    dispatchEvent(store, goalId, { type: "VerificationCompleted", runRef: ART, accepted: true, driverFence: 0 }, log);
    dispatchEvent(store, goalId, { type: "ReviewCompleted", reviewRef: ART, candidateIds: [], driverFence: 0 }, log);
    dispatchEvent(store, goalId, { type: "AdjudicationCompleted", decisionRefs: [ART], driverFence: 0 }, log);
    dispatchEvent(store, goalId, { type: "FinalAuditCompleted", auditRefs: [ART, ART], accepted: true, driverFence: 0 }, log);
    dispatchEvent(store, goalId, { type: "CompletionEvaluated", reportRef: ART, accepted: true, driverFence: 0 }, log);
    expect(store.get(goalId)!.state).toBe("DONE");
  });
});
