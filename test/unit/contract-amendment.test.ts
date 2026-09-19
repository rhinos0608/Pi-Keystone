import { describe, it, expect } from "vitest";
import type { ArtifactRef, ISO8601 } from "../../src/domain/types.js";
import {
  type ContractStatement,
  type FrozenContract,
  type Authorization,
  freezeContract,
  computeAmendmentDiff,
  validateAmendmentDiff,
  proposeAmendment,
  hasValidAuthorization,
  amend,
  isContractFrozen,
} from "../../src/contract/amendment.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FROZEN_AT = "2025-06-01T00:00:00.000Z" as ISO8601;

const ORIGINAL_STATEMENTS: ContractStatement[] = [
  { id: "req-1", text: "Must handle 10k concurrent users", provenance: "explicit-user", strength: "hard" },
  { id: "req-2", text: "UI must be accessible", provenance: "explicit-user", strength: "hard" },
  { id: "req-3", text: "Use PostgreSQL for storage", provenance: "explicit-user", strength: "soft" },
];

function makeContract(
  statements: ContractStatement[] = ORIGINAL_STATEMENTS,
  version = 1,
): FrozenContract {
  return freezeContract(statements, "contract-ref-1" as ArtifactRef, version, FROZEN_AT);
}

function makeAuth(ref = "auth-ref-1"): Authorization {
  return { authorizationRef: ref as ArtifactRef, authorizer: "USER", authorizedAt: FROZEN_AT };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("freezeContract", () => {
  it("creates an immutable frozen contract", () => {
    const contract = makeContract();
    expect(isContractFrozen(contract)).toBe(true);
    expect(contract.version).toBe(1);
    expect(contract.statements).toHaveLength(3);
  });

  it("statements array is frozen", () => {
    const contract = makeContract();
    expect(Object.isFrozen(contract.statements)).toBe(true);
  });
});

describe("computeAmendmentDiff", () => {
  it("detects added statements", () => {
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-new", text: "Support rate limiting", provenance: "explicit-user", strength: "soft" },
    ];
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe("req-new");
    expect(diff.removed).toHaveLength(0);
    expect(diff.weakened).toHaveLength(0);
  });

  it("detects removed statements", () => {
    const proposed = ORIGINAL_STATEMENTS.filter((s) => s.id !== "req-3");
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].id).toBe("req-3");
    expect(diff.added).toHaveLength(0);
  });

  it("detects weakened hard requirements (hardness change only)", () => {
    const proposed = ORIGINAL_STATEMENTS.map((s) =>
      s.id === "req-1" ? { ...s, strength: "soft" as const } : s,
    );
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    expect(diff.weakened).toHaveLength(1);
    expect(diff.weakened[0].statement.id).toBe("req-1");
    expect(diff.weakened[0].was).toBe("Must handle 10k concurrent users");
  });

  it("detects strengthened statements", () => {
    const proposed = ORIGINAL_STATEMENTS.map((s) =>
      s.id === "req-3" ? { ...s, strength: "hard" as const } : s,
    );
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    expect(diff.strengthened).toHaveLength(1);
    expect(diff.strengthened[0].statement.id).toBe("req-3");
  });

  it("detects text changes as strengthened on equal strength", () => {
    const proposed = ORIGINAL_STATEMENTS.map((s) =>
      s.id === "req-3" ? { ...s, text: "Use SQLite for storage" } : s,
    );
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    expect(diff.strengthened).toHaveLength(1);
    expect(diff.strengthened[0].was).toBe("Use PostgreSQL for storage");
  });

  it("diff is frozen", () => {
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, ORIGINAL_STATEMENTS);
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.added)).toBe(true);
    expect(Object.isFrozen(diff.removed)).toBe(true);
  });

  it("no changes produces empty diff", () => {
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, ORIGINAL_STATEMENTS);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.weakened).toHaveLength(0);
    expect(diff.strengthened).toHaveLength(0);
  });
});

describe("validateAmendmentDiff", () => {
  it("rejects weakening of hard requirements", () => {
    const proposed = ORIGINAL_STATEMENTS.map((s) =>
      s.id === "req-1" ? { ...s, strength: "soft" as const } : s,
    );
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    const errors = validateAmendmentDiff(diff, ORIGINAL_STATEMENTS);
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("hard_requirement_weakened");
    if (errors[0].kind === "hard_requirement_weakened") {
      expect(errors[0].statementId).toBe("req-1");
    }
  });

  it("allows non-hard statement removal", () => {
    const proposed = ORIGINAL_STATEMENTS.filter((s) => s.id !== "req-3");
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    const errors = validateAmendmentDiff(diff, ORIGINAL_STATEMENTS);
    expect(errors).toHaveLength(0);
  });

  it("returns empty for valid amendments", () => {
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-4", text: "New feature", provenance: "explicit-user", strength: "soft" },
    ];
    const diff = computeAmendmentDiff(ORIGINAL_STATEMENTS, proposed);
    const errors = validateAmendmentDiff(diff, ORIGINAL_STATEMENTS);
    expect(errors).toHaveLength(0);
  });
});

describe("proposeAmendment", () => {
  it("creates a proposal with incremented version", () => {
    const contract = makeContract();
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-4", text: "New", provenance: "explicit-user", strength: "soft" },
    ];
    const proposal = proposeAmendment(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      "amend-ref-1" as ArtifactRef,
    );
    expect(proposal.fromVersion).toBe(1);
    expect(proposal.proposedVersion).toBe(2);
    expect(proposal.proposer).toBe("USER");
    expect(proposal.diff.added).toHaveLength(1);
  });
});

describe("hasValidAuthorization", () => {
  it("returns true for matching USER authorization", () => {
    const contract = makeContract();
    const proposal = proposeAmendment(
      contract,
      ORIGINAL_STATEMENTS,
      "USER",
      "auth-ref-1" as ArtifactRef,
      "amend-ref-1" as ArtifactRef,
    );
    const auth = makeAuth("auth-ref-1");
    expect(hasValidAuthorization(proposal, auth)).toBe(true);
  });

  it("returns false for mismatched authorization ref", () => {
    const contract = makeContract();
    const proposal = proposeAmendment(
      contract,
      ORIGINAL_STATEMENTS,
      "USER",
      "auth-ref-1" as ArtifactRef,
      "amend-ref-1" as ArtifactRef,
    );
    const auth = makeAuth("wrong-ref");
    expect(hasValidAuthorization(proposal, auth)).toBe(false);
  });
});

describe("amend", () => {
  it("requires explicit user authorization — unauthorized rejected", () => {
    const contract = makeContract();
    const proposed = [...ORIGINAL_STATEMENTS];
    const { result } = amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,     // requested auth ref
      makeAuth("wrong-ref"),             // actual auth has different ref
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejectedBy).toBe("POLICY");
      expect(result.rejectionReason).toContain("authorization");
    }
  });

  it("increments contract version on approval", () => {
    const contract = makeContract();
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-4", text: "New req", provenance: "explicit-user", strength: "soft" },
    ];
    const { result, newContract } = amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      makeAuth("auth-ref-1"),
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.contractVersion).toBe(2);
    }
    expect(newContract).toBeDefined();
    expect(newContract!.version).toBe(2);
  });

  it("rejects hard-requirement weakening", () => {
    const contract = makeContract();
    const proposed = ORIGINAL_STATEMENTS.map((s) =>
      s.id === "req-1" ? { ...s, strength: "soft" as const } : s,
    );
    const { result } = amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      makeAuth("auth-ref-1"),
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejectionReason).toContain("req-1");
    }
  });

  it("new version is immutable", () => {
    const contract = makeContract();
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-4", text: "New", provenance: "explicit-user", strength: "soft" },
    ];
    const { newContract } = amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      makeAuth("auth-ref-1"),
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(newContract).toBeDefined();
    expect(isContractFrozen(newContract!)).toBe(true);
  });

  it("old contract remains immutable after amendment", () => {
    const contract = makeContract();
    const proposed = [
      ...ORIGINAL_STATEMENTS,
      { id: "req-4", text: "New", provenance: "explicit-user", strength: "soft" },
    ];
    amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      makeAuth("auth-ref-1"),
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(contract.version).toBe(1);
    expect(contract.statements).toHaveLength(3);
    expect(isContractFrozen(contract)).toBe(true);
  });

  it("amendment diff is correct", () => {
    const contract = makeContract();
    const proposed = [
      { id: "req-1", text: "Must handle 10k concurrent users", provenance: "explicit-user", strength: "hard" },
      { id: "req-2", text: "UI must be accessible", provenance: "explicit-user", strength: "hard" },
      { id: "req-4", text: "Support caching", provenance: "explicit-user", strength: "soft" },
    ];
    const { newContract } = amend(
      contract,
      proposed,
      "USER",
      "auth-ref-1" as ArtifactRef,
      makeAuth("auth-ref-1"),
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(newContract!.statements).toHaveLength(3);
    const ids = newContract!.statements.map((s) => s.id);
    expect(ids).toContain("req-4");
    expect(ids).not.toContain("req-3");
  });

  it("unauthorized amendment rejected", () => {
    const contract = makeContract();
    const { result } = amend(
      contract,
      ORIGINAL_STATEMENTS,
      "KEYSTONE",
      "no-such-ref" as ArtifactRef,
      { authorizationRef: "also-wrong" as ArtifactRef, authorizer: "USER", authorizedAt: FROZEN_AT },
      "amend-ref-1" as ArtifactRef,
      "contract-ref-2" as ArtifactRef,
      "critic-1",
    );
    expect(result.approved).toBe(false);
  });
});
