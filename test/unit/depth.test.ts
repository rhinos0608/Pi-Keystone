import { describe, expect, it } from "vitest";
import {
  applyHeuristicFloor,
  heuristicDepth,
  parseModelDepth,
  type DepthProposalInput,
} from "../../src/runtime/depth.js";
import { openGoalConfirmation } from "../../src/tui/goal-confirm.js";
import { openMutationConflictConfirmation } from "../../src/tui/mutation-confirm.js";

function input(task: string, opts: { assignments?: number; files?: number; criteria?: number } = {}): DepthProposalInput {
  const assignmentCount = opts.assignments ?? 1;
  const fileCount = opts.files ?? 1;
  const criteriaCount = opts.criteria ?? 1;
  return {
    task,
    plan: {
      planEpoch: 0,
      assignments: Array.from({ length: assignmentCount }, (_, i) => ({
        id: `a${i}`,
        role: "implementation" as const,
        description: `change ${i}`,
        targetFiles: Array.from({ length: fileCount }, (_, j) => `src/f${i}-${j}.ts`),
        criterionIds: ["c1"],
        acceptanceCriteria: ["works"],
      })),
    } as any,
    contract: {
      schemaVersion: 1,
      version: 1,
      goalId: "g",
      requirements: [],
      invariants: [],
      completionCriteria: Array.from({ length: criteriaCount }, (_, i) => ({
        id: `c${i + 1}`,
        text: `criterion ${i + 1}`,
        provenance: "derived" as const,
        strength: "soft" as const,
      })),
      assumptions: [],
    } as any,
    baseline: {
      revision: "r",
      dirtySignature: "d",
      worktree: { staged: [], modified: [], untracked: [] },
      checks: {
        typecheck: { checkId: "typecheck", status: "PASS", command: "tsc", exitCode: 0, durationMs: 1, version: null, retried: false },
      },
      failureFingerprints: [],
      contentHashes: {},
      capturedAt: new Date(0).toISOString(),
    },
  };
}
describe("adaptive lifecycle depth", () => {
  it("keeps a small bounded goal on quick", () => {
    expect(heuristicDepth(input("rename a label")).depth).toBe("quick");
  });

  it("raises sensitive work to full", () => {
    const proposal = heuristicDepth(input("perform a database migration with recovery"));
    expect(proposal.depth).toBe("full");
    expect(proposal.signals).toContain("high-risk domain signal");
  });

  it("never lets a model recommendation undercut the heuristic floor", () => {
    const heuristic = heuristicDepth(input("change authentication permissions"));
    const model = parseModelDepth('{"depth":"quick","rationale":"tiny","signals":[]}', heuristic);
    expect(applyHeuristicFloor(model, heuristic).depth).toBe("full");
  });

  it("accepts a valid model standard recommendation for a small goal", () => {
    const fallback = heuristicDepth(input("rename a label"));
    const model = parseModelDepth('{"depth":"standard","rationale":"review useful","signals":["shared UI"]}', fallback);
    expect(model.depth).toBe("standard");
    expect(model.source).toBe("model");
  });
});
describe("goal confirmation TUI", () => {
  const proposal = heuristicDepth(input("rename a label"));
  const confirmationInput = {
    goalId: "g1",
    task: "rename a label",
    plan: input("rename a label").plan,
    proposal,
    baselineSummary: "typecheck:PASS",
  };

  it("lets the user override depth before release", async () => {
    const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        custom: async (factory: any) => await new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          component.handleInput("2");
          component.handleInput("\r");
        }),
      },
    } as any;
    await expect(openGoalConfirmation(ctx, confirmationInput)).resolves.toEqual({ depth: "standard" });
  });

  it("uses an explicit RPC select fallback when custom TUI is unavailable", async () => {
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => options[2],
      },
    } as any;
    await expect(openGoalConfirmation(ctx, confirmationInput)).resolves.toEqual({ depth: "full" });
  });

  it("fails closed when no interactive UI exists", async () => {
    const ctx = { mode: "json", hasUI: false, ui: {} } as any;
    await expect(openGoalConfirmation(ctx, confirmationInput)).resolves.toBeNull();
  });
});

describe("mutation conflict confirmation", () => {
  it("uses explicit RPC confirm rather than auto-denying", async () => {
    let seen = "";
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          seen = message;
          return true;
        },
      },
    } as any;
    await expect(openMutationConflictConfirmation(ctx, {
      goalId: "g1",
      assignmentId: "a1",
      description: "repair target",
      conflicts: [{ kind: "modified", path: "src/file.ts" }],
      writeSet: ["src/file.ts"],
    })).resolves.toBe(true);
    expect(seen).toContain("src/file.ts");
  });
});
