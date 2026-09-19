// Post-freeze contract amendment protocol
// Amendments require explicit user authorization, create new versions, never mutate old ones.

import type { ArtifactRef, ISO8601 } from "../domain/types.js";
import type { ContractStatement } from "./goal-contract.js";

export type { ContractStatement };

// ─── Core types ─────────────────────────────────────────────────────────────

/** Immutable frozen contract. Never mutated — amendments create new versions. */
export type FrozenContract = {
  readonly version: number;
  readonly statements: readonly ContractStatement[];
  readonly frozenAt: ISO8601;
  readonly contractRef: ArtifactRef;
};

export type AmendmentDiff = {
  readonly added: readonly ContractStatement[];
  readonly removed: readonly ContractStatement[];
  readonly weakened: readonly { statement: ContractStatement; was: string }[];
  readonly strengthened: readonly { statement: ContractStatement; was: string }[];
};

export type AmendmentProposal = {
  readonly amendmentRef: ArtifactRef;
  readonly fromVersion: number;
  readonly proposedVersion: number;
  readonly proposedStatements: readonly ContractStatement[];
  readonly diff: AmendmentDiff;
  readonly proposer: "USER" | "KEYSTONE";
  readonly authorizationRef: ArtifactRef;
};

export type Authorization = {
  readonly authorizationRef: ArtifactRef;
  readonly authorizer: "USER";
  readonly authorizedAt: ISO8601;
};

export type AmendmentResult =
  | { readonly approved: true; readonly contractVersion: number; readonly contractRef: ArtifactRef }
  | { readonly approved: false; readonly rejectionReason: string; readonly rejectedBy: "USER" | "POLICY" };

// ─── Frozen contract creation ───────────────────────────────────────────────

export function freezeContract(
  statements: readonly ContractStatement[],
  contractRef: ArtifactRef,
  version = 1,
  frozenAt: ISO8601 = new Date().toISOString() as ISO8601,
): FrozenContract {
  return Object.freeze({
    version,
    statements: Object.freeze([...statements]),
    frozenAt,
    contractRef,
  });
}

// ─── Diff computation ───────────────────────────────────────────────────────

export function computeAmendmentDiff(
  original: readonly ContractStatement[],
  proposed: readonly ContractStatement[],
): AmendmentDiff {
  const origMap = new Map(original.map((s) => [s.id, s]));
  const propMap = new Map(proposed.map((s) => [s.id, s]));

  const added: ContractStatement[] = [];
  const removed: ContractStatement[] = [];
  const weakened: { statement: ContractStatement; was: string }[] = [];
  const strengthened: { statement: ContractStatement; was: string }[] = [];

  for (const stmt of proposed) {
    const existing = origMap.get(stmt.id);
    if (!existing) {
      added.push(stmt);
    } else if (existing.text !== stmt.text || existing.strength !== stmt.strength) {
      if (existing.strength === "hard" && stmt.strength !== "hard") {
        weakened.push({ statement: stmt, was: existing.text });
      } else {
        strengthened.push({ statement: stmt, was: existing.text });
      }
    }
  }

  for (const stmt of original) {
    if (!propMap.has(stmt.id)) {
      removed.push(stmt);
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    weakened: Object.freeze(weakened),
    strengthened: Object.freeze(strengthened),
  });
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ValidationError =
  | { readonly kind: "hard_requirement_weakened"; readonly statementId: string; readonly was: string; readonly became: string }
  | { readonly kind: "missing_authorization" };

export function validateAmendmentDiff(
  diff: AmendmentDiff,
  original: readonly ContractStatement[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const origMap = new Map(original.map((s) => [s.id, s]));

  for (const w of diff.weakened) {
    const orig = origMap.get(w.statement.id);
    if (orig?.strength === "hard") {
      errors.push({
        kind: "hard_requirement_weakened",
        statementId: w.statement.id,
        was: orig.text,
        became: w.statement.text,
      });
    }
  }

  return errors;
}

// ─── Proposal ───────────────────────────────────────────────────────────────

export function proposeAmendment(
  frozen: FrozenContract,
  proposedStatements: readonly ContractStatement[],
  proposer: "USER" | "KEYSTONE",
  authorizationRef: ArtifactRef,
  amendmentRef: ArtifactRef,
): AmendmentProposal {
  const diff = computeAmendmentDiff(frozen.statements, proposedStatements);
  return Object.freeze({
    amendmentRef,
    fromVersion: frozen.version,
    proposedVersion: frozen.version + 1,
    proposedStatements: Object.freeze([...proposedStatements]),
    diff,
    proposer,
    authorizationRef,
  });
}

// ─── Authorization check ────────────────────────────────────────────────────

export function hasValidAuthorization(
  proposal: AmendmentProposal,
  authorization: Authorization,
): boolean {
  return (
    authorization.authorizer === "USER" &&
    authorization.authorizationRef === proposal.authorizationRef
  );
}

// ─── Amend (main protocol) ──────────────────────────────────────────────────

/**
 * Process a contract amendment. The caller provides `requestedAuthRef` — the
 * authorization reference the proposer claims — separately from the actual
 * `Authorization` credential. The protocol verifies they match.
 */
export function amend(
  frozen: FrozenContract,
  proposedStatements: readonly ContractStatement[],
  proposer: "USER" | "KEYSTONE",
  requestedAuthRef: ArtifactRef,
  authorization: Authorization,
  amendmentRef: ArtifactRef,
  newContractRef: ArtifactRef,
  criticRunId: string,
): { result: AmendmentResult; newContract?: FrozenContract } {
  // 1. Build proposal — proposal carries the *requested* auth ref
  const proposal = proposeAmendment(frozen, proposedStatements, proposer, requestedAuthRef, amendmentRef);

  // 2. Check authorization — all amendments require explicit user authorization
  if (!hasValidAuthorization(proposal, authorization)) {
    return {
      result: { approved: false, rejectionReason: "Missing or invalid user authorization", rejectedBy: "POLICY" },
    };
  }

  // 3. Check hard-requirement weakening
  const errors = validateAmendmentDiff(proposal.diff, frozen.statements);
  if (errors.length > 0) {
    return {
      result: {
        approved: false,
        rejectionReason: errors
          .filter((e): e is Extract<ValidationError, { kind: "hard_requirement_weakened" }> => e.kind === "hard_requirement_weakened")
          .map((e) => `Hard requirement "${e.statementId}" cannot be weakened`)
          .join("; "),
        rejectedBy: "POLICY",
      },
    };
  }

  // 4. Create new frozen contract (new version, old one untouched)
  const newContract = freezeContract(
    proposedStatements,
    newContractRef,
    proposal.proposedVersion,
  );

  return {
    result: { approved: true, contractVersion: newContract.version, contractRef: newContractRef },
    newContract,
  };
}

// ─── Immutability helpers ───────────────────────────────────────────────────

/** Returns true if the contract object is frozen (Object.isFrozen). */
export function isContractFrozen(contract: FrozenContract): boolean {
  return Object.isFrozen(contract) && Object.isFrozen(contract.statements);
}
