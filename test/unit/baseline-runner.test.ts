import { describe, it, expect } from "vitest";
import { runCheck, type CheckRecord, type CheckResult } from "../../src/baseline/runner.ts";
import { tmpdir } from "node:os";

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
