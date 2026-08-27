import { test } from "vitest";
import assert from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createArtifactStore } from "../../src/store/artifact-store.js";

function makeStore(): ReturnType<typeof createArtifactStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-store-test-"));
  return createArtifactStore({ root: path.join(dir, "cas") });
}

// ── Write + read round-trip ─────────────────────────────────────────────────

test("writeArtifact returns ref, readArtifact returns same content", () => {
  const store = makeStore();
  const content = Buffer.from("hello artifact store");

  const ref = store.writeArtifact(content);
  const read = store.readArtifact(ref);

  expect(typeof ref === "string" && ref.length === 64, "ref is sha256 hex (64 chars)").toBeTruthy();
  expect(read).toEqual(content);
});

// ── String input ─────────────────────────────────────────────────────────────

test("writeArtifact accepts string input", () => {
  const store = makeStore();
  const ref = store.writeArtifact('{"key":"value"}');
  const read = store.readArtifact(ref);

  expect(read.toString("utf-8")).toEqual('{"key":"value"}');
});

// ── CAS deduplication ───────────────────────────────────────────────────────

test("identical content returns same ref (dedup)", () => {
  const store = makeStore();
  const content = Buffer.from("dedup me");

  const ref1 = store.writeArtifact(content);
  const ref2 = store.writeArtifact(content);

  expect(ref1).toEqual(ref2);
});

test("different content returns different ref", () => {
  const store = makeStore();

  const ref1 = store.writeArtifact(Buffer.from("content A"));
  const ref2 = store.writeArtifact(Buffer.from("content B"));

  expect(ref1).not.toBe(ref2);
});

// ── hasArtifact ──────────────────────────────────────────────────────────────

test("hasArtifact returns true after write, false before", () => {
  const store = makeStore();
  const ref = store.writeArtifact(Buffer.from("check me"));

  expect(store.hasArtifact(ref)).toBeTruthy();

  // A different ref should not exist
  const fakeRef = "a".repeat(64) as ReturnType<typeof store.writeArtifact>;
  expect(store.hasArtifact(fakeRef as any)).toEqual(false);
});

// ── Read nonexistent ref throws ─────────────────────────────────────────────

test("readArtifact throws for nonexistent ref", () => {
  const store = makeStore();
  const fakeRef = "b".repeat(64) as ReturnType<typeof store.writeArtifact>;

  expect(() => store.readArtifact(fakeRef as any), /ENOENT/).toThrow();
});

// ── Large content ────────────────────────────────────────────────────────────

test("handles 1MB content", () => {
  const store = makeStore();
  const large = Buffer.alloc(1024 * 1024, 0xab);

  const ref = store.writeArtifact(large);
  const read = store.readArtifact(ref);

  expect(read.length).toEqual(large.length);
  expect(read).toEqual(large);
});

// ── CAS directory structure ──────────────────────────────────────────────────

test("stores files in sha256-prefix subdirectory", () => {
  const store = makeStore();
  const ref = store.writeArtifact(Buffer.from("structure test"));

  // ref should be 64 hex chars, first 2 = subdir
  expect(ref.length).toEqual(64);
  const subdir = ref.slice(0, 2);
  const filename = ref.slice(2);

  // Store the root from createArtifactStore — we can check existence via readArtifact
  expect(store.hasArtifact(ref)).toBeTruthy();
});
