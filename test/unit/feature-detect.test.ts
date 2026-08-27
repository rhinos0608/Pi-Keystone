import { describe, it, beforeEach } from "vitest";
import assert from "vitest";
import { detectPiCapabilities, type PiCapabilities } from "../../src/runtime/feature-detect.ts";

// All capabilities start false when no runtime present.
describe("detectPiCapabilities", () => {
  let savedPi: unknown;
  let savedPiCapital: unknown;

  beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    savedPi = g.pi;
    savedPiCapital = g.Pi;
    delete g.pi;
    delete g.Pi;
  });

  it("returns all false when no Pi runtime exists", () => {
    const caps = detectPiCapabilities();
    expect(caps, {
      sendUserMessage: false,
      registerCommand: false,
      contextEvent: false,
      sessionBeforeCompact: false,
      toolCallIntercept: false,
      newSession: false,
    } satisfies PiCapabilities);
  });

  it("detects methods on globalThis.pi", () => {
    (globalThis as unknown as Record<string, unknown>).pi = {
      sendUserMessage() {},
      registerCommand() {},
    };
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(true);
    expect(caps.registerCommand).toEqual(true);
    expect(caps.contextEvent).toEqual(false);
    expect(caps.sessionBeforeCompact).toEqual(false);
    expect(caps.toolCallIntercept).toEqual(false);
    expect(caps.newSession).toEqual(false);
  });

  it("detects methods on globalThis.Pi", () => {
    (globalThis as unknown as Record<string, unknown>).Pi = {
      contextEvent() {},
      toolCallIntercept() {},
      newSession() {},
    };
    const caps = detectPiCapabilities();
    expect(caps.contextEvent).toEqual(true);
    expect(caps.toolCallIntercept).toEqual(true);
    expect(caps.newSession).toEqual(true);
    expect(caps.sendUserMessage).toEqual(false);
  });

  it("detects all six capabilities", () => {
    (globalThis as unknown as Record<string, unknown>).pi = {
      sendUserMessage() {},
      registerCommand() {},
      contextEvent() {},
      sessionBeforeCompact() {},
      toolCallIntercept() {},
      newSession() {},
    };
    const caps = detectPiCapabilities();
    const allTrue = Object.values(caps).every((v) => v === true);
    expect(allTrue).toEqual(true);
  });

  it("handles pi being a non-object gracefully", () => {
    (globalThis as unknown as Record<string, unknown>).pi = "not-an-object";
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(false);
  });

  it("handles pi property throwing on access", () => {
    Object.defineProperty(globalThis, "pi", {
      get() {
        throw new Error("access denied");
      },
      configurable: true,
    });
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(false);
    delete (globalThis as unknown as Record<string, unknown>).pi;
  });

  it("prioritizes globalThis.pi over globalThis.Pi", () => {
    (globalThis as unknown as Record<string, unknown>).pi = { sendUserMessage() {} };
    (globalThis as unknown as Record<string, unknown>).Pi = { contextEvent() {} };
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(true);
    expect(caps.contextEvent).toEqual(false);
  });

  it("handles runtime with partial methods (not all six)", () => {
    (globalThis as unknown as Record<string, unknown>).pi = {
      sendUserMessage() {},
      registerCommand() {},
      contextEvent() {},
    };
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(true);
    expect(caps.registerCommand).toEqual(true);
    expect(caps.contextEvent).toEqual(true);
    expect(caps.sessionBeforeCompact).toEqual(false);
    expect(caps.toolCallIntercept).toEqual(false);
    expect(caps.newSession).toEqual(false);
  });

  it("handles Object.create(null) as runtime (no prototype methods)", () => {
    const runtime = Object.create(null);
    (runtime as Record<string, unknown>).sendUserMessage = function () {};
    (globalThis as unknown as Record<string, unknown>).pi = runtime;
    const caps = detectPiCapabilities();
    expect(caps.sendUserMessage).toEqual(true);
    expect(caps.registerCommand).toEqual(false);
  });
});
