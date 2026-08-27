/**
 * Pi API feature detection — probes runtime for available capabilities.
 * Safe to call in any environment; returns false when Pi runtime absent.
 */

export type PiCapabilities = {
  sendUserMessage: boolean;
  registerCommand: boolean;
  contextEvent: boolean;
  sessionBeforeCompact: boolean;
  toolCallIntercept: boolean;
  newSession: boolean;
};

// ponytail: probe patterns are hardcoded; add config param only if new
// capabilities exceed 2x current set.

function hasMethod(obj: unknown, method: string): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as Record<string, unknown>)[method] === "function"
  );
}

/**
 * Detect which Pi runtime capabilities are available in the current environment.
 * Uses typeof checks and try/catch — never throws.
 */
export function detectPiCapabilities(): PiCapabilities {
  const result: PiCapabilities = {
    sendUserMessage: false,
    registerCommand: false,
    contextEvent: false,
    sessionBeforeCompact: false,
    toolCallIntercept: false,
    newSession: false,
  };

  // Locate Pi runtime entry point.
  // Pi extensions may access the runtime via globalThis or a require shim.
  let runtime: unknown;
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    runtime = g.pi ?? g.Pi ?? null;
  } catch {
    // globalThis access denied by restricted environment
  }

  if (runtime === null || runtime === undefined) {
    return result;
  }

  // Each probe isolated — sandbox may deny specific property access.
  try { result.sendUserMessage = hasMethod(runtime, "sendUserMessage"); }
  catch { /* sandbox denied property access */ }
  try { result.registerCommand = hasMethod(runtime, "registerCommand"); }
  catch { /* sandbox denied property access */ }
  try { result.contextEvent = hasMethod(runtime, "contextEvent"); }
  catch { /* sandbox denied property access */ }
  try { result.sessionBeforeCompact = hasMethod(runtime, "sessionBeforeCompact"); }
  catch { /* sandbox denied property access */ }
  try { result.toolCallIntercept = hasMethod(runtime, "toolCallIntercept"); }
  catch { /* sandbox denied property access */ }
  try { result.newSession = hasMethod(runtime, "newSession"); }
  catch { /* sandbox denied property access */ }

  return result;
}
