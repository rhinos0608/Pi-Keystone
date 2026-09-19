/**
 * Evidence graph — Task 5 (Wave 2d).
 *
 * Links criteria to verification assertions, artifacts, runs, findings,
 * and snapshot revisions. `manifestFor` produces the immutable
 * EvidenceManifest that auditors and the completion gate consume.
 */

import type {
  AssertionVerdict,
  CriterionChain,
  EvidenceManifest,
  ResolvedAssertion,
} from "./types.js";
import { UnknownCriterionError } from "./types.js";

export type AssertionInput = {
  readonly verdict: AssertionVerdict;
  readonly reason?: string;
  readonly evidenceRefs?: readonly string[];
};

export type RunInput = {
  readonly runId: string;
  readonly status?: string;
};

export type EvidenceGraph = {
  /** Register a criterion node. Idempotent for the same ID. */
  addCriterion(criterionId: string, text?: string): string;
  /** Attach an assertion to a criterion; returns the stable assertion node ID. */
  attachAssertion(criterionId: string, assertion: AssertionInput): string;
  /** Link an artifact ref to an assertion; returns the artifact node ID. */
  attachArtifact(assertionId: string, artifactRef: string): string;
  /** Link a run record to an assertion; returns the run node ID. */
  attachRun(assertionId: string, run: RunInput): string;
  /** Link a finding to an assertion; returns the finding node ID. */
  attachFinding(assertionId: string, findingId: string): string;
  /** Pin a snapshot revision to a criterion; returns the snapshot node ID. */
  attachSnapshot(criterionId: string, revision: string): string;
  /** True when the graph holds a node with this ID. */
  hasNode(nodeId: string): boolean;
  /**
   * Resolve chains for the requested criteria. Throws
   * UnknownCriterionError for any ID never added via addCriterion.
   */
  manifestFor(criterionIds: readonly string[]): EvidenceManifest;
};

type AssertionRecord = {
  id: string;
  criterionId: string;
  verdict: AssertionVerdict;
  reason: string;
  evidenceRefs: string[];
  artifactIds: string[];
  runIds: string[];
  findingIds: string[];
};

export function createEvidenceGraph(): EvidenceGraph {
  const criterionText = new Map<string, string>();
  const criterionSnapshots = new Map<string, string>();
  const assertions = new Map<string, AssertionRecord>();
  const assertionSeq = new Map<string, number>();
  const nodes = new Set<string>();

  const criterionNodeId = (criterionId: string): string => `criterion:${criterionId}`;

  function addCriterion(criterionId: string, text = ""): string {
    if (!criterionText.has(criterionId)) {
      criterionText.set(criterionId, text);
      assertionSeq.set(criterionId, 0);
    } else if (text && !criterionText.get(criterionId)) {
      criterionText.set(criterionId, text);
    }
    const id = criterionNodeId(criterionId);
    nodes.add(id);
    return id;
  }

  function requireCriterion(criterionId: string): void {
    if (!criterionText.has(criterionId)) {
      throw new UnknownCriterionError(criterionId);
    }
  }

  function requireAssertion(assertionId: string): AssertionRecord {
    const record = assertions.get(assertionId);
    if (!record) {
      throw new Error(`Unknown assertion: ${assertionId}`);
    }
    return record;
  }

  function attachAssertion(criterionId: string, assertion: AssertionInput): string {
    requireCriterion(criterionId);
    const seq = (assertionSeq.get(criterionId) ?? 0) + 1;
    assertionSeq.set(criterionId, seq);
    const id = `assertion:${criterionId}:${seq}`;
    nodes.add(id);
    assertions.set(id, {
      id,
      criterionId,
      verdict: assertion.verdict,
      reason: assertion.reason ?? "",
      evidenceRefs: [...(assertion.evidenceRefs ?? [])],
      artifactIds: [],
      runIds: [],
      findingIds: [],
    });
    return id;
  }

  function attachArtifact(assertionId: string, artifactRef: string): string {
    const record = requireAssertion(assertionId);
    const id = `artifact:${artifactRef}`;
    nodes.add(id);
    if (!record.artifactIds.includes(id)) record.artifactIds.push(id);
    return id;
  }

  function attachRun(assertionId: string, run: RunInput): string {
    const record = requireAssertion(assertionId);
    const id = `run:${run.runId}`;
    nodes.add(id);
    if (!record.runIds.includes(id)) record.runIds.push(id);
    return id;
  }

  function attachFinding(assertionId: string, findingId: string): string {
    const record = requireAssertion(assertionId);
    const id = `finding:${findingId}`;
    nodes.add(id);
    if (!record.findingIds.includes(id)) record.findingIds.push(id);
    return id;
  }

  function attachSnapshot(criterionId: string, revision: string): string {
    requireCriterion(criterionId);
    const id = `snapshot:${criterionId}:${revision}`;
    nodes.add(id);
    criterionSnapshots.set(criterionId, id);
    return id;
  }

  function manifestFor(criterionIds: readonly string[]): EvidenceManifest {
    for (const id of criterionIds) {
      if (!criterionText.has(id)) {
        throw new UnknownCriterionError(id);
      }
    }
    const requested = [...new Set(criterionIds)];
    const chains: CriterionChain[] = requested.map((criterionId): CriterionChain => {
      const resolved: ResolvedAssertion[] = [...assertions.values()]
        .filter((a) => a.criterionId === criterionId)
        .map((a): ResolvedAssertion =>
          // Deep-frozen: every assertion object is immutable, not just the array.
          Object.freeze({
            id: a.id,
            verdict: a.verdict,
            reason: a.reason,
            evidenceRefs: Object.freeze([...a.evidenceRefs]) as readonly string[],
            artifactIds: Object.freeze([...a.artifactIds]) as readonly string[],
            runIds: Object.freeze([...a.runIds]) as readonly string[],
            findingIds: Object.freeze([...a.findingIds]) as readonly string[],
          }),
        );
      // Deep-frozen chain object: assertions array + chain record.
      return Object.freeze({
        criterionId,
        criterionText: criterionText.get(criterionId) ?? "",
        assertions: Object.freeze(resolved) as readonly ResolvedAssertion[],
        snapshotRevisionId: criterionSnapshots.get(criterionId) ?? null,
      });
    });
    const nodeIds: string[] = [];
    for (const chain of chains) {
      nodeIds.push(criterionNodeId(chain.criterionId));
      if (chain.snapshotRevisionId) nodeIds.push(chain.snapshotRevisionId);
      for (const a of chain.assertions) {
        nodeIds.push(a.id, ...a.artifactIds, ...a.runIds, ...a.findingIds);
      }
    }
    // Conflict policy: a criterion is covered only when at least one
    // assertion passes AND no assertion fails. Any failing assertion vetoes
    // coverage (fail-closed): pass+fail -> uncovered/failing. A lone pass
    // covers; no assertions, only skips, or any fail leaves it uncovered.
    const uncovered = chains
      .filter(
        (c) => !c.assertions.some((a) => a.verdict === "pass") || c.assertions.some((a) => a.verdict === "fail"),
      )
      .map((c) => c.criterionId);
    return Object.freeze({
      nodeIds: Object.freeze([...nodeIds]) as readonly string[],
      chains: Object.freeze(chains) as readonly CriterionChain[],
      coverage: Object.freeze({
        total: chains.length,
        covered: chains.length - uncovered.length,
        uncovered: Object.freeze([...uncovered]) as readonly string[],
      }),
    });
  }

  return {
    addCriterion,
    attachAssertion,
    attachArtifact,
    attachRun,
    attachFinding,
    attachSnapshot,
    hasNode: (nodeId: string): boolean => nodes.has(nodeId),
    manifestFor,
  };
}
