// Contract orchestrator — drafts contract then runs critic.
// Bridges draft.ts GoalContract → goal-contract.ts GoalContract for critique.

import type { GoalRecord } from "../domain/types.js";
import type { ProvisionalPlan } from "../planning/provisional-plan.js";
import { DraftGoalContract, type BaselineInvariants, type GoalContract as DraftContract } from "./draft.js";
import { critiqueContract, type CritiqueFinding } from "./critic.js";
import type { GoalContract as CanonicalContract, ContractStatement } from "./goal-contract.js";
import type { PiCapabilities } from "../runtime/feature-detect.js";
import { detectPiCapabilities } from "../runtime/feature-detect.js";

export type ContractResult =
  | { contract: CanonicalContract }
  | { findings: CritiqueFinding[] };

/**
 * Draft a goal contract from task + baseline invariants, then critique it.
 * Returns either a frozen contract or the critique findings.
 */
export async function runContractDraft(
  goal: GoalRecord,
  invariants: BaselineInvariants,
  plan: ProvisionalPlan,
  capabilities?: PiCapabilities,
): Promise<ContractResult> {
  const caps = capabilities ?? detectPiCapabilities();
  const draft: DraftContract = DraftGoalContract(
    goal.userTask,
    invariants,
    caps,
  );

  // Bridge draft GoalContract → canonical GoalContract for critique
  const canonical = draftToCanonical(goal.goalId, draft, plan);

  const critique = critiqueContract(canonical);

  if (critique.approved) {
    return { contract: canonical };
  }

  return { findings: critique.findings };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function draftToCanonical(
  goalId: string,
  draft: DraftContract,
  plan: ProvisionalPlan,
): CanonicalContract {
  return {
    schemaVersion: 1,
    version: draft.version as CanonicalContract["version"],
    goalId,
    requirements: draft.statements.map(stmtToStatement),
    invariants: plan.assumptions.map((a, i) => ({
      id: `inv-${i}`,
      text: a,
      provenance: "derived" as const,
      strength: "soft" as const,
    })),
    completionCriteria: draft.completionCriteria.map((c) => ({
      id: c.id,
      text: c.text,
      provenance: c.provenance,
      strength: c.strength,
    })),
    assumptions: plan.risks.map((r, i) => ({
      id: `assump-${i}`,
      text: r,
      provenance: "derived" as const,
      strength: "soft" as const,
    })),
  };
}

function stmtToStatement(s: { id: string; text: string; provenance: string; strength: string }): ContractStatement {
  return {
    id: s.id,
    text: s.text,
    provenance: s.provenance as ContractStatement["provenance"],
    strength: s.strength as ContractStatement["strength"],
  };
}
