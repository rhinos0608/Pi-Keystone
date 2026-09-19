import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ProvisionalPlan } from "../planning/provisional-plan.js";
import type { DepthProposal, LifecycleDepth } from "../runtime/depth.js";

export type GoalConfirmationInput = {
  goalId: string;
  task: string;
  plan: ProvisionalPlan;
  proposal: DepthProposal;
  baselineSummary: string;
  fleetSummary?: string;
};

export type GoalConfirmationDecision = {
  depth: LifecycleDepth;
};

type Theme = ExtensionContext["ui"]["theme"];
type ConfirmTui = { requestRender(): void };

const OPTIONS: Array<{ depth: LifecycleDepth; label: string; detail: string }> = [
  { depth: "quick", label: "Quick", detail: "execute + deterministic verification; skip reviewer/auditor children" },
  { depth: "standard", label: "Standard", detail: "execute + verification + one independent reviewer; skip dual final audit" },
  { depth: "full", label: "Full", detail: "execute + verification + review + two fresh final auditors + completion gate" },
];
class GoalConfirmationComponent implements Component {
  private selected: number;

  constructor(
    private readonly tui: ConfirmTui,
    private readonly theme: Theme,
    private readonly input: GoalConfirmationInput,
    private readonly done: (value: GoalConfirmationDecision | null) => void,
  ) {
    this.selected = Math.max(0, OPTIONS.findIndex((o) => o.depth === input.proposal.depth));
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(OPTIONS.length - 1, this.selected + 1);
    else if (data === "1") this.selected = 0;
    else if (data === "2") this.selected = 1;
    else if (data === "3") this.selected = 2;
    else if (matchesKey(data, "return") || data === "\r" || data === "\n") {
      this.done({ depth: OPTIONS[this.selected]!.depth });
      return;
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "q") {
      this.done(null);
      return;
    } else return;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const inner = Math.max(1, Math.min(96, width - 4));
    const lines: string[] = [];
    const clip = (text: string) => truncateToWidth(text, inner);
    lines.push(this.theme.fg("accent", this.theme.bold("Keystone · confirm goal")));
    lines.push(this.theme.fg("dim", clip(`${this.input.goalId} · ${this.input.baselineSummary}`)));
    if (this.input.fleetSummary) lines.push(this.theme.fg("dim", clip(this.input.fleetSummary)));
    lines.push("");
    lines.push(this.theme.bold("Goal"));
    lines.push(clip(this.input.task));
    lines.push("");
    lines.push(this.theme.bold(`Plan · ${this.input.plan.assignments.length} assignment(s)`));
    for (const assignment of this.input.plan.assignments.slice(0, 6)) {
      const role = assignment.role === "implementation" ? "impl" : "verify";
      lines.push(clip(`  ${role.padEnd(6)} ${assignment.description}`));
    }
    if (this.input.plan.assignments.length > 6) {
      lines.push(this.theme.fg("dim", `  +${this.input.plan.assignments.length - 6} more`));
    }
    lines.push("");
    lines.push(this.theme.bold(`Suggested depth · ${this.input.proposal.depth.toUpperCase()}`));
    lines.push(clip(this.input.proposal.rationale));
    if (this.input.proposal.signals.length) {
      lines.push(this.theme.fg("dim", clip(`Signals: ${this.input.proposal.signals.join(" · ")}`)));
    }
    lines.push("");
    for (let i = 0; i < OPTIONS.length; i++) {
      const option = OPTIONS[i]!;
      const selected = i === this.selected;
      const marker = selected ? this.theme.fg("accent", "›") : " ";
      const label = selected ? this.theme.bold(`${i + 1}. ${option.label}`) : `${i + 1}. ${option.label}`;
      lines.push(clip(`${marker} ${label} · ${option.detail}`));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", clip("↑↓/j k choose · 1/2/3 jump · Enter approve & start · Esc/q keep prepared without release")));
    return lines;
  }
}

export async function openGoalConfirmation(
  ctx: ExtensionContext,
  input: GoalConfirmationInput,
): Promise<GoalConfirmationDecision | null> {
  if (!ctx.hasUI) return null;
  if (ctx.mode === "tui") {
    return ctx.ui.custom<GoalConfirmationDecision | null>(
      (tui, theme, _keybindings, done) => new GoalConfirmationComponent(tui, theme, input, done),
      { overlay: true, overlayOptions: { anchor: "center", width: 100, maxHeight: 28 } },
    );
  }
  // Headless/RPC hosts cannot render custom TUI components, but Pi exposes
  // an explicit extension-UI select round trip. Preserve the same approval
  // authority rather than bypassing confirmation for automation/E2E clients.
  if (ctx.mode === "rpc") {
    const options = OPTIONS.map((option, index) =>
      `${index + 1}. ${option.label}${option.depth === input.proposal.depth ? " (suggested)" : ""} · ${option.detail}`,
    );
    const selected = await ctx.ui.select(
      `Keystone · confirm goal · ${input.goalId}`,
      options,
    );
    if (!selected) return null;
    const index = options.indexOf(selected);
    return index >= 0 ? { depth: OPTIONS[index]!.depth } : null;
  }
  return null;
}
