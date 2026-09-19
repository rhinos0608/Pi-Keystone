import { describe, it, expect, afterAll } from "vitest";
import { runCheck, type CheckRecord, type CheckResult } from "../../src/baseline/runner.ts";
import {
  detectEcosystem,
  mapScripts,
  resolveLocalBinary,
  runCheckWithRetry,
  runEcosystemCheck,
  runEcosystemCheckCaptured,
} from "../../src/baseline/runner.ts";
import { captureEcosystemBaseline } from "../../src/baseline/orchestrator.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CWD = tmpdir();

function check(overrides: Partial<CheckRecord>): CheckRecord {
  return { command: "true", cwd: CWD, ...overrides };
}

// ─── Successful command ─────────────────────────────────────────────────────

describe("runCheck", () => {
  it("returns PASS with stdout for a succeeding command", async () => {
    const result = await runCheck(check({ command: "echo", args: ["hello"] }));
    expect(result.outcome).toBe("PASS");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  // ─── Failing command ────────────────────────────────────────────────────

  it("returns FAIL with non-zero exit code", async () => {
    const result = await runCheck(check({ command: "sh", args: ["-c", "exit 42"] }));
    expect(result.outcome).toBe("FAIL");
    expect(result.exitCode).toBe(42);
  });

  // ─── Timeout ────────────────────────────────────────────────────────────

  it("returns TIMEOUT when command exceeds maxMs", async () => {
    const result = await runCheck(check({ command: "sleep", args: ["10"], maxMs: 200 }));
    expect(result.outcome).toBe("TIMEOUT");
    expect(result.exitCode).toBeNull();
    expect(result.duration).toBeLessThan(5000);
  });

  // ─── Command not found → UNAVAILABLE ────────────────────────────────────

  it("returns UNAVAILABLE for a nonexistent command", async () => {
    const result = await runCheck(check({ command: "definitely-not-a-real-command-xyz" }));
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.exitCode).toBeNull();
  });

  // ─── Env capture ────────────────────────────────────────────────────────

  it("passes env vars to the child process", async () => {
    const result = await runCheck(
      check({
        command: "sh",
        args: ["-c", "echo $KEYSTONE_TEST_VAR"],
        env: { KEYSTONE_TEST_VAR: "injected-value" },
      }),
    );
    expect(result.outcome).toBe("PASS");
    expect(result.stdout.trim()).toBe("injected-value");
  });

  // ─── Exit code mapping ──────────────────────────────────────────────────

  it("maps various exit codes to FAIL", async () => {
    for (const code of [1, 2, 127, 255]) {
      const result = await runCheck(
        check({ command: "sh", args: ["-c", `exit ${code}`] }),
      );
      expect(result.outcome).toBe("FAIL");
      expect(result.exitCode).toBe(code);
    }
  });

  it("maps exit code 0 to PASS", async () => {
    const result = await runCheck(check({ command: "sh", args: ["-c", "exit 0"] }));
    expect(result.outcome).toBe("PASS");
    expect(result.exitCode).toBe(0);
  });

  // ─── Stderr capture ─────────────────────────────────────────────────────

  it("captures stderr output", async () => {
    const result = await runCheck(
      check({ command: "sh", args: ["-c", "echo oops >&2"] }),
    );
    expect(result.stderr.trim()).toBe("oops");
  });

  // ─── Duration ───────────────────────────────────────────────────────────

  it("records positive duration", async () => {
    const result = await runCheck(check({ command: "echo", args: ["go"] }));
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration).toBe("number");
  });

  // ─── Default timeout ────────────────────────────────────────────────────

  it("uses default 30s timeout when maxMs omitted", async () => {
    const result = await runCheck(check({ command: "echo", args: ["fast"] }));
    expect(result.outcome).toBe("PASS");
    expect(result.duration).toBeLessThan(10_000);
  });
});

// ─── Task 6: ecosystem discovery ────────────────────────────────────────────

// POSIX-only: the fake binaries below are Bourne shell scripts executed via
// `sh` and `#!/bin/sh`; the suite requires a POSIX shell and is skipped on
// win32.
const POSIX_ONLY = process.platform === "win32";

const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(pkg: Record<string, unknown>, lockfiles: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "keystone-eco-"));
  fixtureDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const lock of lockfiles) writeFileSync(join(dir, lock), "");
  return dir;
}

function installFakeBinary(root: string, name: string, body: string): string {
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const full = join(binDir, name);
  writeFileSync(full, `#!/bin/sh\n${body}\n`);
  chmodSync(full, 0o755);
  return full;
}

describe("detectEcosystem", () => {
  it("maps scripts and lockfile to manager", () => {
    const dir = makeFixture(
      { scripts: { typecheck: "tsc --noEmit", test: "vitest run" } },
      ["package-lock.json"],
    );
    const eco = detectEcosystem(dir);
    expect(eco.hasPackageJson).toBe(true);
    expect(eco.packageManager).toBe("npm");
    expect(eco.scripts.typecheck).toBe("typecheck");
    expect(eco.scripts.test).toBe("test");
    expect(eco.scripts.lint).toBeUndefined();
  });

  it("detects pnpm from lockfile", () => {
    const dir = makeFixture({ scripts: {} }, ["pnpm-lock.yaml"]);
    expect(detectEcosystem(dir).packageManager).toBe("pnpm");
  });

  it("maps build containing tsc to typecheck", () => {
    expect(mapScripts({ build: "tsc -p ." }).typecheck).toBe("build");
    expect(mapScripts({ build: "esbuild src" }).typecheck).toBeUndefined();
  });

  it("returns empty ecosystem with unknown manager when no package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-noeco-"));
    fixtureDirs.push(dir);
    const eco = detectEcosystem(dir);
    expect(eco.hasPackageJson).toBe(false);
    expect(eco.packageManager).toBe("unknown");
    expect(eco.scripts).toEqual({});
  });
});

describe("resolveLocalBinary", () => {
  it("resolves a present binary via fs stat", () => {
    const dir = makeFixture({ scripts: {} });
    installFakeBinary(dir, "tsc", "exit 0");
    expect(resolveLocalBinary(dir, "tsc")).toContain(join("node_modules", ".bin", "tsc"));
  });

  it("returns null for a missing binary", () => {
    const dir = makeFixture({ scripts: {} });
    expect(resolveLocalBinary(dir, "eslint")).toBeNull();
  });
});

describe("runEcosystemCheck", () => {
  it("executes a present tool and records its version", async () => {
    const dir = makeFixture({ scripts: { typecheck: "tsc --noEmit" } });
    installFakeBinary(dir, "tsc", 'if [ "$1" = "--version" ]; then echo "Version 5.7.0"; exit 0; fi\nexit 0');
    const result = await runEcosystemCheck(dir, "typecheck", "typecheck");
    expect(result.status).toBe("PASS");
    expect(result.version).toContain("5.7.0");
    expect(result.exitCode).toBe(0);
  });

  it("honors the repository script arguments instead of substituting hardcoded defaults", async () => {
    const dir = makeFixture({ scripts: { typecheck: "tsc --project custom.json" } });
    installFakeBinary(
      dir,
      "tsc",
      'if [ "$1" = "--version" ]; then echo "Version 5.7.0"; exit 0; fi\n[ "$1" = "--project" ] && [ "$2" = "custom.json" ]',
    );
    const result = await runEcosystemCheck(dir, "typecheck", "typecheck");
    expect(result.status).toBe("PASS");
    expect(result.command).toBe("npm run typecheck");
  });

  it("returns UNAVAILABLE when no script maps to the check", async () => {
    const dir = makeFixture({ scripts: { test: "vitest run" } });
    const result = await runEcosystemCheck(dir, "lint", undefined);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.exitCode).toBeNull();
    expect(result.version).toBeNull();
  });

  it("returns UNAVAILABLE when the script exists but the binary is missing", async () => {
    const dir = makeFixture({ scripts: { lint: "eslint ." } });
    const result = await runEcosystemCheck(dir, "lint", "lint");
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.version).toBeNull();
  });
});

describe("runCheckWithRetry", () => {
  const posixIt = POSIX_ONLY ? it.skip : it;
  posixIt("marks pass-on-retry as flaky", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keystone-flaky-"));
    fixtureDirs.push(dir);
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    const result = await runCheckWithRetry({
      command: "sh",
      args: ["-c", `n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"; [ "$n" -ge 2 ]`],
      cwd: dir,
    });
    expect(result.retried).toBe(true);
    expect(result.flaky).toBe(true);
    expect(result.outcome).toBe("PASS");
  });

  it("reports stable failure without flaky", async () => {
    const result = await runCheckWithRetry({ command: "sh", args: ["-c", "exit 1"], cwd: tmpdir() });
    expect(result.outcome).toBe("FAIL");
    expect(result.retried).toBe(true);
    expect(result.flaky).toBe(false);
  });
});

describe("captureEcosystemBaseline", () => {
  it("records present tools, UNAVAILABLE lint, and stays valid on a dirty red repo", async () => {
    const dir = makeFixture({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", lint: "eslint ." } });
    installFakeBinary(dir, "tsc", 'if [ "$1" = "--version" ]; then echo "Version 5.7.0"; exit 0; fi\nexit 0');
    installFakeBinary(
      dir,
      "vitest",
      'if [ "$1" = "--version" ]; then echo "vitest 3.2.1"; exit 0; fi\necho "FAIL src/a.test.ts > suite > test one"\nexit 1',
    );
    writeFileSync(join(dir, "dirty-note.txt"), "uncommitted dirt");
    const baseline = await captureEcosystemBaseline(dir, { maxMs: 15_000 });
    expect(baseline.checks.typecheck.status).toBe("PASS");
    expect(baseline.checks.typecheck.version).toContain("5.7.0");
    expect(baseline.checks.test?.status).toBe("FAIL");
    expect(baseline.checks.lint?.status).toBe("UNAVAILABLE");
    expect(baseline.failureFingerprints.length).toBeGreaterThan(0);
    expect(Object.keys(baseline.contentHashes)).toHaveLength(baseline.failureFingerprints.length);
    expect(baseline.dirtySignature).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.capturedAt.length).toBeGreaterThan(0);
  });

  it("uses content-sensitive snapshot identity and preserves staged vs modified dirt", async () => {
    const dir = makeFixture({ scripts: {} }, ["package-lock.json"]);
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Keystone Test"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "v1");
    execFileSync("git", ["add", "package.json", "package-lock.json", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

    writeFileSync(join(dir, "tracked.txt"), "v2");
    const first = await captureEcosystemBaseline(dir, { maxMs: 15_000 });
    expect(first.worktree.modified).toContain("tracked.txt");
    expect(first.worktree.staged).not.toContain("tracked.txt");

    writeFileSync(join(dir, "tracked.txt"), "v3");
    const second = await captureEcosystemBaseline(dir, { maxMs: 15_000 });
    expect(second.dirtySignature).not.toBe(first.dirtySignature);

    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    const staged = await captureEcosystemBaseline(dir, { maxMs: 15_000 });
    expect(staged.worktree.staged).toContain("tracked.txt");
    expect(staged.worktree.modified).not.toContain("tracked.txt");
  });

  it("captured run exposes stdout for fingerprint parsing", async () => {
    const dir = makeFixture({ scripts: { test: "vitest run" } });
    installFakeBinary(
      dir,
      "vitest",
      'if [ "$1" = "--version" ]; then echo "vitest 3.2.1"; exit 0; fi\necho "FAIL src/a.test.ts > suite > test one"\nexit 1',
    );
    const captured = await runEcosystemCheckCaptured(dir, "test", { maxMs: 15_000 });
    expect(captured.stdout).toContain("FAIL");
    expect(captured.result.status).toBe("FAIL");
    expect(captured.result.retried).toBe(true);
  });
});
