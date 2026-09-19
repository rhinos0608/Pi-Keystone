import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.KEYSTONE_LIVE_E2E === "1";
const DEPTH = process.env.KEYSTONE_LIVE_E2E_DEPTH === "full" ? "full" : "standard";
const SUBAGENTS_ENTRY = process.env.PI_SUBAGENTS_ENTRY
  ?? fileURLToPath(new URL("../../../pi-subagents/index.ts", import.meta.url));
const DRIVER_ENTRY = fileURLToPath(new URL("./live-e2e-driver.ts", import.meta.url));

type E2EResult = {
  ok?: boolean;
  error?: string;
  state?: string;
  recoveryRequired?: boolean;
  lifecycleDepth?: string;
  outputExists?: boolean;
  outputContent?: string | null;
  parentModelBefore?: string;
  parentModelAfter?: string;
  observedChildren?: Array<{ agent: string; model?: string; source?: string }>;
  notifications?: Array<{ message: string; type?: string }>;
};
function expectedRoleModelChains(): Record<string, string[]> {
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
    ) as {
      subagents?: {
        agentOverrides?: Record<
          string,
          { model?: string; fallbackModels?: string[] }
        >;
      };
    };
    const overrides = settings.subagents?.agentOverrides ?? {};
    const chainFor = (role: string): string[] => {
      const override = overrides[role];
      return [override?.model, ...(override?.fallbackModels ?? [])].filter(
        (model): model is string => typeof model === "string" && model.length > 0,
      );
    };
    return {
      scout: chainFor("scout"),
      worker: chainFor("worker"),
      reviewer: chainFor("reviewer"),
      oracle: chainFor("oracle"),
    };
  } catch {
    return {};
  }
}

function matchesConfiguredModel(
  actual: string | undefined,
  configuredChain: string[],
): boolean {
  if (!actual) return false;
  return configuredChain.some(
    (configured) =>
      actual === configured || actual.startsWith(`${configured}:`),
  );
}

function initFixture(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "keystone-live-e2e", private: true }, null, 2),
  );
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
    });
  run(["init"]);
  run(["config", "user.email", "keystone-e2e@example.com"]);
  run(["config", "user.name", "Keystone E2E"]);
  run(["add", "package.json"]);
  run(["commit", "-m", "fixture"]);
}

async function waitForResult(
  resultPath: string,
  child: ReturnType<typeof spawn>,
  stdout: () => string,
  stderr: () => string,
): Promise<E2EResult> {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as E2EResult;
      if (!child.killed) child.kill("SIGTERM");
      return parsed;
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Pi exited before E2E result. code=${child.exitCode}\nstdout:\n${stdout().slice(-4000)}\nstderr:\n${stderr().slice(-4000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!child.killed) child.kill("SIGKILL");
  throw new Error(
    `Timed out waiting for E2E result.\nstdout:\n${stdout().slice(-4000)}\nstderr:\n${stderr().slice(-4000)}`,
  );
}
describe("live Keystone + pi-subagents E2E", () => {
  const liveIt = ENABLED ? it : it.skip;

  liveIt(
    "runs a real goal with configured subagent model chains and leaves the parent model unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "keystone-live-e2e-"));
      const resultPath = join(root, "e2e-result.json");
      initFixture(root);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KEYSTONE_E2E_RESULT: resultPath,
        KEYSTONE_E2E_DEPTH: DEPTH,
        KEYSTONE_E2E_TASK:
          "Create e2e-output.md containing exactly keystone-live-e2e-ok.",
      };
      delete env.PI_SUBAGENT_CHILD;

      let out = "";
      let err = "";
      const child = spawn(
        "pi",
        [
          "--mode",
          "rpc",
          "--no-session",
          "-e",
          SUBAGENTS_ENTRY,
          "-e",
          DRIVER_ENTRY,
        ],
        {
          cwd: root,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.stdin?.on("error", () => {
        // Process-exit races are reported by waitForResult with full output.
      });
      let keepaliveSeq = 0;
      const sendKeepalive = () => {
        if (child.exitCode !== null || !child.stdin?.writable) return;
        child.stdin.write(
          JSON.stringify({ id: `keystone-e2e-keepalive-${keepaliveSeq++}`, type: "get_state" }) + "\n",
        );
      };
      sendKeepalive();
      const keepalive = setInterval(sendKeepalive, 1_000);
      keepalive.unref?.();

      let result: E2EResult;
      try {
        result = await waitForResult(
          resultPath,
          child,
          () => out,
          () => err,
        );
      } finally {
        clearInterval(keepalive);
        if (!child.killed) child.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }

      try {
        expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
        expect(result.state).toBe("DONE");
        expect(result.recoveryRequired).toBe(false);
        expect(result.lifecycleDepth).toBe(DEPTH);
        expect(result.outputExists).toBe(true);
        expect(result.outputContent).toBe("keystone-live-e2e-ok");
        if (result.parentModelBefore && result.parentModelAfter) {
          expect(result.parentModelAfter).toBe(result.parentModelBefore);
        }

        const expected = expectedRoleModelChains();
        const observed = result.observedChildren ?? [];
        const requiredRoles =
          DEPTH === "full"
            ? (["scout", "worker", "reviewer", "oracle"] as const)
            : (["scout", "worker", "reviewer"] as const);
        for (const role of requiredRoles) {
          const configuredChain = expected[role] ?? [];
          if (configuredChain.length === 0) continue;
          expect(
            observed.some(
              (row) =>
                row.agent === role
                && matchesConfiguredModel(row.model, configuredChain),
            ),
            `Missing configured ${role} model chain ${configuredChain.join(", ")}. Observed: ${JSON.stringify(observed)}`,
          ).toBe(true);
        }
      } finally {
        if (!child.killed) child.kill("SIGKILL");
      }
    },
    9 * 60_000,
  );
});
