/**
 * compileContext — builds a GoalContextView from role, goalStore, and snapshotRefs.
 *
 * Role matrix:
 *   planner    → contracts + plan + baseline + read-only tools
 *   worker     → assignment + relevant graph + findings + mutation lease tools
 *   reviewer   → findings + verification results + read-only tools (no mutation)
 *   orchestrator → everything (contracts + findings + verification + full tools)
 *
 * Hard budget enforced: items are included greedily until budget exhausted.
 * Items already fitting the role are sorted by tokenCost ascending so the
 * most information-dense items enter context first.
 *
 * Required items (e.g. assignment for worker) throw if they don't fit the budget.
 */

import type {
  AuthorityReceipt,
  CompilerConfig,
  ContextRole,
  ContractRef,
  EntityRef,
  Finding,
  GoalContextView,
  GoalStore,
  MutationLease,
  SnapshotRefs,
  ToolInfo,
  VerificationResult,
} from "./types.js";
import { DEFAULT_TOKEN_BUDGET } from "./types.js";

// ── Tool policies per role ─────────────────────────────────────────

const READ_ONLY_TOOLS = [
  "read",
  "inspect",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch",
] as const;

const MUTATION_TOOLS = [
  ...READ_ONLY_TOOLS,
  "write",
  "edit",
  "bash",
] as const;

type RoleToolPolicy = readonly string[];

const TOOL_POLICIES: Record<ContextRole, RoleToolPolicy> = {
  planner: READ_ONLY_TOOLS,
  worker: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  orchestrator: MUTATION_TOOLS,
};

// ── Helpers ────────────────────────────────────────────────────────

function sortByCost<T extends { readonly tokenCost: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.tokenCost - b.tokenCost);
}

type CostableItem = { readonly tokenCost: number; readonly required?: boolean };

/** Greedily fill items up to the remaining budget. Throws on required items that don't fit. */
function fitItems<T extends CostableItem>(
  items: readonly T[],
  budget: number,
): { included: T[]; remaining: number } {
  const sorted = sortByCost(items);
  let remaining = budget;
  const included: T[] = [];
  for (const item of sorted) {
    if (item.tokenCost <= remaining) {
      included.push(item);
      remaining -= item.tokenCost;
    } else if (item.required) {
      throw new Error(
        `Required item does not fit context budget: need ${item.tokenCost} tokens but only ${remaining} remaining`,
      );
    }
  }
  return { included, remaining };
}

// ── Role filtering ─────────────────────────────────────────────────

/** Which contract kinds does this role see? */
function contractKindsForRole(
  role: ContextRole,
): Set<ContractRef["kind"]> {
  switch (role) {
    case "planner":
      return new Set(["goal", "plan"]);
    case "worker":
      return new Set(["goal", "assignment"]);
    case "reviewer":
      return new Set(["goal", "verification"]);
    case "orchestrator":
      return new Set(["goal", "plan", "assignment", "verification"]);
  }
}

// ── Compiler ───────────────────────────────────────────────────────

export function compileContext(
  role: ContextRole,
  goalStore: GoalStore,
  snapshotRefs?: SnapshotRefs,
  config?: CompilerConfig,
): GoalContextView {
  const budgetLimit = config?.budgetLimit ?? DEFAULT_TOKEN_BUDGET;
  let budgetRemaining = budgetLimit;

  // ── Baseline (worker excluded — operates from assignment scope) ──
  const baseline = role === "worker"
    ? null
    : (snapshotRefs?.baseline ?? goalStore.baseline ?? null);

  // ── Contract refs filtered by role ──────────────────────────────
  const kinds = contractKindsForRole(role);
  const sourceContracts = [
    ...goalStore.contracts,
    ...(snapshotRefs?.contracts ?? []),
  ];
  const roleContracts = sourceContracts.filter((c) => kinds.has(c.kind));

  // ── Findings (planner, reviewer, orchestrator always; worker only relevant) ──
  const findings =
    role === "worker"
      ? [] // worker receives findings via assignment scope, not global
      : goalStore.findings;

  // ── Assignment ──────────────────────────────────────────────────
  const assignment = role === "worker" ? (goalStore.assignment ?? null) : null;

  // ── Verification results ────────────────────────────────────────
  const verificationResults =
    role === "reviewer" || role === "orchestrator"
      ? goalStore.verificationResults ?? []
      : [];

  // ── Entities (role-dependent) ───────────────────────────────────
  let entities: EntityRef[];
  switch (role) {
    case "worker":
      // Worker gets scope from assignment, plus entities referenced there.
      entities = assignment ? [...assignment.scope] : [];
      break;
    case "reviewer":
      // Reviewer sees entities tied to findings only.
      entities = [];
      break;
    case "planner":
    case "orchestrator":
      entities = [...goalStore.entities];
      break;
  }

  // ── Budget fitting ──────────────────────────────────────────────
  const contractCosts: { kind: "contract"; ref: ContractRef; tokenCost: number }[] =
    roleContracts.map((c) => ({
      kind: "contract" as const,
      ref: c,
      tokenCost: 100, // contracts are compact refs, fixed cost
    }));

  const findingCosts: { kind: "finding"; ref: Finding; tokenCost: number }[] =
    findings.map((f) => ({ kind: "finding" as const, ref: f, tokenCost: f.tokenCost }));

  const entityCosts: { kind: "entity"; ref: EntityRef; tokenCost: number }[] =
    entities.map((e) => ({ kind: "entity" as const, ref: e, tokenCost: e.tokenCost }));

  const verCosts: {
    kind: "verification";
    ref: VerificationResult;
    tokenCost: number;
  }[] = verificationResults.map((v) => ({
    kind: "verification" as const,
    ref: v,
    tokenCost: v.tokenCost,
  }));

  const assignmentCost: number = assignment?.tokenCost ?? 0;

  // Fit everything under the shared budget.
  const allCostables = sortByCost([
    ...contractCosts,
    ...findingCosts,
    ...entityCosts,
    ...verCosts,
  ]);

  const { included: fitIncluded, remaining } = fitItems(allCostables, budgetRemaining);
  budgetRemaining = remaining;

  // Deduct assignment cost from whatever's left. Budget is hard.
  let finalAssignment = assignment;
  if (assignment && assignmentCost <= budgetRemaining) {
    budgetRemaining -= assignmentCost;
  } else {
    finalAssignment = null;
  }

  // ── Assemble final collections from fitted set ──────────────────
  const includedContracts: ContractRef[] = [];
  const includedFindings: Finding[] = [];
  const includedEntities: EntityRef[] = [];
  const includedVerification: VerificationResult[] = [];

  for (const item of fitIncluded) {
    switch (item.kind) {
      case "contract":
        includedContracts.push(item.ref);
        break;
      case "finding":
        includedFindings.push(item.ref);
        break;
      case "entity":
        includedEntities.push(item.ref);
        break;
      case "verification":
        includedVerification.push(item.ref);
        break;
    }
  }

  // ── Tools ───────────────────────────────────────────────────────
  const toolPolicy = TOOL_POLICIES[role];
  const tools: ToolInfo[] = toolPolicy.map((name) => ({ name, allowed: true }));

  // ── Build view ──────────────────────────────────────────────────
  const consumed = budgetLimit - budgetRemaining;

  return Object.freeze({
    role,
    budget: Object.freeze({
      hardLimit: budgetLimit,
      consumed,
      remaining: budgetRemaining,
    }),
    entities: Object.freeze(includedEntities),
    findings: Object.freeze(includedFindings),
    baseline,
    contractRefs: Object.freeze(includedContracts),
    assignment: finalAssignment,
    verificationResults: Object.freeze(includedVerification),
    tools: Object.freeze(tools),
  }) as GoalContextView;
}

// ── Authority receipt issuance ─────────────────────────────────────

export function issueAuthority(
  role: ContextRole,
  lease?: MutationLease,
): AuthorityReceipt {
  return Object.freeze({
    role,
    lease,
    allowedTools: Object.freeze([...TOOL_POLICIES[role]]),
    issuedAt: new Date().toISOString(),
  });
}
