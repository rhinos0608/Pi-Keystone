/**
 * Dual-order RPC readiness (live host).
 *
 * Reproduces the user-observed failure: with pi-subagents + Keystone both
 * loaded, either extension order previously emitted
 * "Keystone: pi-subagents RPC not ready; live spawn disabled (Timed out
 * waiting for subagents:rpc:v1:ready after 5000ms.)".
 * The ping-probe fix in src/rpc/subagent-rpc-client.ts should close it in
 * both orders.
 *
 * Live tests spawn the real `pi` binary headless
 * (`--mode rpc --no-session`, mirroring ladder item 1) with BOTH extensions
 * via repeated `-e`, in each order, inside a temp cwd. Missing pi binary or
 * missing pi-subagents entrypoint -> explicit SKIP, never fail.
 *
 * Root cause note (diagnosed 2026-09-16): the spawned `pi` MUST NOT inherit
 * `PI_SUBAGENT_CHILD=1`. pi-subagents self-disables when it is set
 * (pi-subagents/src/extension/index.ts:427 `if (SUBAGENT_CHILD_ENV) return` +
 * root index.ts `PI_SUBAGENT_CHILD` branch) — no RPC request handler, no
 * session_start handler, no ready emit, no ping reply. The vitest process
 * itself often runs inside a pi child session, so the var is stripped from
 * the child's env below. Symptom without the strip: ready never seen in
 * either order (test-environment artifact, not a bridge bug).
 *
 * Separate known issue (Keystone-side, NOT covered here): after waitReady
 * passes, Keystone's `ensureKeystoneSessionBridges` fails with
 * "Capability-ceiling registry absent" because pi-subagents creates that
 * global Map lazily on first ceiling registration while Keystone's mirror
 * resolver throws when absent instead of creating. Needs a src-owner fix;
 * this test asserts only RPC readiness (waitReady), not ceiling bridging.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SubagentRpcClient } from "../../src/rpc/subagent-rpc-client.js";
import { RpcTimeoutError } from "../../src/rpc/types.js";

const SUCCESS_SIGNAL = "Keystone: extension loaded, session ready";
const FAILURE_SIGNAL = "RPC not ready";
const SUBAGENTS_ENTRY = process.env.PI_SUBAGENTS_ENTRY
  ?? fileURLToPath(new URL("../../../pi-subagents/index.ts", import.meta.url));
const KEYSTONE_ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

/** Post-ready grace: waitReady uses a 5000ms timeout, so the failure line
 *  lands ~5s after the success line. Observe past that before asserting. */
const POST_READY_GRACE_MS = 7500;
const CHILD_CAP_MS = 30_000;
const EXCERPT_CHARS = 2000;

/** Spawn env for the headless `pi` host. MUST strip PI_SUBAGENT_CHILD:
 * pi-subagents self-disables when it is set (no RPC bridge), and the vitest
 * process itself often runs inside a pi child session. */
function strippedChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PI_OFFLINE: "1" };
  delete env.PI_SUBAGENT_CHILD;
  return env;
}

type OrderResult = {
  out: string;
  err: string;
  spawnFailed: boolean;
  readySeen: boolean;
  failureSeen: boolean;
  observedPostReadyMs: number;
};

function runOrder(first: string, second: string): Promise<OrderResult> {
  const cwd = mkdtempSync(join(tmpdir(), "keystone-dual-order-"));
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "pi",
        ["--mode", "rpc", "--no-session", "-e", first, "-e", second, "--offline", "--no-tools"],
        {
          cwd,
          // stdin MUST stay a held-open pipe (never "ignore"): the rpc host
          // idles on stdin, so a closed stdin lets it exit right after the
          // offline prompt turn and the 6s post-ready hold below flakes.
          stdio: ["pipe", "pipe", "pipe"],
          env: strippedChildEnv(),
        },
      );
    } catch {
      rmSync(cwd, { recursive: true, force: true });
      resolve({ out: "", err: "", spawnFailed: true, readySeen: false, failureSeen: false, observedPostReadyMs: 0 });
      return;
    }
    let out = "";
    let err = "";
    let readyAt = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      if (postReady !== undefined) clearTimeout(postReady);
      clearInterval(keepalive);
      if (!child.killed) child.kill("SIGKILL");
      rmSync(cwd, { recursive: true, force: true });
      const combined = `${out}\n${err}`;
      resolve({
        out,
        err,
        spawnFailed: false,
        readySeen: combined.includes(SUCCESS_SIGNAL),
        failureSeen: combined.includes(FAILURE_SIGNAL),
        observedPostReadyMs: readyAt > 0 ? Date.now() - readyAt : 0,
      });
    };
    const cap = setTimeout(finish, CHILD_CAP_MS);
    let postReady: ReturnType<typeof setTimeout> | undefined;
    let keepaliveSeq = 0;
    const sendKeepalive = () => {
      if (child.exitCode !== null || !child.stdin?.writable) return;
      child.stdin.write(
        JSON.stringify({ id: `dual-order-keepalive-${keepaliveSeq++}`, type: "get_state" }) + "\n",
      );
    };
    sendKeepalive();
    const keepalive = setInterval(sendKeepalive, 1_000);
    keepalive.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (!readyAt && `${out}\n${err}`.includes(SUCCESS_SIGNAL)) {
        readyAt = Date.now();
        postReady = setTimeout(finish, POST_READY_GRACE_MS);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (!readyAt && `${out}\n${err}`.includes(SUCCESS_SIGNAL)) {
        readyAt = Date.now();
        postReady = setTimeout(finish, POST_READY_GRACE_MS);
      }
    });
    child.on("error", finish);
    child.on("exit", finish);
  });
}

function excerpt(r: OrderResult): string {
  return `${r.out}\n${r.err}`.slice(-EXCERPT_CHARS);
}

async function checkOrder(
  ctx: unknown,
  label: string,
  first: string,
  second: string,
): Promise<void> {
  const skip = (reason: string) => {
    console.log(`SKIPPED (${label}): ${reason}`);
    (ctx as unknown as { skip(): void }).skip();
  };
  if (!existsSync(SUBAGENTS_ENTRY)) {
    skip(`pi-subagents entry missing: ${SUBAGENTS_ENTRY}`);
    return;
  }
  if (!existsSync(KEYSTONE_ENTRY)) {
    skip(`keystone entry missing: ${KEYSTONE_ENTRY}`);
    return;
  }
  const r = await runOrder(first, second);
  if (r.spawnFailed) {
    skip("pi spawn failed (binary missing or not executable)");
    return;
  }
  const diag = `[${label}] ready=${r.readySeen} failure=${r.failureSeen} postReadyMs=${r.observedPostReadyMs}\n--- output excerpt ---\n${excerpt(r)}`;
  expect(r.readySeen, `${diag}\nFAIL: success signal never appeared`).toBe(true);
  expect(r.failureSeen, `${diag}\nFAIL: "RPC not ready" line still emitted`).toBe(false);
  expect(
    r.observedPostReadyMs >= 6000,
    `${diag}\nFAIL: child exited before the 5s waitReady window elapsed; absence of the failure line proves nothing`,
  ).toBe(true);
}

describe("dual-order rpc readiness [live-host]", () => {
  it(
    "order A live: pi-subagents then Keystone shows ready, no RPC-not-ready",
    async (ctx) => {
      await checkOrder(ctx, "order-A", SUBAGENTS_ENTRY, KEYSTONE_ENTRY);
    },
    45_000,
  );

  it(
    "order B live: Keystone then pi-subagents shows ready, no RPC-not-ready",
    async (ctx) => {
      await checkOrder(ctx, "order-B", KEYSTONE_ENTRY, SUBAGENTS_ENTRY);
    },
    45_000,
  );

  it("unit: bridge never starts -> waitReady rejects typed RpcTimeoutError", async () => {
    const silentBus = { on() {}, emit() {} };
    const client = new SubagentRpcClient(silentBus, { sourceExtension: "keystone-dual-order-test" });
    try {
      await expect(client.waitReady(300)).rejects.toBeInstanceOf(RpcTimeoutError);
    } finally {
      client.dispose();
    }
  });
});
