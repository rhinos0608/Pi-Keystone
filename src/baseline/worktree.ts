// Worktree state capture — runs git commands to snapshot working tree.
// Returns BaselineWorktreeState from baseline/types.ts.

import { execSync } from "node:child_process";
import type { BaselineWorktreeState, DirtyPath, DirtyPathStatus } from "./types.js";

export type WorktreeState = BaselineWorktreeState;

/**
 * Capture current worktree state: branch, HEAD commit, dirty paths.
 * Runs three git commands synchronously — never mutates the repo.
 */
export function getWorktreeState(root: string): WorktreeState {
  const gitRoot = resolveGitRoot(root);
  const branch = gitOpt("branch --show-current", gitRoot) || undefined;
  const headCommit = git("rev-parse HEAD", gitRoot);
  const dirtyPaths = parsePorcelain(gitOpt("status --porcelain=v1 -z --untracked-files=all", gitRoot));

  return { gitRoot, branch, headCommit, dirtyPaths, contentHashBudget: 0 };
}

function resolveGitRoot(cwd: string): string {
  return git("rev-parse --show-toplevel", cwd);
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gitOpt(cmd: string, cwd: string): string {
  try { return git(cmd, cwd); } catch { return ""; }
}

/** Parse `git status --porcelain=v1 -z` into DirtyPath entries. */
function parsePorcelain(raw: string): DirtyPath[] {
  if (!raw) return [];
  const entries: DirtyPath[] = [];
  const parts = raw.split("\0").filter((p) => p.length > 0);

  for (const part of parts) {
    const code = part.substring(0, 2);
    const pathStart = part.indexOf(" ");
    if (pathStart < 0) continue;
    const filePath = part.substring(pathStart + 1);
    entries.push({ path: filePath, status: mapStatus(code) });
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
