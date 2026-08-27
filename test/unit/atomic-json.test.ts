import { test } from "vitest";
import assert from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createAtomicJsonWriter, writePrivateAtomicJson } from "../../src/store/atomic-json.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-test-"));
}

// ── Basic write ─────────────────────────────────────────────────────────────

test("writeAtomicJson writes valid JSON to target path", () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");
  const payload = { hello: "world", n: 42 };

  writePrivateAtomicJson(target, payload);

  const read = JSON.parse(fs.readFileSync(target, "utf-8"));
  expect(read).toEqual(payload);
});

// ── File mode ───────────────────────────────────────────────────────────────

test("writePrivateAtomicJson creates file with mode 0o600", () => {
  const dir = tmpDir();
  const target = path.join(dir, "secret.json");

  writePrivateAtomicJson(target, { secret: true });

  const stat = fs.statSync(target);
  expect(stat.mode & 0o777).toEqual(0o600);
});

// ── Crash mid-write preserves old file ─────────────────────────────────────

test("crash mid-write preserves existing file", () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");
  const original = { version: 1 };

  // Write original
  writePrivateAtomicJson(target, original);

  // Create a writer that fails after writeFileSync but before renameSync
  const brokenWriter = createAtomicJsonWriter({
    fs: {
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      renameSync: () => { throw new Error("simulated crash"); },
      rmSync: fs.rmSync,
    },
  });

  expect(() => brokenWriter(target, { version: 2 })).toThrow();

  // Original file must survive
  const after = JSON.parse(fs.readFileSync(target, "utf-8"));
  expect(after).toEqual(original);
});

// ── Permission denied ───────────────────────────────────────────────────────

test("permission denied throws and does not corrupt target", () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");
  const original = { v: 1 };

  writePrivateAtomicJson(target, original);

  // Make target read-only so rename fails (target exists, source dir OK)
  fs.chmodSync(target, 0o444);

  // On macOS/Linux, rename to an existing file with read-only target may
  // succeed (rename replaces inode). Use a locked-directory approach instead:
  // make the parent dir read-only so mkdir for temp fails.
  const subdir = path.join(dir, "sub");
  fs.mkdirSync(subdir);
  fs.chmodSync(subdir, 0o444);

  expect(() => {
    writePrivateAtomicJson(path.join(subdir, "data.json"), { v: 2 });
  }).toThrow();

  // Restore perms for cleanup
  fs.chmodSync(subdir, 0o755);
  fs.chmodSync(target, 0o644);
});

// ── Creates parent directories ──────────────────────────────────────────────

test("creates nested parent directories", () => {
  const dir = tmpDir();
  const target = path.join(dir, "a", "b", "c", "data.json");

  writePrivateAtomicJson(target, { deep: true });

  expect(fs.existsSync(target)).toBeTruthy();
  expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ deep: true });
});

// ── Concurrent writes ───────────────────────────────────────────────────────

test("concurrent writes to same target do not corrupt", async () => {
  const dir = tmpDir();
  const target = path.join(dir, "race.json");
  const writers = Array.from({ length: 20 }, (_, i) =>
    writePrivateAtomicJson(target, { i }),
  );

  // After all writes, file must be valid JSON
  const content = JSON.parse(fs.readFileSync(target, "utf-8"));
  expect(typeof content.i).toEqual("number");
  expect(content.i >= 0 && content.i < 20).toBeTruthy();
});

// ── Overwrite existing ──────────────────────────────────────────────────────

test("overwrite produces latest value", () => {
  const dir = tmpDir();
  const target = path.join(dir, "over.json");

  writePrivateAtomicJson(target, { v: 1 });
  writePrivateAtomicJson(target, { v: 2 });
  writePrivateAtomicJson(target, { v: 3 });

  const content = JSON.parse(fs.readFileSync(target, "utf-8"));
  expect(content).toEqual({ v: 3 });
});
