/// <reference types="node" />

/**
 * Directory-based locking for concurrent-worker safety.
 *
 * Pattern matches pi-subagents workflow-state.ts:
 * - mkdirSync creates lock dir (atomic on POSIX)
 * - owner.json with pid/token/createdAt/processKey
 * - Process-alive check via process.kill(pid, 0)
 * - Stale reclaim with secondary .reclaim directory
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 60_000;

const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

const RETRYABLE_FS_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  processKey?: string;
}

export interface AcquiredLock {
  /** Full path to the lock directory */
  lockPath: string;
  /** Owner identity written to owner.json */
  owner: LockOwner;
}

// ─── Process identity ───────────────────────────────────────────────────────

function linuxProcessStartKey(pid: number): string | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const tail = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return tail[19] ? `linux:${tail[19]}` : undefined;
  } catch {
    return undefined;
  }
}

function psProcessStartKey(pid: number): string | undefined {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return raw ? `ps:${raw}` : undefined;
  } catch {
    return undefined;
  }
}

function windowsProcessStartKey(pid: number): string | undefined {
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
      ],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
        windowsHide: true,
      },
    ).trim();
    return raw ? `win:${raw}` : undefined;
  } catch {
    return undefined;
  }
}

function processStartKey(pid: number): string | undefined {
  if (process.platform === "linux")
    return linuxProcessStartKey(pid) ?? psProcessStartKey(pid);
  if (process.platform === "win32") return windowsProcessStartKey(pid);
  return undefined;
}

const CURRENT_PROCESS_KEY = processStartKey(process.pid);

// ─── Process alive check ────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but we lack permission to signal it
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ─── Lock owner I/O ─────────────────────────────────────────────────────────

export function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"),
    ) as Record<string, unknown>;

    if (
      Number.isSafeInteger(raw.pid) &&
      (raw.pid as number) > 0 &&
      typeof raw.token === "string" &&
      raw.token &&
      Number.isSafeInteger(raw.createdAt)
    ) {
      return {
        pid: raw.pid as number,
        token: raw.token,
        createdAt: raw.createdAt as number,
        ...(typeof raw.processKey === "string" && raw.processKey
          ? { processKey: raw.processKey }
          : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ─── Staleness detection ────────────────────────────────────────────────────

export function lockIsStale(lockPath: string, now = Date.now()): boolean {
  const owner = readLockOwner(lockPath);
  if (owner) {
    // Dead process = stale
    if (!isProcessAlive(owner.pid)) return true;

    // PID reuse detection via process start key
    if (owner.processKey) {
      const currentKey =
        owner.pid === process.pid
          ? CURRENT_PROCESS_KEY
          : processStartKey(owner.pid);
      if (currentKey) return owner.processKey !== currentKey;

      // Same PID but current process key unknown; if owner was us and key
      // missing now, treat as stale (process restarted without start key).
      if (owner.pid === process.pid) return true;
    }
    return false;
  }

  // No owner.json — fall back to mtime age
  try {
    return now - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ─── Directory helpers ──────────────────────────────────────────────────────

function tryMakeDir(dirPath: string, mode: number): boolean {
  try {
    fs.mkdirSync(dirPath, { mode });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function staleDirExists(dirPath: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(dirPath).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRetryableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_FS_ERROR_CODES.has(code);
}

// ─── Reclaim ────────────────────────────────────────────────────────────────

export function reclaimStaleLock(lockPath: string, reclaimPath: string): boolean {
  if (!lockIsStale(lockPath)) return false;
  if (!tryMakeDir(reclaimPath, 0o700)) return false;
  try {
    // Double-check after acquiring reclaim dir
    if (!lockIsStale(lockPath)) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(reclaimPath, { recursive: true, force: true });
  }
}

// ─── Lock acquisition ───────────────────────────────────────────────────────

function waitForDelay(delayMs: number | undefined, lockPath: string): void {
  if (delayMs === undefined)
    throw new Error(`Timed out acquiring lock '${lockPath}'.`);
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    // busy-wait (matches pi-subagents portable fallback)
  }
}

export function acquireLock(lockBasePath: string): AcquiredLock {
  fs.mkdirSync(path.dirname(lockBasePath), { recursive: true });
  const lockPath = lockBasePath.endsWith(".lock")
    ? lockBasePath
    : `${lockBasePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;

  for (let attempt = 0; ; attempt++) {
    // If reclaim dir exists, someone else is reclaiming or it's stale
    if (fs.existsSync(reclaimPath)) {
      if (staleDirExists(reclaimPath)) {
        fs.rmSync(reclaimPath, { recursive: true, force: true });
        continue;
      }
      waitForDelay(RETRY_DELAYS_MS[attempt], lockPath);
      continue;
    }

    // Try to create lock dir (atomic mkdir)
    let acquired = false;
    try {
      acquired = tryMakeDir(lockPath, 0o700);
    } catch (error) {
      if (isRetryableFsError(error)) {
        waitForDelay(RETRY_DELAYS_MS[attempt], lockPath);
        continue;
      }
      throw new Error(
        `Failed to acquire lock '${lockPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!acquired) {
      // Lock exists — try reclaim if stale
      if (reclaimStaleLock(lockPath, reclaimPath)) continue;
      waitForDelay(RETRY_DELAYS_MS[attempt], lockPath);
      continue;
    }

    // Write owner.json
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
      ...(CURRENT_PROCESS_KEY ? { processKey: CURRENT_PROCESS_KEY } : {}),
    };

    try {
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify(owner),
        {
          encoding: "utf-8",
          mode: 0o600,
        },
      );
    } catch (error) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }

    return { lockPath, owner };
  }
}

// ─── Lock release ───────────────────────────────────────────────────────────

export function releaseLock(acquired: AcquiredLock): void {
  const current = readLockOwner(acquired.lockPath);
  if (current?.token !== acquired.owner.token) return;
  fs.rmSync(acquired.lockPath, { recursive: true, force: true });
}

// ─── High-level API ─────────────────────────────────────────────────────────

/**
 * Execute `operation` under an exclusive directory lock.
 *
 * @param lockBasePath - Base path for the lock (`.lock` suffix appended automatically)
 * @param operation - Function to execute while holding the lock
 * @returns Return value of `operation`
 */
export function withLock<T>(lockBasePath: string, operation: () => T): T {
  const acquired = acquireLock(lockBasePath);
  try {
    return operation();
  } finally {
    releaseLock(acquired);
  }
}
