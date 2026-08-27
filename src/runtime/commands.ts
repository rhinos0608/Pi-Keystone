// /goal command parsing and Pi sendUserMessage integration
// Per G-pi-integration.md §3.2: commands bypass the turn loop,
// must explicitly drive work via pi.sendUserMessage().

/** Minimal Pi agent interface for command → turn handoff. */
export interface PiAgent {
  /** Always triggers a turn (extensions.md:1414). */
  sendUserMessage(message: string): void | Promise<void>;
}

export interface GoalCommand {
  task: string;
}

/**
 * Parse user input for a /goal command.
 * Accepts `/goal <task>` (raw user input).
 * Returns null when input is not a valid goal command.
 */
export function parseGoalCommand(input: string): GoalCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/goal\s+([\s\S]+)$/);
  if (!match) return null;
  const task = match[1].trim();
  if (!task) return null;
  return { task };
}

/**
 * Create a /goal command handler for Pi 0.84.1 extension registration.
 *
 * Usage:
 *   pi.registerCommand("goal", { handler: createGoalHandler(pi) });
 *
 * Commands bypass the normal turn lifecycle (extensions.md:287).
 * The handler explicitly drives agent work via pi.sendUserMessage(),
 * which always triggers a turn (extensions.md:1414).
 *
 * Pi strips the command name from args; the handler reconstructs
 * the full `/goal <task>` input for the parser.
 */
export function createGoalHandler(pi: PiAgent) {
  return async (args: string): Promise<void> => {
    // Pi strips the command name; reconstruct full input for the parser
    const parsed = parseGoalCommand("/goal " + args);
    if (!parsed) return;

    // Trigger agent turn — commands bypass lifecycle, must explicitly drive work
    await pi.sendUserMessage(parsed.task);
  };
}
