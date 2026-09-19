import type { EcosystemBaseline } from "../baseline/types.js";
import type { GoalContract } from "../contract/goal-contract.js";
import type { ProvisionalPlan } from "../planning/provisional-plan.js";

export type LifecycleDepth = "quick" | "standard" | "full";

export type DepthProposal = {
  depth: LifecycleDepth;
  rationale: string;
  signals: string[];
  source: "model" | "heuristic";
};

export type DepthProposalInput = {
  task: string;
  plan: ProvisionalPlan;
  contract: GoalContract;
  baseline: EcosystemBaseline;
};

export const DEPTH_ORDER: readonly LifecycleDepth[] = ["quick", "standard", "full"];

export function depthRank(depth: LifecycleDepth): number {
  return DEPTH_ORDER.indexOf(depth);
}

export function maxDepth(left: LifecycleDepth, right: LifecycleDepth): LifecycleDepth {
  return depthRank(left) >= depthRank(right) ? left : right;
}
const HIGH_RISK = /\b(auth\w*|secur\w*|permission\w*|credential\w*|secret\w*|migration\w*|schema\w*|database\w*|concurren\w*|race\w*|lease\w*|lock\w*|billing\w*|payment\w*|delet\w*|destructive\w*|public\s+api|breaking\w*|protocol\w*|persist\w*|recover\w*)\b/i;

export function heuristicDepth(input: DepthProposalInput): DepthProposal {
  const implementation = input.plan.assignments.filter((a) => a.role === "implementation");
  const targetFiles = new Set(input.plan.assignments.flatMap((a) => a.targetFiles));
  const criteria = input.contract.completionCriteria.length;
  const baselineRed = Object.values(input.baseline.checks).filter(
    (check) => check && !["PASS", "UNAVAILABLE", "SKIPPED"].includes(check.status),
  ).length;
  const signals: string[] = [];

  let depth: LifecycleDepth = "quick";
  if (implementation.length > 1 || criteria > 2 || targetFiles.size > 2) {
    depth = "standard";
    signals.push("multi-surface change");
  }
  if (HIGH_RISK.test(input.task)) {
    depth = "full";
    signals.push("high-risk domain signal");
  }
  if (implementation.length >= 4 || criteria >= 5 || targetFiles.size >= 6) {
    depth = "full";
    signals.push("large execution surface");
  }
  if (baselineRed > 0 && depth === "quick") {
    depth = "standard";
    signals.push("pre-existing red baseline needs stronger attribution");
  }
  if (signals.length === 0) signals.push("small bounded plan");
  return {
    depth,
    rationale:
      depth === "quick"
        ? "Bounded goal: execute the plan, rerun deterministic verification, and complete without extra reviewer sessions."
        : depth === "standard"
          ? "Moderate goal: deterministic verification plus one independent review is proportionate."
          : "Broad or sensitive goal: keep the independent review and dual final-audit path.",
    signals,
    source: "heuristic",
  };
}

export function parseModelDepth(raw: string, fallback: DepthProposal): DepthProposal {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const value = JSON.parse(match[0]) as Record<string, unknown>;
    const depth = value.depth;
    if (depth !== "quick" && depth !== "standard" && depth !== "full") return fallback;
    const rationale = typeof value.rationale === "string" && value.rationale.trim()
      ? value.rationale.trim().slice(0, 600)
      : fallback.rationale;
    const signals = Array.isArray(value.signals)
      ? value.signals.filter((v): v is string => typeof v === "string").slice(0, 6)
      : fallback.signals;
    return { depth, rationale, signals, source: "model" };
  } catch {
    return fallback;
  }
}

export function applyHeuristicFloor(model: DepthProposal, heuristic: DepthProposal): DepthProposal {
  const depth = maxDepth(model.depth, heuristic.depth);
  if (depth === model.depth) return model;
  return {
    depth,
    rationale: `${model.rationale} Keystone raised the default to ${depth} because: ${heuristic.signals.join(", ")}.`,
    signals: [...new Set([...model.signals, ...heuristic.signals])],
    source: model.source,
  };
}
