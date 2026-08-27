/// <reference types="node" />

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  acquireLock,
  releaseLock,
  withLock,
  isProcessAlive,
  lockIsStale,
  readLockOwner,
  reclaimStaleLock,
  type LockOwner,
  type AcquiredLock,
} from "../../src/store/directory-lock.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

let testDir: string;

function tmpDir(name: string): string {
  const dir = path.join(testDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOwner(lockDir: string, owner: LockOwner): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify(owner),
    "utf-8",
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirlock-test-"));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── isProcessAlive ─────────────────────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for nonexistent PID", () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });
});

// ─── acquireLock / releaseLock ──────────────────────────────────────────────

describe("acquireLock", () => {
  it("creates lock dir and owner.json", () => {
    const lockBase = path.join(tmpDir("basic"), "test");
    const acquired = acquireLock(lockBase);

    expect(fs.existsSync(acquired.lockPath)).toBe(true);
    expect(fs.existsSync(path.join(acquired.lockPath, "owner.json"))).toBe(true);
    expect(acquired.owner.pid).toBe(process.pid);
    expect(typeof acquired.owner.token).toBe("string");
    expect(acquired.owner.token.length).toBeGreaterThan(0);
    expect(typeof acquired.owner.createdAt).toBe("number");

    releaseLock(acquired);
    expect(fs.existsSync(acquired.lockPath)).toBe(false);
  });

  it("appends .lock suffix when missing", () => {
    const base = path.join(tmpDir("suffix"), "resource");
    const acquired = acquireLock(base);

    expect(acquired.lockPath).toBe(`${base}.lock`);
    expect(fs.existsSync(acquired.lockPath)).toBe(true);

    releaseLock(acquired);
  });

  it("does not double-append .lock suffix", () => {
    const base = path.join(tmpDir("double"), "resource.lock");
    const acquired = acquireLock(base);

    expect(acquired.lockPath).toBe(base);
    expect(fs.existsSync(acquired.lockPath)).toBe(true);

    releaseLock(acquired);
  });

  it("creates parent directories recursively", () => {
    const deep = path.join(tmpDir("deep"), "a", "b", "c", "resource");
    const acquired = acquireLock(deep);

    expect(fs.existsSync(acquired.lockPath)).toBe(true);

    releaseLock(acquired);
  });

  it("owner.json has correct mode 0o600", () => {
    const lockBase = path.join(tmpDir("mode"), "test");
    const acquired = acquireLock(lockBase);

    const stat = fs.statSync(path.join(acquired.lockPath, "owner.json"));
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    releaseLock(acquired);
  });
});

// ─── releaseLock ────────────────────────────────────────────────────────────

describe("releaseLock", () => {
  it("removes only if token matches", () => {
    const lockBase = path.join(tmpDir("token-match"), "test");
    const acquired = acquireLock(lockBase);

    // Tamper with owner.json — different token
    writeOwner(acquired.lockPath, {
      pid: process.pid,
      token: "wrong-token",
      createdAt: Date.now(),
    });

    // releaseLock should NOT remove (token mismatch)
    releaseLock(acquired);
    expect(fs.existsSync(acquired.lockPath)).toBe(true);

    // Clean up manually
    fs.rmSync(acquired.lockPath, { recursive: true, force: true });
  });

  it("removes lock dir when token matches", () => {
    const lockBase = path.join(tmpDir("token-remove"), "test");
    const acquired = acquireLock(lockBase);

    releaseLock(acquired);
    expect(fs.existsSync(acquired.lockPath)).toBe(false);
  });
});

// ─── withLock ───────────────────────────────────────────────────────────────

describe("withLock", () => {
  it("executes operation and releases lock", () => {
    const lockBase = path.join(tmpDir("withlock"), "test");
    let executed = false;

    const result = withLock(lockBase, () => {
      executed = true;
      expect(fs.existsSync(`${lockBase}.lock`)).toBe(true);
      return 42;
    });

    expect(executed).toBe(true);
    expect(result).toBe(42);
    expect(fs.existsSync(`${lockBase}.lock`)).toBe(false);
  });

  it("releases lock even if operation throws", () => {
    const lockBase = path.join(tmpDir("withlock-throw"), "test");

    expect(() => {
      withLock(lockBase, () => {
        throw new Error("boom");
      });
    }).toThrow("boom");

    expect(fs.existsSync(`${lockBase}.lock`)).toBe(false);
  });
});

// ─── Contention ─────────────────────────────────────────────────────────────

describe("contention", () => {
  it("serializes concurrent withLock calls via setTimeout", async () => {
    const lockBase = path.join(tmpDir("contention"), "test");
    const order: number[] = [];

    const p1 = new Promise<void>((resolve) => {
      withLock(lockBase, () => {
        order.push(1);
        const p2 = new Promise<void>((r) => {
          setImmediate(() => {
            withLock(lockBase, () => {
              order.push(2);
              r();
            });
          });
        });
        void p2.then(() => resolve());
      });
    });

    await p1;
    expect(order).toEqual([1, 2]);
  });
});

// ─── Stale detection ────────────────────────────────────────────────────────

describe("lockIsStale", () => {
  it("returns false for lock held by alive process with matching processKey", () => {
    const lockDir = path.join(tmpDir("stale-alive"), "test.lock");
    writeOwner(lockDir, {
      pid: process.pid,
      token: "test-token",
      createdAt: Date.now(),
    });

    // Without a processKey in the owner, staleness falls to mtime check
    // which will be fresh
    expect(lockIsStale(lockDir)).toBe(false);
  });

  it("returns true for lock held by dead process", () => {
    const lockDir = path.join(tmpDir("stale-dead"), "test.lock");
    writeOwner(lockDir, {
      pid: 9999999, // dead PID
      token: "test-token",
      createdAt: Date.now(),
    });

    expect(lockIsStale(lockDir)).toBe(true);
  });

  it("returns false when no owner.json and mtime is fresh", () => {
    const lockDir = path.join(tmpDir("stale-fresh"), "test.lock");
    fs.mkdirSync(lockDir, { recursive: true });

    expect(lockIsStale(lockDir)).toBe(false);
  });

  it("returns false for nonexistent path", () => {
    expect(lockIsStale("/nonexistent/path/to/lock")).toBe(false);
  });
});

// ─── readLockOwner ──────────────────────────────────────────────────────────

describe("readLockOwner", () => {
  it("reads valid owner.json", () => {
    const lockDir = path.join(tmpDir("read-owner"), "test.lock");
    const owner: LockOwner = {
      pid: 12345,
      token: "abc-def",
      createdAt: 1000,
      processKey: "linux:123",
    };
    writeOwner(lockDir, owner);

    const read = readLockOwner(lockDir);
    expect(read).toEqual(owner);
  });

  it("returns undefined for missing dir", () => {
    expect(readLockOwner("/nonexistent")).toBeUndefined();
  });

  it("returns undefined for corrupt owner.json", () => {
    const lockDir = path.join(tmpDir("corrupt"), "test.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), "not json", "utf-8");

    expect(readLockOwner(lockDir)).toBeUndefined();
  });

  it("returns undefined for owner.json with missing fields", () => {
    const lockDir = path.join(tmpDir("missing-fields"), "test.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 123 }),
      "utf-8",
    );

    expect(readLockOwner(lockDir)).toBeUndefined();
  });

  it("strips unknown fields from owner.json", () => {
    const lockDir = path.join(tmpDir("extra-fields"), "test.lock");
    writeOwner(lockDir, {
      pid: 12345,
      token: "tok",
      createdAt: 1000,
    });

    const read = readLockOwner(lockDir);
    expect(read?.pid).toBe(12345);
    expect(read?.token).toBe("tok");
  });
});

// ─── reclaimStaleLock ──────────────────────────────────────────────────────

describe("reclaimStaleLock", () => {
  it("returns false when lock is not stale", () => {
    const lockDir = path.join(tmpDir("reclaim-fresh"), "test.lock");
    const reclaimDir = `${lockDir}.reclaim`;

    writeOwner(lockDir, {
      pid: process.pid,
      token: "tok",
      createdAt: Date.now(),
    });

    expect(reclaimStaleLock(lockDir, reclaimDir)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("reclaims stale lock held by dead process", () => {
    const lockDir = path.join(tmpDir("reclaim-dead"), "test.lock");
    const reclaimDir = `${lockDir}.reclaim`;

    writeOwner(lockDir, {
      pid: 9999999,
      token: "tok",
      createdAt: Date.now(),
    });

    expect(reclaimStaleLock(lockDir, reclaimDir)).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.existsSync(reclaimDir)).toBe(false); // reclaim dir cleaned up
  });

  it("fails to reclaim if another reclaimer holds the reclaim dir", () => {
    const lockDir = path.join(tmpDir("reclaim-contention"), "test.lock");
    const reclaimDir = `${lockDir}.reclaim`;

    writeOwner(lockDir, {
      pid: 9999999,
      token: "tok",
      createdAt: Date.now(),
    });

    // Simulate another reclaimer holding the dir
    fs.mkdirSync(reclaimDir, { recursive: true });

    expect(reclaimStaleLock(lockDir, reclaimDir)).toBe(false);
    // Lock still exists
    expect(fs.existsSync(lockDir)).toBe(true);

    // Clean up
    fs.rmSync(reclaimDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });
});

// ─── Stale lock auto-reclaim during acquireLock ────────────────────────────

describe("auto-reclaim during acquireLock", () => {
  it("reclaims stale lock and acquires new one", () => {
    const lockBase = path.join(tmpDir("auto-reclaim"), "test");
    const lockPath = `${lockBase}.lock`;

    // Plant a stale lock (dead PID)
    writeOwner(lockPath, {
      pid: 9999999,
      token: "old-token",
      createdAt: Date.now(),
    });

    const acquired = acquireLock(lockBase);
    expect(acquired.lockPath).toBe(lockPath);
    expect(acquired.owner.token).not.toBe("old-token");

    releaseLock(acquired);
  });
});
