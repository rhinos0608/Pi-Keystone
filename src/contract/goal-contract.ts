/**
 * Frozen goal-contract types — Phase 5 schema-freeze.
 * Source of truth: ARCHITECTURE.md §3C (Goal contract).
 *
 * A GoalContract captures the frozen agreement between user intent and
 * repository reality before execution begins. Each statement carries
 * provenance and strength to make contract reasoning auditable.
 */

// ---------------------------------------------------------------------------
// ContractVersion
// ---------------------------------------------------------------------------

/** Opaque contract version number; monotonically increasing per goal. */
export type ContractVersion = number & { readonly __brand: "ContractVersion" };

// ---------------------------------------------------------------------------
// Provenance & Strength
// ---------------------------------------------------------------------------

/** How a contract statement was established. */
export type StatementProvenance =
  | "explicit-user"   // direct user input
  | "repo-inferred"   // derived from repository state/evidence
  | "derived";        // logically derived from other statements

/** Binding strength of a contract statement. */
export type StatementStrength =
  | "hard"            // must be satisfied; cannot disappear through replanning
  | "soft";           // preferred but may be waived

// ---------------------------------------------------------------------------
// ContractStatement
// ---------------------------------------------------------------------------

/** A single statement within a frozen contract. */
export type ContractStatement = {
  /** Stable identifier within the goal (e.g. REQ-001, INV-003). */
  readonly id: string;

  /** Human-readable statement text describing the requirement/invariant/etc. */
  readonly text: string;

  /** How this statement was established. */
  readonly provenance: StatementProvenance;

  /** Binding strength. */
  readonly strength: StatementStrength;
};

// ---------------------------------------------------------------------------
// GoalContract
// ---------------------------------------------------------------------------

/** Frozen goal contract stored as an immutable artifact after CONTRACT_REVIEW. */
export type GoalContract = {
  /** Schema version for forward/backward compatibility. */
  readonly schemaVersion: 1;

  /** Contract version (monotonically increasing per goal). */
  readonly version: ContractVersion;

  /** Goal this contract belongs to. */
  readonly goalId: string;

  /** Requirements the implementation must satisfy. */
  readonly requirements: readonly ContractStatement[];

  /** Repository invariants that must remain true. */
  readonly invariants: readonly ContractStatement[];

  /** Observable completion criteria mapped back to requirements. */
  readonly completionCriteria: readonly ContractStatement[];

  /** Implementation assumptions that never count as completion. */
  readonly assumptions: readonly ContractStatement[];
};
