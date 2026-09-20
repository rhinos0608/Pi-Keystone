// Baseline check runner — executes commands, captures output, classifies outcome.
// Uses execFile (never exec) to avoid shell injection.

import { execFile, type ExecFileOptions } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────────────

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EcosystemCheckId, EcosystemCheckResult, EcosystemInfo, PackageManager } from "./types.js";

export type CheckOutcome = "PASS" | "FAIL" | "TIMEOUT" | "UNAVAILABLE";

export type CheckRecord = {
  /** Executable or absolute path. Passed as-is to execFile — no shell. */
  command: string;
  /** Arguments. Optional — omit for bare command. */
  args?: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Extra env vars merged into process.env for the child. */
  env?: Record<string, string>;
  /** Max runtime in ms before kill. Default 30 000. */
  maxMs?: number;
  /** Max stdout/stderr buffer in bytes. Default 1 MiB. */
  maxBuffer?: number;
};

export type CheckResult = {
  outcome: CheckOutcome;
  stdout: string;
  stderr: string;
  /** Raw exit code. null when process was killed by signal or never started. */
  exitCode: number | null;
  /** Wall-clock duration in ms. */
  duration: number;
};

// ─── Runner ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_MS = 30_000;

export function runCheck(record: CheckRecord): Promise<CheckResult> {
  const maxMs = record.maxMs ?? DEFAULT_MAX_MS;

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...record.env };

  const opts: ExecFileOptions = {
    cwd: record.cwd,
    env: childEnv,
    timeout: maxMs,
    encoding: "utf-8",
    maxBuffer: record.maxBuffer ?? 1024 * 1024,
    killSignal: "SIGTERM",
  };

  const start = performance.now();

  return new Promise<CheckResult>((resolve) => {
    execFile(record.command, record.args ?? [], opts, (err, stdout, stderr) => {
      const duration = Math.round(performance.now() - start);
      const stdoutStr = typeof stdout === "string" ? stdout : (stdout?.toString("utf-8") ?? "");
      const stderrStr = typeof stderr === "string" ? stderr : (stderr?.toString("utf-8") ?? "");

      if (!err) {
        resolve({ outcome: "PASS", stdout: stdoutStr, stderr: stderrStr, exitCode: 0, duration });
        return;
      }

      const nodeErr = err as NodeJS.ErrnoException & {
        killed?: boolean;
        code?: string | number;
        signal?: string;
      };

      // Command not found
      if (nodeErr.code === "ENOENT") {
        resolve({ outcome: "UNAVAILABLE", stdout: stdoutStr, stderr: stderrStr, exitCode: null, duration });
        return;
      }

      // Timeout: execFile kills child, sets killed=true
      if (nodeErr.killed || nodeErr.signal === "SIGTERM" || nodeErr.code === "ETIMEDOUT") {
        resolve({ outcome: "TIMEOUT", stdout: stdoutStr, stderr: stderrStr, exitCode: null, duration });
        return;
      }

      // Non-zero exit code = FAIL
      const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : null;
      resolve({ outcome: "FAIL", stdout: stdoutStr, stderr: stderrStr, exitCode, duration });
    });
  });
}

// ─── Task 6: ecosystem discovery ────────────────────────────────────────────

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

function readPackageJson(root: string): PackageJson | null {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function detectManagerFromLockfiles(root: string, pkg: PackageJson | null): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  const pm = pkg?.packageManager?.trim() ?? "";
  if (pm.startsWith("pnpm")) return "pnpm";
  if (pm.startsWith("yarn")) return "yarn";
  if (pm.startsWith("bun")) return "bun";
  if (pm.startsWith("npm")) return "npm";
  return pkg ? "npm" : "unknown";
}

/** Map conventional script names to check roles (presence-based). */
export function mapScripts(scripts: Record<string, string> | undefined): EcosystemInfo["scripts"] {
  if (!scripts) return {};
  const mapped: { typecheck?: string; test?: string; lint?: string } = {};
  if (scripts["typecheck"]) mapped.typecheck = "typecheck";
  else if (scripts["type-check"]) mapped.typecheck = "type-check";
  else if (scripts["build"] && /tsc\b/.test(scripts["build"])) mapped.typecheck = "build";
  if (scripts["test"]) mapped.test = "test";
  if (scripts["lint"]) mapped.lint = "lint";
  else if (scripts["lint:check"]) mapped.lint = "lint:check";
  return mapped;
}

/**
 * detectEcosystem(root): read package.json + lockfiles to determine the
 * package manager and the scripts backing each check role. YAGNI: JS/TS only —
 * no package.json means an empty ecosystem whose checks are all UNAVAILABLE.
 */
export function detectEcosystem(root: string): EcosystemInfo {
  const pkg = readPackageJson(root);
  if (!pkg) {
    return { root, packageManager: "unknown", scripts: {}, toolVersions: {}, hasPackageJson: false };
  }
  return {
    root,
    packageManager: detectManagerFromLockfiles(root, pkg),
    scripts: mapScripts(pkg.scripts),
    toolVersions: {},
    hasPackageJson: true,
  };
}

// ─── Task 6: local binary resolution + version capture ──────────────────────

/** Resolve a tool from node_modules/.bin via fs stat. Null when absent. */
export function resolveLocalBinary(root: string, name: string): string | null {
  const candidates = process.platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const candidate of candidates) {
    const full = join(root, "node_modules", ".bin", candidate);
    try {
      const st = statSync(full);
      if (st.isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}

const CHECK_BINARIES: Record<EcosystemCheckId, string[]> = {
  typecheck: ["tsc"],
  test: ["vitest", "jest"],
  lint: ["eslint"],
};

function captureVersion(binary: string, cwd: string): Promise<string | null> {
  return runCheck({ command: binary, args: ["--version"], cwd, maxMs: 10_000 }).then((r) => {
    if (r.outcome !== "PASS") return null;
    const v = `${r.stdout.trim()} ${r.stderr.trim()}`.trim();
    return v.length > 0 ? v.slice(0, 200) : null;
  });
}

function unavailable(checkId: EcosystemCheckId, reason: string, root: string): EcosystemCheckResult {
  void root;
  return { checkId, status: "UNAVAILABLE", command: reason, exitCode: null, durationMs: 0, version: null, retried: false };
}

const detectionCache = new Map<string, { pkg: PackageJson | null; manager: PackageManager }>();

/**
 * Shared per-root package detection: read package.json + lockfiles once per
 * root and reuse the cached result across check roles instead of re-reading
 * the manifest and probing lockfiles for every check.
 */
export function detectForRoot(root: string): { pkg: PackageJson | null; manager: PackageManager } {
  const cached = detectionCache.get(root);
  if (cached) return cached;
  const pkg = readPackageJson(root);
  const detected = { pkg, manager: detectManagerFromLockfiles(root, pkg) };
  detectionCache.set(root, detected);
  return detected;
}

/** Test-only: clear the per-root detection cache. */
export function _clearDetectionCache(): void {
  detectionCache.clear();
}

/**
 * Honor an explicitly requested script name: resolve the check role through
 * that script when it exists so callers requesting a specific script execute
 * it rather than a re-derived alternative.
 */
function invocationForScript(
  root: string,
  checkId: EcosystemCheckId,
  scriptName: string,
  detected: { pkg: PackageJson | null; manager: PackageManager },
): ScriptInvocation | null {
  const rawBody = detected.pkg?.scripts?.[scriptName];
  if (!detected.pkg || rawBody === undefined) return null;
  if (detected.manager === "unknown") return null;
  return invocationFromMapped(root, checkId, scriptName, rawBody, detected.manager);
}

type ScriptInvocation = {
  executable: string;
  args: string[];
  display: string;
  versionBinary: string | null;
};

function versionBinaryForScript(root: string, checkId: EcosystemCheckId, raw: string): string | null {
  const firstToken = raw.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([^\s;&|]+)/)?.[1] ?? "";
  let versionBinary: string | null = null;
  if (firstToken === "node") versionBinary = process.execPath;
  else if (firstToken && !firstToken.includes("$")) {
    versionBinary = resolveLocalBinary(root, firstToken);
  }
  if (!versionBinary) versionBinary = resolveCheckBinary(root, checkId);
  return versionBinary;
}

function invocationFromMapped(
  root: string,
  checkId: EcosystemCheckId,
  mapped: string,
  raw: string,
  manager: PackageManager,
): ScriptInvocation | null {
  const executable = process.platform === "win32" ? `${manager}.cmd` : manager;
  const args = ["run", mapped];
  const versionBinary = versionBinaryForScript(root, checkId, raw);
  return {
    executable,
    args,
    display: `${manager} run ${mapped}`,
    versionBinary,
  };
}

/**
 * Resolve the repository's actual package script through its detected package
 * manager. We still call execFile directly, but let the package manager honor
 * the script's real flags/config/compound command instead of substituting a
 * generic tsc/vitest/eslint invocation.
 */
function resolveScriptInvocation(
  root: string,
  checkId: EcosystemCheckId,
  detected?: { pkg: PackageJson | null; manager: PackageManager },
): ScriptInvocation | null {
  const pkg = detected?.pkg ?? readPackageJson(root);
  const mapped = mapScripts(pkg?.scripts)[checkId];
  if (!pkg || !mapped) return null;
  const manager = detected?.manager ?? detectManagerFromLockfiles(root, pkg);
  if (manager === "unknown") return null;
  const raw = pkg.scripts?.[mapped] ?? "";
  return invocationFromMapped(root, checkId, mapped, raw, manager);
}

function outcomeStatus(result: CheckResult): EcosystemCheckResult["status"] {
  if (result.outcome === "PASS") return "PASS";
  if (result.outcome === "TIMEOUT") return "TIMEOUT";
  if (result.outcome === "UNAVAILABLE" || result.exitCode === 127) return "UNAVAILABLE";
  return "FAIL";
}

/**
 * Run one ecosystem check through the repository's mapped package script.
 * execFile invokes the package manager without a shell command string; the
 * repository itself owns the script body. Missing scripts/managers/tools are
 * recorded as UNAVAILABLE rather than fabricated or installed.
 */
export async function runEcosystemCheck(
  root: string,
  checkId: EcosystemCheckId,
  scriptName?: string,
  opts?: { maxMs?: number },
): Promise<EcosystemCheckResult> {
  const maxMs = opts?.maxMs ?? 60_000;
  const detected = detectForRoot(root);
  const invocation = scriptName !== undefined
    ? invocationForScript(root, checkId, scriptName, detected)
    : resolveScriptInvocation(root, checkId, detected);
  if (!invocation) return unavailable(checkId, `${checkId}: no script or package manager`, root);
  const version = invocation.versionBinary ? await captureVersion(invocation.versionBinary, root) : null;
  const first = await runCheck({
    command: invocation.executable,
    args: invocation.args,
    cwd: root,
    maxMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    checkId,
    status: outcomeStatus(first),
    command: invocation.display,
    exitCode: first.exitCode,
    durationMs: first.duration,
    version,
    retried: false,
  };
}

/** Resolve the first available local binary for a check role. Null when absent. */
function resolveCheckBinary(root: string, checkId: EcosystemCheckId): string | null {
  for (const name of CHECK_BINARIES[checkId]) {
    const binary = resolveLocalBinary(root, name);
    if (binary) return binary;
  }
  return null;
}

/**
 * Single shared retry core for ecosystem checks: run once, retry once on
 * non-pass; pass-on-retry aggregates to FLAKY. Both runEcosystemCheckWithRetry
 * and runEcosystemCheckCaptured delegate here so retry/flaky semantics stay
 * unified.
 */
async function runEcosystemAttemptWithSingleRetry(
  invocation: ScriptInvocation,
  checkId: EcosystemCheckId,
  cwd: string,
  maxMs: number,
  version: string | null,
): Promise<CapturedEcosystemCheck> {
  const run = () => runCheck({
    command: invocation.executable,
    args: invocation.args,
    cwd,
    maxMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const first = await run();
  const firstStatus = outcomeStatus(first);
  if (firstStatus === "PASS") {
    return {
      result: { checkId, status: "PASS", command: invocation.display, exitCode: first.exitCode, durationMs: first.duration, version, retried: false },
      stdout: first.stdout,
      stderr: first.stderr,
      flaky: false,
    };
  }
  // A missing package manager or script executable is not a flaky check and
  // should not be retried as though it were a test failure.
  if (firstStatus === "UNAVAILABLE") {
    return {
      result: { checkId, status: "UNAVAILABLE", command: invocation.display, exitCode: first.exitCode, durationMs: first.duration, version, retried: false },
      stdout: first.stdout,
      stderr: first.stderr,
      flaky: false,
    };
  }
  const second = await run();
  const secondStatus = outcomeStatus(second);
  if (secondStatus === "PASS") {
    return {
      result: { checkId, status: "FLAKY", command: invocation.display, exitCode: second.exitCode, durationMs: first.duration + second.duration, version, retried: true },
      stdout: second.stdout,
      stderr: second.stderr,
      flaky: true,
    };
  }
  return {
    result: {
      checkId,
      status: secondStatus,
      command: invocation.display,
      exitCode: second.exitCode,
      durationMs: first.duration + second.duration,
      version,
      retried: true,
    },
    stdout: `${first.stdout}\n${second.stdout}`,
    stderr: `${first.stderr}\n${second.stderr}`,
    flaky: false,
  };
}

// ─── Task 6: retry once, classify pass-on-retry as flaky ────────────────────
// (retry core above; both runEcosystemCheck variants delegate to it)

export type RetryCheckResult = CheckResult & {
  retried: boolean;
  /** True when the first attempt failed but the retry passed. */
  flaky: boolean;
};

/** Run a raw check; on failure retry once. Pass-on-retry marks flaky. */
export async function runCheckWithRetry(record: CheckRecord): Promise<RetryCheckResult> {
  const first = await runCheck(record);
  if (first.outcome === "PASS") return { ...first, retried: false, flaky: false };
  const second = await runCheck(record);
  if (second.outcome === "PASS") return { ...second, retried: true, flaky: true };
  return { ...second, retried: true, flaky: false };
}

/**
 * Run an ecosystem check with one retry; pass-on-retry aggregates to FLAKY.
 * Missing script/binary stays UNAVAILABLE without retry.
 */
export async function runEcosystemCheckWithRetry(
  root: string,
  checkId: EcosystemCheckId,
  scriptName?: string,
  opts?: { maxMs?: number },
): Promise<EcosystemCheckResult & { flaky: boolean }> {
  const maxMs = opts?.maxMs ?? 60_000;
  const detected = detectForRoot(root);
  const invocation = scriptName !== undefined
    ? invocationForScript(root, checkId, scriptName, detected)
    : resolveScriptInvocation(root, checkId, detected);
  if (!invocation) return { ...unavailable(checkId, `${checkId}: no script or package manager`, root), flaky: false };
  const version = invocation.versionBinary ? await captureVersion(invocation.versionBinary, root) : null;
  const captured = await runEcosystemAttemptWithSingleRetry(invocation, checkId, root, maxMs, version);
  return { ...captured.result, flaky: captured.flaky };
}

export type CapturedEcosystemCheck = {
  result: EcosystemCheckResult;
  stdout: string;
  stderr: string;
  flaky: boolean;
};

/**
 * Full captured run: same resolution as runEcosystemCheck but also returns
 * stdout/stderr for fingerprint parsing, with one retry (pass-on-retry →
 * FLAKY). Dirty/red output is recorded, never blocked.
 */
export async function runEcosystemCheckCaptured(
  root: string,
  checkId: EcosystemCheckId,
  opts?: { maxMs?: number },
): Promise<CapturedEcosystemCheck> {
  const maxMs = opts?.maxMs ?? 60_000;
  const invocation = resolveScriptInvocation(root, checkId, detectForRoot(root));
  if (!invocation) {
    return { result: unavailable(checkId, `${checkId}: no script or package manager`, root), stdout: "", stderr: "", flaky: false };
  }
  const version = invocation.versionBinary ? await captureVersion(invocation.versionBinary, root) : null;
  return runEcosystemAttemptWithSingleRetry(invocation, checkId, root, maxMs, version);
}
