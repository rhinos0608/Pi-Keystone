import { describe, it } from "vitest";
import assert from "vitest";
import { parseGoalCommand, createGoalHandler } from "../../src/runtime/commands.ts";
import type { PiAgent } from "../../src/runtime/commands.ts";

// ─── parseGoalCommand ─────────────────────────────────────────────────────

describe("parseGoalCommand", () => {
  it("parses /goal with task text", () => {
    const r = parseGoalCommand("/goal implement feature X");
    expect(r).toEqual({ task: "implement feature X" });
  });

  it("trims whitespace around task", () => {
    const r = parseGoalCommand("/goal   implement feature X   ");
    expect(r).toEqual({ task: "implement feature X" });
  });

  it("handles multi-line task text", () => {
    const r = parseGoalCommand("/goal implement feature X\nwith tests");
    expect(r).toEqual({ task: "implement feature X\nwith tests" });
  });

  it("returns null for bare /goal with no task", () => {
    expect(parseGoalCommand("/goal")).toEqual(null);
  });

  it("returns null for /goal followed by only whitespace", () => {
    expect(parseGoalCommand("/goal   ")).toEqual(null);
  });

  it("returns null for plain text without /goal prefix", () => {
    expect(parseGoalCommand("implement feature X")).toEqual(null);
  });

  it("returns null for unrelated input", () => {
    expect(parseGoalCommand("hello world")).toEqual(null);
  });

  it("returns null for empty string", () => {
    expect(parseGoalCommand("")).toEqual(null);
  });

  it("returns null for /goals (no space before task)", () => {
    expect(parseGoalCommand("/goalsomething")).toEqual(null);
  });

  it("returns null for whitespace-only input", () => {
    expect(parseGoalCommand("   ")).toEqual(null);
  });
});

// ─── createGoalHandler ────────────────────────────────────────────────────

describe("createGoalHandler", () => {
  it("calls sendUserMessage with the parsed task", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    // Pi strips "/goal" prefix; handler receives "implement feature X"
    await handler("implement feature X");

    expect(sent).toEqual(["implement feature X"]);
  });

  it("returns silently for empty args", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    await handler("");

    expect(sent.length).toEqual(0);
  });

  it("returns silently for whitespace-only args", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: (msg) => { sent.push(msg); },
    };
    const handler = createGoalHandler(pi);

    await handler("   ");

    expect(sent.length).toEqual(0);
  });

  it("handles sendUserMessage returning a Promise", async () => {
    const sent: string[] = [];
    const pi: PiAgent = {
      sendUserMessage: async (msg) => { sent.push(msg); },
    };
    await createGoalHandler(pi)("deploy to staging");

    expect(sent).toEqual(["deploy to staging"]);
  });

  it("propagates sendUserMessage rejection", async () => {
    const pi: PiAgent = {
      sendUserMessage: () => { throw new Error("pi down"); },
    };

    await expect(
      () => createGoalHandler(pi)("fix bug"),
      { message: "pi down" },
    );
  });
});
