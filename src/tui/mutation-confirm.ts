import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DirtyConflict } from "../baseline/snapshot.js";

export type MutationConflictConfirmationInput = {
  goalId: string;
  assignmentId: string;
  description: string;
  conflicts: readonly DirtyConflict[];
  writeSet: readonly string[];
};

type Theme = ExtensionContext["ui"]["theme"];
type ConfirmTui = { requestRender(): void };

class MutationConflictConfirmationComponent implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly input: MutationConflictConfirmationInput,
    private readonly done: (value: boolean) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "return") || data === "\r" || data === "\n" || data.toLowerCase() === "y") {
      this.done(true);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "q" || data.toLowerCase() === "n") {
      this.done(false);
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, Math.min(96, width - 4));
    const clip = (text: string) => truncateToWidth(text, inner);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Keystone · dirty write collision")));
    lines.push(this.theme.fg("dim", clip(`${this.input.goalId} · ${this.input.assignmentId}`)));
    lines.push("");
    lines.push(this.theme.bold("Assignment"));
    lines.push(clip(this.input.description));
    lines.push("");
    lines.push(this.theme.bold(`Pre-existing dirt in exact write-set · ${this.input.conflicts.length}`));
    for (const conflict of this.input.conflicts.slice(0, 10)) {
      lines.push(clip(`  ${conflict.kind.padEnd(9)} ${conflict.path}`));
    }
    if (this.input.conflicts.length > 10) lines.push(this.theme.fg("dim", clip(`  +${this.input.conflicts.length - 10} more conflicts`)));
    lines.push("");
    lines.push(this.theme.bold(`Acquired exact write-set · ${this.input.writeSet.length}`));
    for (const file of this.input.writeSet.slice(0, 10)) lines.push(clip(`  ${file}`));
    if (this.input.writeSet.length > 10) lines.push(this.theme.fg("dim", clip(`  +${this.input.writeSet.length - 10} more paths`)));
    lines.push("");
    lines.push(this.theme.fg("dim", clip("Enter/y approve this unchanged dirty collision · Esc/q/n deny")));
    return lines;
  }
}

export async function openMutationConflictConfirmation(
  ctx: ExtensionContext,
  input: MutationConflictConfirmationInput,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  if (ctx.mode === "tui") {
    return ctx.ui.custom<boolean>(
      (_tui, theme, _keybindings, done) => new MutationConflictConfirmationComponent(theme, input, done),
      { overlay: true, overlayOptions: { anchor: "center", width: 100, maxHeight: 30 } },
    );
  }
  if (ctx.mode === "rpc") {
    const conflicts = input.conflicts
      .slice(0, 10)
      .map((conflict) => `${conflict.kind}: ${conflict.path}`)
      .join("\n");
    const suffix = input.conflicts.length > 10
      ? `\n+${input.conflicts.length - 10} more conflict(s)`
      : "";
    return ctx.ui.confirm(
      `Keystone · dirty write collision · ${input.assignmentId}`,
      [
        input.description,
        "",
        "Pre-existing dirt overlaps the exact acquired write-set:",
        conflicts + suffix,
        "",
        "Approve mutation of these already-dirty paths?",
      ].join("\n"),
    );
  }
  return false;
}
