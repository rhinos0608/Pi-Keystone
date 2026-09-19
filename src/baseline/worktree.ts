// Worktree state capture — runs git commands to snapshot working tree.
// Returns BaselineWorktreeState from baseline/types.ts.

import { execFileSync } from "node:child_process";
import type { BaselineWorktreeState, DirtyPath, DirtyPathStatus } from "./types.js";

export type WorktreeState = BaselineWorktreeState;

/**
 * Capture current worktree state: branch, HEAD commit, dirty paths.
 * Runs three git commands synchronously — never mutates the repo.
 */
export function getWorktreeState(root: string): WorktreeState {
  const gitRoot = resolveGitRoot(root);
  const branch = gitOpt(["branch", "--show-current"], gitRoot) || undefined;
  const headCommit = git(["rev-parse", "HEAD"], gitRoot);
  const dirtyPaths = parsePorcelain(
    gitOpt(["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitRoot),
  );

  return { gitRoot, branch, headCommit, dirtyPaths, contentHashBudget: 0 };
}

function resolveGitRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitOpt(args: string[], cwd: string): string {
  try { return git(args, cwd); } catch { return ""; }
}

/** Parse `git status --porcelain=v1 -z` into DirtyPath entries. */
export function parsePorcelain(raw: string): DirtyPath[] {
  if (!raw) return [];
  const entries: DirtyPath[] = [];
  const parts = raw.split("\0").filter((p) => p.length > 0);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // Porcelain v1 is a fixed-width two-character XY status followed by one
    // separator byte and then the path. Using indexOf(" ") is incorrect for
    // unstaged records such as " M file.ts" because the first status byte is
    // itself a space.
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    const filePath = part.slice(3);
    if (!filePath) continue;
    const status = mapStatus(code);
    entries.push({ path: filePath, status });

    // Under -z, rename/copy entries carry the original path as the following
    // NUL-delimited field (destination first, source second). Preserve both
    // sides in the dirty inventory so write-set collision checks cannot miss
    // the source side of an in-flight rename/copy.
    if ((code[0] === "R" || code[1] === "R" || code[0] === "C" || code[1] === "C") && i + 1 < parts.length) {
      const originalPath = parts[++i]!;
      if (originalPath) entries.push({ path: originalPath, status });
    }
  }

  return entries;
}

function mapStatus(code: string): DirtyPathStatus {
  const c = code.trim();
  if (c === "??") return "??";
  const x = c[0];
  const y = c[1];
  if (x === "A" || y === "A") return "A";
  if (x === "D" || y === "D") return "D";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  return "M";
}
