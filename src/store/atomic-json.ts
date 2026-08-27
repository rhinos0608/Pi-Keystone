// Atomic JSON writes — temp + rename pattern (pi-subagents §shared/atomic-json)
// Crash mid-write never corrupts the target; old file survives.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

type FsImpl = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;

type AtomicJsonOptions = {
  fs?: FsImpl;
  mode?: number;
};

function tempPath(target: string): string {
  const base = `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`;
  return path.join(path.dirname(target), base);
}

export function createAtomicJsonWriter(opts: AtomicJsonOptions = {}): (filePath: string, data: object) => void {
  const fsImpl = opts.fs ?? fs;
  const mode = opts.mode;

  return (filePath: string, data: object): void => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = tempPath(filePath);
    let writeError: unknown;
    try {
      const content = JSON.stringify(data, null, 2);
      fsImpl.writeFileSync(tmp, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
      fsImpl.renameSync(tmp, filePath);
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch (cleanupError) {
        // Cleanup is best-effort — never hide the write/rename failure.
        if (writeError === undefined) throw cleanupError;
      }
    }
  };
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
