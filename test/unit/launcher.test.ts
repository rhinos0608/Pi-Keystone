import { describe, it } from "vitest";
import type { AssignmentId } from "../../src/domain/types.js";
import {
  dispatchReadOnly,
  READ_ONLY_POLICY,
  type ContextView,
} from "../../src/execution/read-only-launcher.js";
import {
  dispatchMutation,
  validateMutationLease,
  type MutationLaunchResult,
} from "../../src/execution/mutation-launcher.js";
import type { MutationLease } from "../../src/domain/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const ASSIGNMENT = {
  id: "asgn-001" as AssignmentId,
  description: "Fix the auth middleware bug",
  targetFiles: ["src/auth.ts"],
};

const CONTEXT: ContextView = {
  goalId: "goal-001",
  task: "Fix authentication",
  workspace: "/tmp/test",
  targetFiles: ["src/auth.ts"],
};

function makeLease(overrides: Partial<MutationLease> = {}): MutationLease {
  return {
    leaseId: "lease-001",
    fencingToken: 1,
    assignmentId: "asgn-001" as AssignmentId,
    sessionId: "sess-001",
    workerProcessIdentity: "pid-001",
    canonicalWorkspaceRoot: "/tmp/test",
    allowedCanonicalPaths: ["src/auth.ts"],
    baseDirtySignature: "sig-001",
    phase: "ACQUIRED",
    acquiredAt: iso() as any,
    heartbeatAt: iso() as any,
    expiresAt: iso(60_000) as any,
    ...overrides,
  };
}

// ─── Read-only launcher ─────────────────────────────────────────────────────

describe("dispatchReadOnly", () => {
  it("returns read-only policy in delegation", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.delegation.toolPolicy).toEqual(READ_ONLY_POLICY);
  });

  it("report starts null", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.report).toEqual(null);
  });

  it("carries assignment id and context", () => {
    const result = dispatchReadOnly(ASSIGNMENT, CONTEXT);
    expect(result.delegation.assignmentId).toEqual("asgn-001");
    expect(result.delegation.contextView.goalId).toEqual("goal-001");
    expect(result.delegation.task).toEqual(ASSIGNMENT.description);
  });

  it("read-only policy denies mutation tools", () => {
    // The policy kind is "read-only" which tool-policy enforces
    expect(READ_ONLY_POLICY.kind).toEqual("read-only");
  });

  it("throws on missing assignment id", () => {
    expect(() =>
      dispatchReadOnly({ ...ASSIGNMENT, id: "" as AssignmentId }, CONTEXT),
    ).toThrow("assignment.id required");
  });

  it("throws on missing goalId", () => {
    expect(() =>
      dispatchReadOnly(ASSIGNMENT, { ...CONTEXT, goalId: "" }),
    ).toThrow("contextView.goalId required");
  });

  it("throws on missing task", () => {
    expect(() =>
      dispatchReadOnly(ASSIGNMENT, { ...CONTEXT, task: "" }),
    ).toThrow("contextView.task required");
  });
});

// ─── Lease validation ───────────────────────────────────────────────────────

describe("validateMutationLease", () => {
  it("accepts valid ACQUIRED lease", () => {
    const lease = makeLease({ phase: "ACQUIRED" });
    expect(validateMutationLease(lease)).toEqual({ ok: true });
  });

  it("accepts valid AUTHORITY_READY lease", () => {
    const lease = makeLease({ phase: "AUTHORITY_READY" });
    expect(validateMutationLease(lease)).toEqual({ ok: true });
  });

  it("rejects expired lease", () => {
    const lease = makeLease({ expiresAt: iso(-1_000) as any });
    expect(validateMutationLease(lease)).toEqual({ ok: false, reason: "lease expired" });
  });

  it("rejects MUTATING phase lease", () => {
    const lease = makeLease({ phase: "MUTATING" });
    const result = validateMutationLease(lease);
    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.reason).toContain("MUTATING");
    }
  });

  it("rejects SETTLING phase lease", () => {
    const lease = makeLease({ phase: "SETTLING" });
    const result = validateMutationLease(lease);
    expect(result.ok).toEqual(false);
    if (!result.ok) {
      expect(result.reason).toContain("SETTLING");
    }
  });
});

// ─── Mutation launcher ──────────────────────────────────────────────────────

describe("dispatchMutation", () => {
  it("returns two turns: acquisition then mutation", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease());
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].phase).toEqual("acquisition");
    expect(result.turns[1].phase).toEqual("mutation");
  });

  it("acquisition turn uses read-only policy", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease());
    expect(result.turns[0].delegation.toolPolicy.kind).toEqual("read-only");
  });

  it("mutation turn uses mutation policy with lease permit", () => {
    const lease = makeLease({ leaseId: "lease-xyz" });
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, lease);
    const mutationPolicy = result.turns[1].delegation.toolPolicy;
    expect(mutationPolicy.kind).toEqual("mutation");
    expect(mutationPolicy.permitToken).toEqual("lease-xyz");
  });

  it("mutation requires valid lease", () => {
    const expired = makeLease({ expiresAt: iso(-1_000) as any });
    expect(() => dispatchMutation(ASSIGNMENT, CONTEXT, expired)).toThrow("lease expired");
  });

  it("mutation rejects lease for wrong assignment", () => {
    const lease = makeLease({
      assignmentId: "asgn-999" as AssignmentId,
    });
    expect(() => dispatchMutation(ASSIGNMENT, CONTEXT, lease)).toThrow(
      "lease assignment mismatch",
    );
  });

  it("report starts null", () => {
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, makeLease());
    expect(result.report).toEqual(null);
  });

  it("two-phase authority: acquisition always read-only regardless of lease phase", () => {
    const lease = makeLease({ phase: "AUTHORITY_READY" });
    const result = dispatchMutation(ASSIGNMENT, CONTEXT, lease);
    expect(result.turns[0].delegation.toolPolicy.kind).toEqual("read-only");
    expect(result.turns[1].delegation.toolPolicy.kind).toEqual("mutation");
  });

  it("throws on missing inputs", () => {
    const lease = makeLease();
    expect(() =>
      dispatchMutation({ ...ASSIGNMENT, id: "" as AssignmentId }, CONTEXT, lease),
    ).toThrow("assignment.id required");
  });
});
