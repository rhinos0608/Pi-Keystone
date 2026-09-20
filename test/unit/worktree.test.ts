import { describe, expect, it } from "vitest";
import { parsePorcelain } from "../../src/baseline/worktree.js";

describe("parsePorcelain", () => {
  it("parses unstaged modifications without including the Y status byte in the path", () => {
    const paths = parsePorcelain(" M src/file.ts\0");
    expect(paths).toEqual([{ path: "src/file.ts", status: "M" }]);
  });

  it("parses staged additions and untracked paths", () => {
    const paths = parsePorcelain("A  src/new.ts\0?? notes.txt\0");
    expect(paths).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "notes.txt", status: "??" },
    ]);
  });

  it("preserves both destination and source paths for NUL-delimited renames", () => {
    const paths = parsePorcelain("R  src/after.ts\0src/before.ts\0");
    expect(paths).toEqual([
      { path: "src/after.ts", status: "R" },
      { path: "src/before.ts", status: "D" },
    ]);
  });
});
