/**
 * Evidence graph local types — Task 5 (Wave 2d).
 *
 * Kept local to src/evidence on purpose: other waves own domain/store,
 * so no branded domain types are extended here. Node IDs are plain
 * stable strings (`<kind>:<key>`) unique within one graph.
 */

export type EvidenceNodeKind =
  | "criterion"
  | "assertion"
  | "artifact"
  | "run"
  | "finding"
  | "snapshot-revision";

/** Verdict carried by an assertion node. Fail-closed: only "pass" satisfies. */
export type AssertionVerdict = "pass" | "fail" | "skipped";

export type EvidenceNode =
  | { readonly id: string; readonly kind: "criterion"; readonly criterionId: string; readonly text: string }
  | { readonly id: string; readonly kind: "assertion"; readonly verdict: AssertionVerdict; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | { readonly id: string; readonly kind: "artifact"; readonly artifactRef: string }
  | { readonly id: string; readonly kind: "run"; readonly runId: string; readonly status: string }
  | { readonly id: string; readonly kind: "finding"; readonly findingId: string }
  | { readonly id: string; readonly kind: "snapshot-revision"; readonly revision: string };

/** A single assertion with its linked leaf nodes, resolved for one criterion. */
export type ResolvedAssertion = {
  readonly id: string;
  readonly verdict: AssertionVerdict;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactIds: readonly string[];
  readonly runIds: readonly string[];
  readonly findingIds: readonly string[];
};

/** Resolved chain for one criterion: its assertions plus pinned snapshot revision. */
export type CriterionChain = {
  readonly criterionId: string;
  readonly criterionText: string;
  readonly assertions: readonly ResolvedAssertion[];
  readonly snapshotRevisionId: string | null;
};

/** Coverage over the criteria requested in `manifestFor`. */
export type CoverageSummary = {
  readonly total: number;
  readonly covered: number;
  /** Requested criterion IDs with no passing assertion. */
  readonly uncovered: readonly string[];
};

/**
 * Immutable view handed to auditors and the completion gate.
 * `nodeIds` is the full set of node IDs in the resolved chains —
 * auditor claims must reference only these IDs.
 */
export type EvidenceManifest = {
  readonly nodeIds: readonly string[];
  readonly chains: readonly CriterionChain[];
  readonly coverage: CoverageSummary;
};

/** Thrown by `manifestFor` for a criterion ID never added to the graph. */
export class UnknownCriterionError extends Error {
  readonly criterionId: string;
  constructor(criterionId: string) {
    super(`Unknown criterion: ${criterionId}`);
    this.name = "UnknownCriterionError";
    this.criterionId = criterionId;
  }
}

/** Used by the final audit for claims referencing IDs outside the manifest. */
export class UnknownEvidenceIdError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string) {
    super(`Unknown evidence ID: ${nodeId}`);
    this.name = "UnknownEvidenceIdError";
    this.nodeId = nodeId;
  }
}
