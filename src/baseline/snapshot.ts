// Workspace snapshot (S0/S1) — git status capture + dirty signature.
//
// Capture uses `git status --porcelain=v2` and `git rev-parse HEAD` via
// execFile (no shell string). Never mutates the repo.
//
// dirtySignature = sha256 over normalized sorted status entries plus the
// sha256 content hash of each listed path (files read via fs; missing or
// unreadable paths hash as the literal marker "missing").

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export type DirtyKind = "staged" | "modified" | "untracked";

export type DirtyConflict = {
  path: string;
  kind: DirtyKind;
};

export type WorkspaceSnapshot = {
  /** HEAD commit, or null outside a git repo / before the first commit. */
  revision: string | null;
  staged: string[];
  modified: string[];
  untracked: string[];
  dirtySignature: string;
  contentHashes: Record<string, string>;
};

export type SnapshotDiff = {
  changedPaths: string[];
  dirtyConflicts: DirtyConflict[];
};

export type ConflictMatrix = {
  conflicts: DirtyConflict[];
  /** True when no dirt intersects the intended write-set (proceed without approval). */
  proceeds: boolean;
};

// ─── Capture ────────────────────────────────────────────────────────────────

async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const head = stdout.trim();
    return /^[0-9a-f]{4,40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

async function gitStatusV2(root: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v2", "--untracked-files=all"],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

type StatusBuckets = { staged: Set<string>; modified: Set<string>; untracked: Set<string> };

/**
 * Keystone reserves the workspace-root .keystone control namespace for its
 * durable store and mutation-authority bookkeeping. These files are controller
 * state, not user worktree dirt, and must never invalidate S0/S1/Sn freshness.
 *
 * Reserved:
 *   .keystone/...
 *   .keystone-... (lease, fence counter, lock/reclaim/tmp files)
 *
 * Nested source paths such as src/.keystone-helper.ts are ordinary user files.
 */
export function isKeystoneControlPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === ".keystone"
    || normalized.startsWith(".keystone/")
    || normalized.startsWith(".keystone-");
}

function withoutKeystoneControlPaths(buckets: StatusBuckets): StatusBuckets {
  const keep = (values: Set<string>): Set<string> =>
    new Set([...values].filter((value) => !isKeystoneControlPath(value)));
  return {
    staged: keep(buckets.staged),
    modified: keep(buckets.modified),
    untracked: keep(buckets.untracked),
  };
}

/** Parse porcelain v2 lines. Ordinal `1`/`2` entries split XY status; `u` = unmerged; `?` = untracked. */
export function parseStatusV2(raw: string): StatusBuckets {
  const staged = new Set<string>();
  const modified = new Set<string>();
  const untracked = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const tag = line[0];
    if (tag === "?") {
      const p = line.slice(2).trim();
      if (p) untracked.add(p);
      continue;
    }
    if (tag === "1" || tag === "2" || tag === "u") {
      // Porcelain-v2 record layouts have different path offsets:
      //   1 ... <hI> <path>
      //   2 ... <hI> <Xscore> <path> TAB <origPath>
      //   u ... <h3> <path>
      // Paths themselves may contain spaces, so split only to locate the
      // fixed-width header and then join the remaining fields back together.
      const fields = line.split(" ");
      const xy = fields[1] ?? "";
      const pathFieldStart = tag === "1" ? 8 : tag === "2" ? 9 : 10;
      if (fields.length <= pathFieldStart) continue;
      const rest = fields.slice(pathFieldStart).join(" ");
      const paths = tag === "2" ? rest.split("\t") : [rest];
      if (tag === "u") {
        for (const p of paths) {
          const name = p.trim();
          if (!name) continue;
          staged.add(name);
          modified.add(name);
        }
        continue;
      }
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      for (const p of paths) {
        const name = p.trim();
        if (!name) continue;
        if (x !== "." && x !== "?") staged.add(name);
        if (y !== "." && y !== "?") modified.add(name);
      }
    }
  }

  return { staged, modified, untracked };
}

const OVERSIZED_FILE_BYTES = 4 * 1024 * 1024;

function hashContent(root: string, relPath: string): string {
  try {
    const abs = path.join(root, relPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return "missing";
    if (stat.size > OVERSIZED_FILE_BYTES) {
      return `oversized:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    }
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "missing";
  }
}

export function computeDirtySignature(
  root: string,
  buckets: StatusBuckets,
): { signature: string; contentHashes: Record<string, string> } {
  const entries: string[] = [];
  const contentHashes: Record<string, string> = {};
  const record = (kind: DirtyKind, p: string): void => {
    const hash = hashContent(root, p);
    contentHashes[`${kind}:${p}`] = hash;
    entries.push(`${kind} ${p} ${hash}`);
  };
  for (const p of [...buckets.staged].sort()) record("staged", p);
  for (const p of [...buckets.modified].sort()) record("modified", p);
  for (const p of [...buckets.untracked].sort()) record("untracked", p);
  const signature = createHash("sha256").update(entries.join("\n")).digest("hex");
  return { signature, contentHashes };
}

export async function captureSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const [revision, status] = await Promise.all([gitHead(root), gitStatusV2(root)]);
  const buckets = withoutKeystoneControlPaths(parseStatusV2(status));
  const { signature, contentHashes } = computeDirtySignature(root, buckets);
  return {
    revision,
    staged: [...buckets.staged].sort(),
    modified: [...buckets.modified].sort(),
    untracked: [...buckets.untracked].sort(),
    dirtySignature: signature,
    contentHashes,
  };
}

// ─── Diff + conflict matrix ─────────────────────────────────────────────────

function normalizeWriteEntry(entry: string, workspaceRoot?: string): string {
  let p = entry.replace(/\\/g, "/");
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === root) p = "";
    else if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  if (p.startsWith("./")) p = p.slice(2);
  return path.posix.normalize(p);
}

/**
 * Conflict matrix: dirt (staged distinct from modified/untracked) that
 * intersects the intended write-set. Staged hits are reported with
 * kind "staged" so callers can demand stronger approval for them.
 */
export function conflictMatrix(
  current: WorkspaceSnapshot,
  intendedWriteSet: string[],
  workspaceRoot?: string,
): ConflictMatrix {
  const intended = new Set(intendedWriteSet.map((entry) => normalizeWriteEntry(entry, workspaceRoot)));
  const conflicts: DirtyConflict[] = [];
  const push = (kind: DirtyKind, p: string): void => {
    if (intended.has(normalizeWriteEntry(p, workspaceRoot))) conflicts.push({ path: p, kind });
  };
  // Staged first: one entry per path, staged winning over modified/untracked.
  const seen = new Set<string>();
  for (const p of current.staged) {
    if (intended.has(normalizeWriteEntry(p, workspaceRoot))) {
      conflicts.push({ path: p, kind: "staged" });
      seen.add(p);
    }
  }
  for (const p of current.modified) {
    if (!seen.has(p)) push("modified", p);
  }
  for (const p of current.untracked) {
    if (!seen.has(p)) push("untracked", p);
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return { conflicts, proceeds: conflicts.length === 0 };
}

function pathSetOf(snapshot: WorkspaceSnapshot): Set<string> {
  return new Set([...snapshot.staged, ...snapshot.modified, ...snapshot.untracked]);
}

/** Diff two snapshots: changed paths plus dirt in `b` intersecting what changed. */
export function diffSnapshots(a: WorkspaceSnapshot, b: WorkspaceSnapshot): SnapshotDiff {
  const pathsA = pathSetOf(a);
  const pathsB = pathSetOf(b);
  const changed = new Set<string>();
  for (const p of pathsB) {
    const keyB = (k: DirtyKind): string | undefined => b.contentHashes[`${k}:${p}`];
    const keyA = (k: DirtyKind): string | undefined => a.contentHashes[`${k}:${p}`];
    if (
      !pathsA.has(p) ||
      keyA("staged") !== keyB("staged") ||
      keyA("modified") !== keyB("modified") ||
      keyA("untracked") !== keyB("untracked")
    ) {
      changed.add(p);
    }
  }
  for (const p of pathsA) {
    if (!pathsB.has(p)) changed.add(p);
  }
  const changedPaths = [...changed].sort();
  const { conflicts } = conflictMatrix(b, changedPaths);
  return { changedPaths, dirtyConflicts: conflicts };
}
