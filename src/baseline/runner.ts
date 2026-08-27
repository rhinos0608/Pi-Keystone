// Baseline check runner — executes commands, captures output, classifies outcome.
// Uses execFile (never exec) to avoid shell injection.

import { execFile, type ExecFileOptions } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────────────

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
    maxBuffer: 1024 * 1024,
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
