import { describe, it, expect } from "vitest";
import { createMockPiRuntime } from "../fixtures/pi-runtime.js";

describe("Mock Pi Runtime", () => {
  it("captures sendUserMessage calls", async () => {
    const runtime = createMockPiRuntime();
    await runtime.sendUserMessage("hello");
    await runtime.sendUserMessage("world");
    expect(runtime.sentMessages).toEqual(["hello", "world"]);
  });

  it("registers and stores command handlers", () => {
    const runtime = createMockPiRuntime();
    const handler = () => {};
    runtime.registerCommand("goal", { handler });
    expect(runtime.commands.has("goal")).toBe(true);
    expect(runtime.commands.get("goal")).toBe(handler);
  });

  it("captures context events", () => {
    const runtime = createMockPiRuntime();
    runtime.emitContextEvent({ type: "GoalStarted", payload: { id: "1" } });
    runtime.emitContextEvent({ type: "PreparationProgress", payload: { job: "baseline" } });
    expect(runtime.contextEvents).toHaveLength(2);
    expect(runtime.contextEvents[0].type).toBe("GoalStarted");
  });

  it("isolates instances", async () => {
    const r1 = createMockPiRuntime();
    const r2 = createMockPiRuntime();
    await r1.sendUserMessage("only-r1");
    expect(r1.sentMessages).toEqual(["only-r1"]);
    expect(r2.sentMessages).toEqual([]);
  });

  it("supports async command handlers via registerCommand", async () => {
    const runtime = createMockPiRuntime();
    const captured: string[] = [];
    runtime.registerCommand("test", {
      handler: async (args) => {
        captured.push(args);
      },
    });
    const handler = runtime.commands.get("test")!;
    await handler("arg1");
    expect(captured).toEqual(["arg1"]);
  });
});
