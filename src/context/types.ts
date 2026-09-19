/**
 * Frozen types for Phase 6 context compilation.
 * GoalContextView, ContextAssignment, ContextLease, AuthorityReceipt.
 */

// ── Roles ──────────────────────────────────────────────────────────

export type ContextRole = "planner" | "worker" | "reviewer" | "orchestrator";

// ── Entity / Finding references ────────────────────────────────────

export interface EntityRef {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** Token budget consumed by including this entity in context. */
  readonly tokenCost: number;
}

export interface Finding {
  readonly id: string;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly message: string;
  readonly source: string;
  readonly tokenCost: number;
}

export interface BaselineInfo {
  readonly snapshotId: string;
  readonly timestamp: string;
  readonly checksum: string;
}

export interface ContractRef {
  readonly id: string;
  readonly kind: "goal" | "plan" | "assignment" | "verification";
  /** Pointer to the canonical store entry. */
  readonly storeKey: string;
}

export interface VerificationResult {
  readonly contractId: string;
  readonly passed: boolean;
  readonly details: string;
  readonly tokenCost: number;
}

// ── ContextAssignment ──────────────────────────────────────────────

export interface ContextAssignment {
  readonly id: string;
  readonly goalId: string;
  readonly workerRole: string;
  readonly scope: readonly EntityRef[];
  readonly instructions: string;
  readonly tokenCost: number;
}

// ── ContextLease ───────────────────────────────────────────────────

export interface ContextLease {
  readonly assignmentId: string;
  readonly entityIds: readonly string[];
  readonly expiresAt: string;
  readonly tokenCost: number;
}

// ── AuthorityReceipt ───────────────────────────────────────────────

export interface AuthorityReceipt {
  readonly role: ContextRole;
  readonly lease?: ContextLease;
  readonly allowedTools: readonly string[];
  readonly issuedAt: string;
}

// ── Budget ─────────────────────────────────────────────────────────

export interface BudgetInfo {
  readonly hardLimit: number;
  readonly consumed: number;
  readonly remaining: number;
}

// ── Tool gating ────────────────────────────────────────────────────

export interface ToolInfo {
  readonly name: string;
  readonly allowed: boolean;
}

// ── GoalContextView (frozen output) ────────────────────────────────

export interface GoalContextView {
  readonly role: ContextRole;
  readonly budget: BudgetInfo;
  readonly entities: readonly EntityRef[];
  readonly findings: readonly Finding[];
  readonly baseline: BaselineInfo | null;
  readonly contractRefs: readonly ContractRef[];
  readonly assignment: ContextAssignment | null;
  readonly verificationResults: readonly VerificationResult[];
  readonly tools: readonly ToolInfo[];
}

// ── Compiler input types ───────────────────────────────────────────

export interface SnapshotRefs {
  readonly baseline?: BaselineInfo;
  readonly contracts?: readonly ContractRef[];
}

export interface ContextGoalStore {
  readonly contracts: readonly ContractRef[];
  readonly baseline?: BaselineInfo;
  readonly findings: readonly Finding[];
  readonly entities: readonly EntityRef[];
  readonly assignment?: ContextAssignment;
  readonly verificationResults?: readonly VerificationResult[];
}

// ── Compiler config ────────────────────────────────────────────────────

export const DEFAULT_TOKEN_BUDGET = 4000;

export interface CompilerConfig {
  /** Hard token budget limit. Default 4000. */
  readonly budgetLimit?: number;
}
