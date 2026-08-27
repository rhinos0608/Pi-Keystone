/**
 * Mock Pi runtime for testing.
 * Stubs sendUserMessage, registerCommand, and context events.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContextEvent {
  type: string;
  payload: unknown;
}

export interface MockPiRuntime {
  /** Captured messages from sendUserMessage calls. */
  sentMessages: string[];
  /** Registered command handlers. */
  commands: Map<string, (args: string) => void | Promise<void>>;
  /** Captured context events. */
  contextEvents: ContextEvent[];

  /** Spy for sendUserMessage. */
  sendUserMessage(msg: string): Promise<void>;
  /** Spy for registerCommand. */
  registerCommand(
    name: string,
    handler: { handler: (args: string) => void | Promise<void> },
  ): void;
  /** Emit a context event through the mock runtime. */
  emitContextEvent(event: ContextEvent): void;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a fresh mock Pi runtime. Each call returns an isolated instance.
 */
export function createMockPiRuntime(): MockPiRuntime {
  const runtime: MockPiRuntime = {
    sentMessages: [],
    commands: new Map(),
    contextEvents: [],

    async sendUserMessage(msg: string): Promise<void> {
      runtime.sentMessages.push(msg);
    },

    registerCommand(
      name: string,
      handler: { handler: (args: string) => void | Promise<void> },
    ): void {
      runtime.commands.set(name, handler.handler);
    },

    emitContextEvent(event: ContextEvent): void {
      runtime.contextEvents.push(event);
    },
  };

  return runtime;
}
