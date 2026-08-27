import { describe, it, beforeEach, afterEach } from "vitest";

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReceipt,
  readReceipts,
  receiptsForGoal,
} from "../../src/observability/receipts.js";
import { PhaseCounter } from "../../src/observability/counters.js";
import {
  redactString,
  redactObject,
  getRedactionPatterns,
} from "../../src/observability/redaction.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keystone-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── receipts ──────────────────────────────────────────────────────────────

describe("receipts", () => {
  it("appends and reads back a receipt", () => {
    const file = join(tmpDir, "receipts.jsonl");
    const r = appendReceipt(file, "g-1", "PREPARING", "SUCCESS", "baseline done");

    expect(r.goalId).toEqual("g-1");
    expect(r.phase).toEqual("PREPARING");
    expect(r.outcome).toEqual("SUCCESS");
    expect(r.detail).toEqual("baseline done");
    expect(r.id.startsWith("rcpt-")).toBeTruthy();
    expect(r.ts.length > 0).toBeTruthy();

    const all = readReceipts(file);
    expect(all.length).toEqual(1);
    expect(all[0].id).toEqual(r.id);
  });

  it("multiple appends accumulate in order", () => {
    const file = join(tmpDir, "r.jsonl");
    const r1 = appendReceipt(file, "g-1", "CREATED", "SUCCESS");
    const r2 = appendReceipt(file, "g-1", "PREPARING", "PENDING");
    const r3 = appendReceipt(file, "g-2", "EXECUTING", "FAILURE", "err");

    const all = readReceipts(file);
    expect(all.length).toEqual(3);
    expect(all[0].id).toEqual(r1.id);
    expect(all[1].id).toEqual(r2.id);
    expect(all[2].id).toEqual(r3.id);
  });

  it("receiptsForGoal filters correctly", () => {
    const file = join(tmpDir, "r.jsonl");
    appendReceipt(file, "g-1", "A", "SUCCESS");
    appendReceipt(file, "g-2", "B", "FAILURE");
    appendReceipt(file, "g-1", "C", "PENDING");

    const g1 = receiptsForGoal(file, "g-1");
    expect(g1.length).toEqual(2);
    expect(g1.every((r) => r.goalId === "g-1")).toBeTruthy();
  });

  it("readReceipts returns [] for missing file", () => {
    expect(readReceipts(join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("creates parent directories", () => {
    const file = join(tmpDir, "deep", "nested", "receipts.jsonl");
    appendReceipt(file, "g-1", "X", "SUCCESS");
    expect(existsSync(file)).toBeTruthy();
  });

  it("receipt without optional detail omits it", () => {
    const file = join(tmpDir, "r.jsonl");
    const r = appendReceipt(file, "g-1", "A", "SUCCESS");
    expect("detail" in r).toEqual(false);
    const raw = readFileSync(file, "utf-8");
    expect(!raw.includes("detail")).toBeTruthy();
  });

  it("detail is stored when provided", () => {
    const file = join(tmpDir, "r.jsonl");
    const r = appendReceipt(file, "g-1", "A", "SUCCESS", "info here");
    expect(r.detail).toEqual("info here");
  });
});

// ─── counters ──────────────────────────────────────────────────────────────

describe("counters", () => {
  it("tracks phase transitions", () => {
    const c = new PhaseCounter();
    c.enter("g-1", "CREATED");
    c.enter("g-1", "PREPARING");
    c.enter("g-1", "PREPARING");

    const snap = c.snapshot("g-1");
    expect(snap.length).toEqual(2);
    assert.deepEqual(snap.find((p) => p.phase === "CREATED"), {
      phase: "CREATED",
      count: 1,
    });
    assert.deepEqual(snap.find((p) => p.phase === "PREPARING"), {
      phase: "PREPARING",
      count: 2,
    });
  });

  it("separates counts by goalId", () => {
    const c = new PhaseCounter();
    c.enter("g-1", "A");
    c.enter("g-2", "A");
    c.enter("g-1", "A");

    expect(c.snapshot("g-1").length).toEqual(1);
    expect(c.snapshot("g-1")[0].count).toEqual(2);
    expect(c.snapshot("g-2")[0].count).toEqual(1);
  });

  it("totalCount sums all entries", () => {
    const c = new PhaseCounter();
    c.enter("g-1", "A");
    c.enter("g-1", "B");
    c.enter("g-2", "A");
    expect(c.totalCount()).toEqual(3);
  });

  it("clear resets all counters", () => {
    const c = new PhaseCounter();
    c.enter("g-1", "A");
    c.clear();
    expect(c.totalCount()).toEqual(0);
    expect(c.snapshot("g-1")).toEqual([]);
  });

  it("flush and load round-trip", () => {
    const file = join(tmpDir, "counters.jsonl");
    const c1 = new PhaseCounter();
    c1.enter("g-1", "PREPARING");
    c1.enter("g-1", "PREPARING");
    c1.enter("g-2", "EXECUTING");
    c1.flush(file);

    const c2 = new PhaseCounter();
    c2.load(file);
    expect(c2.snapshot("g-1")).toEqual([{ phase: "PREPARING", count: 2 }]);
    expect(c2.snapshot("g-2")).toEqual([{ phase: "EXECUTING", count: 1 }]);
  });

  it("load merges into existing counters", () => {
    const file = join(tmpDir, "counters.jsonl");
    const c1 = new PhaseCounter();
    c1.enter("g-1", "A");
    c1.flush(file);

    const c2 = new PhaseCounter();
    c2.enter("g-1", "A");
    c2.load(file);
    expect(c2.snapshot("g-1")[0].count).toEqual(2);
  });

  it("load handles missing file", () => {
    const c = new PhaseCounter();
    c.load(join(tmpDir, "nope.jsonl"));
    expect(c.totalCount()).toEqual(0);
  });

  it("snapshot returns sorted by phase name", () => {
    const c = new PhaseCounter();
    c.enter("g-1", "Z");
    c.enter("g-1", "A");
    c.enter("g-1", "M");
    const snap = c.snapshot("g-1");
    expect(snap[0].phase).toEqual("A");
    expect(snap[1].phase).toEqual("M");
    expect(snap[2].phase).toEqual("Z");
  });
});

// ─── redaction ─────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("redacts email addresses", () => {
    const input = "User alice@example.com submitted form";
    const result = redactString(input);
    expect(!result.includes("alice@example.com")).toBeTruthy();
    expect(result.includes("[REDACTED]")).toBeTruthy();
  });

  it("redacts API keys", () => {
    const input = "Using key sk-abc123def456ghi789jkl012mno";
    const result = redactString(input);
    expect(!result.includes("sk-")).toBeTruthy();
  });

  it("redacts secret assignments", () => {
    const input = "DB_PASSWORD=hunter2 and SECRET: mysecretvalue";
    const result = redactString(input);
    expect(!result.includes("hunter2")).toBeTruthy();
    expect(!result.includes("mysecretvalue")).toBeTruthy();
  });

  it("redacts AWS keys", () => {
    const input = "Key AKIAIOSFODNN7EXAMPLE";
    const result = redactString(input);
    expect(!result.includes("AKIAIOSFODNN7EXAMPLE")).toBeTruthy();
  });

  it("redacts SSN-like patterns", () => {
    const input = "SSN: 123-45-6789";
    const result = redactString(input);
    expect(!result.includes("123-45-6789")).toBeTruthy();
  });

  it("leaves clean text untouched", () => {
    const input = "Phase PREPARING entered at 2025-01-01T00:00:00Z";
    expect(redactString(input)).toEqual(input);
  });

  it("redactObject handles nested objects", () => {
    const input = {
      user: "alice@example.com",
      data: { token: "sk-abc123def456ghi789jkl012mno", value: 42 },
    };
    const result = redactObject(input);
    expect(!result.user.includes("alice")).toBeTruthy();
    expect(result.data.token).toEqual("[REDACTED]");
    expect(result.data.value).toEqual(42);
  });

  it("redactObject redacts secret-keyed string values", () => {
    const input = { api_key: "sk-abc123def456ghi789jkl012mno" };
    const result = redactObject(input);
    expect(result.api_key).toEqual("[REDACTED]");
  });

  it("redactObject handles arrays", () => {
    const input = ["alice@example.com", "clean text", "bob@test.org"];
    const result = redactObject(input);
    expect(!result[0].includes("alice")).toBeTruthy();
    expect(result[1]).toEqual("clean text");
    expect(!result[2].includes("bob")).toBeTruthy();
  });

  it("redactObject passes through null/undefined/primitives", () => {
    expect(redactObject(null)).toEqual(null);
    expect(redactObject(undefined)).toEqual(undefined);
    expect(redactObject(42)).toEqual(42);
    expect(redactObject(true)).toEqual(true);
  });

  it("getRedactionPatterns returns non-empty list", () => {
    const patterns = getRedactionPatterns();
    expect(patterns.length > 0).toBeTruthy();
    expect(patterns.every((p) => typeof p.label === "string" && p.re instanceof RegExp)).toBeTruthy();
  });
});
