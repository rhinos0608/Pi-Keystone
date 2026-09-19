import { test, expect } from "vitest";
import {
  computeFingerprint,
  normalizeStderr,
  classifyFailures,
  parseTscOutput,
  parseTestOutput,
  parseEslintOutput,
  parseFailureFingerprints,
  quarantineUnparsedOutput,
  hashParsedFailure,
  type FailureInput,
} from "../../src/baseline/failure-fingerprint.js";

// ── Determinism ─────────────────────────────────────────────────────────────

test("same input always produces same fingerprint", () => {
  const input: FailureInput = {
    command: "npm test",
    stderr: "Error: ENOENT",
    exitCode: 1,
  };

  const fp1 = computeFingerprint(input);
  const fp2 = computeFingerprint(input);

  expect(fp1).toBe(fp2);
  expect(fp1).toMatch(/^[a-f0-9]{64}$/);
});

// ── Different failure → different fingerprint ───────────────────────────────

test("different stderr produces different fingerprint", () => {
  const a = computeFingerprint({ command: "npm test", stderr: "Error A", exitCode: 1 });
  const b = computeFingerprint({ command: "npm test", stderr: "Error B", exitCode: 1 });

  expect(a).not.toBe(b);
});

test("different command produces different fingerprint", () => {
  const a = computeFingerprint({ command: "npm test", stderr: "err", exitCode: 1 });
  const b = computeFingerprint({ command: "yarn test", stderr: "err", exitCode: 1 });

  expect(a).not.toBe(b);
});

// ── Exit code matters ───────────────────────────────────────────────────────

test("exit code affects fingerprint", () => {
  const a = computeFingerprint({ command: "cmd", stderr: "out", exitCode: 1 });
  const b = computeFingerprint({ command: "cmd", stderr: "out", exitCode: 2 });

  expect(a).not.toBe(b);
});

test("same exit code produces same fingerprint", () => {
  const a = computeFingerprint({ command: "cmd", stderr: "out", exitCode: 1 });
  const b = computeFingerprint({ command: "cmd", stderr: "out", exitCode: 1 });

  expect(a).toBe(b);
});

// ── stderr normalization ────────────────────────────────────────────────────

test("normalization strips ISO-8601 timestamps", () => {
  const a = normalizeStderr("2024-01-15T10:30:00.000Z error occurred");
  const b = normalizeStderr("2024-06-20T14:00:00.000Z error occurred");

  expect(a).toBe(b);
  expect(a).toContain("<TIMESTAMP>");
});

test("normalization strips timezone-offset timestamps", () => {
  const a = normalizeStderr("2024-01-15T10:30:00+05:30 error");
  const b = normalizeStderr("2024-01-15T10:30:00+00:00 error");

  expect(a).toBe(b);
});

test("normalization strips UNIX absolute paths", () => {
  const a = normalizeStderr("Error in /home/user/project/src/app.ts");
  const b = normalizeStderr("Error in /tmp/build/src/app.ts");

  expect(a).toBe(b);
  expect(a).toContain("<PATH>");
});

test("normalization strips Windows paths", () => {
  const a = normalizeStderr("Error in C:\\Users\\me\\file.ts");
  const b = normalizeStderr("Error in D:\\other\\file.ts");

  expect(a).toBe(b);
  expect(a).toContain("<WINPATH>");
});

test("normalization collapses whitespace", () => {
  const a = normalizeStderr("error   with    many     spaces");
  expect(a).toBe("error with many spaces");
});

test("normalization strips PIDs", () => {
  const a = normalizeStderr("Process pid=12345 failed");
  const b = normalizeStderr("Process pid=99999 failed");

  expect(a).toBe(b);
  expect(a).toContain("PID=<PID>");
});

test("fingerprint uses normalized stderr", () => {
  const a = computeFingerprint({
    command: "test",
    stderr: "2024-01-15T10:30:00Z Error at /foo/bar.ts",
    exitCode: 1,
  });
  const b = computeFingerprint({
    command: "test",
    stderr: "2024-06-20T14:00:00Z Error at /baz/qux.ts",
    exitCode: 1,
  });

  expect(a).toBe(b);
});

// ── Classification: FAIL ────────────────────────────────────────────────────

test("all same fingerprint → FAIL", () => {
  const input: FailureInput = { command: "npm test", stderr: "Error", exitCode: 1 };
  const result = classifyFailures([input, input, input]);

  expect(result.classification).toBe("FAIL");
  expect(result.distinctCount).toBe(1);
});

// ── Classification: FLAKY ───────────────────────────────────────────────────

test("multiple distinct fingerprints, same command → FLAKY", () => {
  const inputs: FailureInput[] = [
    { command: "npm test", stderr: "Error A", exitCode: 1 },
    { command: "npm test", stderr: "Error B", exitCode: 2 },
    { command: "npm test", stderr: "Error C", exitCode: 1 },
  ];

  const result = classifyFailures(inputs);

  expect(result.classification).toBe("FLAKY");
  expect(result.distinctCount).toBeGreaterThanOrEqual(2);
});

test("two distinct fingerprints, same command → FLAKY", () => {
  const inputs: FailureInput[] = [
    { command: "npm test", stderr: "Error A", exitCode: 1 },
    { command: "npm test", stderr: "Error B", exitCode: 1 },
  ];

  const result = classifyFailures(inputs);

  expect(result.classification).toBe("FLAKY");
  expect(result.distinctCount).toBe(2);
});

// ── Classification: INDETERMINATE ───────────────────────────────────────────

test("three distinct fingerprints, different commands → INDETERMINATE", () => {
  const inputs: FailureInput[] = [
    { command: "npm test", stderr: "Error A", exitCode: 1 },
    { command: "yarn lint", stderr: "Error B", exitCode: 2 },
    { command: "pnpm build", stderr: "Error C", exitCode: 3 },
  ];

  const result = classifyFailures(inputs);

  expect(result.classification).toBe("INDETERMINATE");
  expect(result.distinctCount).toBe(3);
});

test("two distinct fingerprints, different commands → INDETERMINATE", () => {
  const inputs: FailureInput[] = [
    { command: "npm test", stderr: "Error A", exitCode: 1 },
    { command: "yarn lint", stderr: "Error B", exitCode: 1 },
  ];

  const result = classifyFailures(inputs);

  expect(result.classification).toBe("INDETERMINATE");
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test("single input → FAIL (trivially deterministic)", () => {
  const result = classifyFailures([
    { command: "test", stderr: "err", exitCode: 1 },
  ]);

  expect(result.classification).toBe("FAIL");
  expect(result.distinctCount).toBe(1);
});

test("empty input throws", () => {
  expect(() => classifyFailures([])).toThrow("at least one");
});

test("fingerprints array length matches inputs length", () => {
  const inputs: FailureInput[] = [
    { command: "a", stderr: "1", exitCode: 1 },
    { command: "b", stderr: "2", exitCode: 2 },
    { command: "c", stderr: "3", exitCode: 3 },
  ];

  const result = classifyFailures(inputs);
  expect(result.fingerprints.length).toBe(3);
});

// ── Task 6: output parsers ───────────────────────────────────────────────────

test("parseTscOutput extracts file, line, diagnostic per error", () => {
  const output = [
    "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
  ].join("\n");
  const parsed = parseTscOutput(output);
  expect(parsed).toHaveLength(2);
  expect(parsed[0].file).toBe("src/a.ts");
  expect(parsed[0].line).toBe(12);
  expect(parsed[0].diagnostic).toContain("TS2322");
  expect(parsed[0].id).toMatch(/^[a-f0-9]{64}$/);
  expect(parsed[0].id).toBe(parsed[0].hash);
});

test("parseTestOutput yields one fingerprint per failing test", () => {
  const output = [
    "FAIL src/a.test.ts > suite > test one",
    "FAIL src/b.test.ts > suite > test two",
    "FAIL src/c.test.ts > suite > test three",
  ].join("\n");
  const parsed = parseTestOutput(output);
  expect(parsed).toHaveLength(3);
  const ids = new Set(parsed.map((p) => p.id));
  expect(ids.size).toBe(3);
  for (const p of parsed) expect(p.id).toMatch(/^[a-f0-9]{64}$/);
});

test("parseEslintOutput extracts file and line", () => {
  const output = "src/a.ts:12:5:  error  Unexpected any  @typescript-eslint/no-explicit-any";
  const parsed = parseEslintOutput(output);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].file).toBe("src/a.ts");
  expect(parsed[0].line).toBe(12);
});

test("parseFailureFingerprints emits nothing for unparsed output (quarantined, excluded from ownership)", () => {
  const parsed = parseFailureFingerprints("test", "", "Error: something broke");
  expect(parsed).toHaveLength(0);
  const quarantined = quarantineUnparsedOutput("test", "", "Error: something broke");
  expect(quarantined.length).toBeGreaterThan(0);
  expect(quarantined[0].reason).toBe("unparsed-output");
});

test("hashParsedFailure is deterministic", () => {
  const a = hashParsedFailure({ checkId: "test", file: "f.ts", line: 1, diagnostic: "boom" });
  const b = hashParsedFailure({ checkId: "test", file: "f.ts", line: 1, diagnostic: "boom" });
  expect(a.id).toBe(b.id);
});
