/** Production post-frontier lifecycle: verification -> review -> adjudication ->
 * evidence-backed dual final audit -> completion gate. */

import type { ArtifactRef, AssignmentId, FindingId, GoalId, RevisionRef } from "../domain/types.js";
import type { GoalStore } from "../store/goal-store.js";
import { dispatchEvent, type ReceiptLog } from "./lifecycle.js";
import type { ProvisionalPlan } from "../planning/provisional-plan.js";
import type { GoalContract } from "../contract/goal-contract.js";
import type { EcosystemBaseline } from "../baseline/types.js";
import { captureEcosystemBaseline } from "../baseline/orchestrator.js";
import { compareBaseline, compareEcosystemBaselines } from "../baseline/compare.js";
import { captureSnapshot } from "../baseline/snapshot.js";
import { adaptEcosystemToBaselineRecord, type GoalFlowRefs } from "./goal-flow.js";
import { createEvidenceGraph } from "../evidence/graph.js";
import { runFinalAudit, type AuditorSession } from "../audit/final-audit.js";
import { evaluateCompletion, type RequirementSourceRefs } from "../audit/completion-gate.js";
import type { ReviewFinding } from "../review/types.js";
import type { AssignmentIndex, AssignmentIndexEntry } from "../execution/assignment-index.js";
import type { Assignment } from "../execution/assignment.js";
import type { DispatchResult } from "../execution/scheduler.js";
import type { ReportEnvelope } from "../execution/report-envelope.js";

export type CompletionFlowEntry = {
  plan: ProvisionalPlan;
  contract: GoalContract;
  revision: RevisionRef;
  refs: GoalFlowRefs;
  baseline: EcosystemBaseline;
};

export type CompletionFlowDeps = {
  goalId: GoalId;
  store: GoalStore;
  receiptLog: ReceiptLog;
  entry: CompletionFlowEntry;
  frontierResults: readonly DispatchResult[];
  reportRefs: ReadonlyMap<string, ArtifactRef>;
  writeArtifact(content: string): ArtifactRef;
  /** Session that owns the persisted driver lease for this completion pass. */
  driverSessionId: string;
  executeReader(
    assignment: Assignment,
    context: { goalId: GoalId; root: string },
  ): Promise<ReportEnvelope>;
};

export type CompletionFlowResult =
  | { ok: true; reportRef: ArtifactRef }
  | { ok: false; reason: string; reportRef?: ArtifactRef };

export type FinalAuditorOutput = {
  outcome: "ACCEPTED" | "REJECTED";
  summary: string;
  claims: Array<{ nodeId: string; statement: string }>;
  evidenceChecklist: Array<{ artifactRef: string; description: string; present: boolean }>;
};

export const FINAL_AUDITOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "claims", "evidenceChecklist"],
  properties: {
    outcome: { type: "string", enum: ["ACCEPTED", "REJECTED"] },
    summary: { type: "string", minLength: 1 },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "statement"],
        properties: {
          nodeId: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
        },
      },
    },
    evidenceChecklist: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artifactRef", "description", "present"],
        properties: {
          artifactRef: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          present: { type: "boolean" },
        },
      },
    },
  },
};

export function parseFinalAuditorOutput(value: unknown): FinalAuditorOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.outcome !== "ACCEPTED" && row.outcome !== "REJECTED") return null;
  if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
  if (!Array.isArray(row.claims) || row.claims.length === 0) return null;
  if (!Array.isArray(row.evidenceChecklist) || row.evidenceChecklist.length === 0) return null;
  const claims: FinalAuditorOutput["claims"] = [];
  for (const claim of row.claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
    const c = claim as Record<string, unknown>;
    if (typeof c.nodeId !== "string" || c.nodeId.length === 0) return null;
    if (typeof c.statement !== "string" || c.statement.trim().length === 0) return null;
    claims.push({ nodeId: c.nodeId, statement: c.statement.trim() });
  }
  const evidenceChecklist: FinalAuditorOutput["evidenceChecklist"] = [];
  for (const item of row.evidenceChecklist) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.artifactRef !== "string" || e.artifactRef.length === 0) return null;
    if (typeof e.description !== "string" || e.description.trim().length === 0) return null;
    if (typeof e.present !== "boolean") return null;
    evidenceChecklist.push({
      artifactRef: e.artifactRef,
      description: e.description.trim(),
      present: e.present,
    });
  }
  return { outcome: row.outcome, summary: row.summary.trim(), claims, evidenceChecklist };
}

function reportSummary(report: ReportEnvelope): string {
  return report.findings.map((f) => f.message).join("\n").trim();
}

function assignmentId(value: string): AssignmentId {
  return value as AssignmentId;
}

function currentFence(store: GoalStore, goalId: GoalId, expectedSessionId: string): number {
  const record = store.get(goalId);
  if (!record) throw new Error(`Goal ${goalId} vanished during completion flow`);
  const active = record.activeDriverLease;
  if (!active) throw new Error(`completion-driver-lease-missing:${String(goalId)}`);
  if (active.sessionId !== expectedSessionId) {
    throw new Error(
      `completion-driver-owner-mismatch:${String(goalId)}:expected-${expectedSessionId}:actual-${active.sessionId}`,
    );
  }
  if (new Date(active.expiresAt).getTime() <= Date.now()) {
    throw new Error(`completion-driver-lease-expired:${String(goalId)}`);
  }
  return active.fencingToken;
}

function failTerminal(deps: CompletionFlowDeps, reason: string): CompletionFlowResult {
  let ref: ArtifactRef | undefined;
  try {
    ref = deps.writeArtifact(JSON.stringify({ stage: "post-frontier", reason, at: new Date().toISOString() }));
    dispatchEvent(
      deps.store,
      deps.goalId,
      { type: "FatalError", errorRef: ref, driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) },
      deps.receiptLog,
    );
  } catch {
    // Preserve the original failure reason even if terminalization itself is fenced/rejected.
  }
  return ref === undefined ? { ok: false, reason } : { ok: false, reason, reportRef: ref };
}

function makePostAssignment(
  id: string,
  role: "verifier" | "auditor",
  prompt: string,
  contractRef: ArtifactRef,
): Assignment {
  return {
    id: assignmentId(id),
    role,
    targetFiles: [],
    acceptanceCriteria: [prompt],
    contractRef,
  };
}

export type ReviewDecision = "ACCEPTED" | "ERROR" | "BLOCKER" | "WARNING" | "UNKNOWN";

export function parseReviewDecision(summary: string): ReviewDecision {
  // Models often prepend a heading or short reasoning before the explicit
  // protocol verdict. Read decision markers by line, preferring the last one
  // so a final verdict can supersede earlier discussion without accepting a
  // mere mention embedded in prose.
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^(ACCEPTED|ERROR|BLOCKER|WARN(?:ING)?)\b/i.exec(lines[i]!);
    if (!match) continue;
    const token = match[1]!.toUpperCase();
    if (token === "WARN") return "WARNING";
    return token as ReviewDecision;
  }
  return "UNKNOWN";
}

function reviewFindings(report: ReportEnvelope): ReviewFinding[] {
  const summary = reportSummary(report);
  if (!summary) return [];
  const decision = parseReviewDecision(summary);
  const severity: ReviewFinding["severity"] = decision === "BLOCKER"
    ? "blocker"
    : decision === "ERROR"
      ? "error"
      : decision === "WARNING"
        ? "warn"
        : "info";
  return [{
    id: `review-${report.runId}` as FindingId,
    severity,
    message: summary.slice(0, 4000),
    filePath: "",
    fingerprint: `review:${report.runId}`,
    source: report.sessionId,
    reportedAt: report.createdAt,
  }];
}

function auditOutcome(report: ReportEnvelope): AuditorSession["outcome"] {
  return parseFinalAuditorOutput(report.structuredOutput)?.outcome ?? "REJECTED";
}

function isReviewAccepted(report: ReportEnvelope, findings: readonly ReviewFinding[]): boolean {
  return parseReviewDecision(reportSummary(report)) === "ACCEPTED"
    && !findings.some((f) => f.severity === "blocker" || f.severity === "error");
}

/**
 * Map hard requirements to evidence assertions without positional guessing.
 * Generated contracts use the stable req-user-N -> crit-user-N identity. When
 * callers supply arbitrary explicit criterion IDs, there is no one-to-one
 * relation in the frozen schema, so each hard user requirement conservatively
 * depends on the complete set of explicit-user criterion assertions. That can
 * only make completion stricter: every explicit criterion must pass.
 */
export function requirementSourcesFromAssertions(
  contract: GoalContract,
  assertionsByCriterion: ReadonlyMap<string, readonly string[]>,
): RequirementSourceRefs[] {
  const aggregateExplicitAssertions = contract.completionCriteria
    .filter((criterion) => criterion.provenance === "explicit-user")
    .flatMap((criterion) => assertionsByCriterion.get(criterion.id) ?? []);
  return contract.requirements
    .filter((requirement) => requirement.strength === "hard")
    .map((requirement) => {
      const match = /^req-user-(\d+)$/.exec(requirement.id);
      const generatedCriterionId = match ? `crit-user-${match[1]}` : null;
      const hasGeneratedCriterion = generatedCriterionId !== null
        && contract.completionCriteria.some((criterion) => criterion.id === generatedCriterionId);
      return {
        requirementId: requirement.id,
        assertionIds: hasGeneratedCriterion
          ? [...(assertionsByCriterion.get(generatedCriterionId!) ?? [])]
          : [...aggregateExplicitAssertions],
      };
    });
}

/** Run the entire durable lifecycle after the execution frontier reaches VERIFYING. */
export async function runCompletionFlow(deps: CompletionFlowDeps): Promise<CompletionFlowResult> {
  const record = deps.store.get(deps.goalId);
  if (!record) return { ok: false, reason: "goal-vanished-before-verification" };
  if (record.state !== "VERIFYING") {
    return { ok: false, reason: `completion-flow-requires-VERIFYING:not-${record.state}` };
  }
  const root = record.workspace.canonicalRoot || record.workspace.requestedRoot;
  const depth = record.lifecycleDepth ?? "full";

  // 1. Re-run the exact discovered ecosystem and compare to S0. Pre-existing
  // red checks remain tolerated; only regressions/new failures reject.
  let afterBaseline: EcosystemBaseline;
  try {
    afterBaseline = await captureEcosystemBaseline(root);
  } catch (err) {
    return failTerminal(deps, `verification-capture-failed:${(err as Error)?.message ?? String(err)}`);
  }
  const beforeFrozen = adaptEcosystemToBaselineRecord(root, String(deps.goalId), deps.entry.baseline);
  const afterFrozen = adaptEcosystemToBaselineRecord(root, String(deps.goalId), afterBaseline);
  const delta = compareBaseline(beforeFrozen, afterFrozen);
  const ecosystemDelta = compareEcosystemBaselines(deps.entry.baseline, afterBaseline);
  let afterSnapshot;
  try {
    afterSnapshot = await captureSnapshot(root);
  } catch (err) {
    return failTerminal(deps, `verification-snapshot-failed:${(err as Error)?.message ?? String(err)}`);
  }
  // Status-only comparison deliberately tolerates pre-existing red checks, but
  // FAIL -> FAIL can still contain fresh damage. The fingerprint ledger owns
  // failures that appear only after execution, so those are regressions too.
  const ownedNewFailures = ecosystemDelta.fingerprints.ownedByGoal;
  const verificationAccepted =
    delta.regressions.length === 0 && ownedNewFailures.length === 0;
  const verificationRef = deps.writeArtifact(JSON.stringify({
    afterBaseline,
    delta,
    ecosystemDelta,
    snapshot: afterSnapshot,
  }));
  dispatchEvent(
    deps.store,
    deps.goalId,
    {
      type: "VerificationCompleted",
      runRef: verificationRef,
      accepted: verificationAccepted,
      driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
    },
    deps.receiptLog,
  );
  if (!verificationAccepted) {
    const statusRegressions = delta.regressions.map((r) => r.command);
    const fingerprintRegressions = ownedNewFailures.map((id) => `fingerprint:${id}`);
    return {
      ok: false,
      reason: `repair-requested:verification-regression:${[...statusRegressions, ...fingerprintRegressions].join(",")}`,
      reportRef: verificationRef,
    };
  }

  // 2. Build evidence chains. Prefer independent verifier reports over
  // implementer self-reports for each criterion, while preserving run/artifact identity.
  const graph = createEvidenceGraph();
  const assertionsByCriterion = new Map<string, string[]>();
  const planById = new Map(deps.entry.plan.assignments.map((a) => [a.id, a]));
  for (const criterion of deps.entry.contract.completionCriteria) {
    graph.addCriterion(criterion.id, criterion.text);
    graph.attachSnapshot(criterion.id, afterSnapshot.revision ?? afterSnapshot.dirtySignature);
    const matching = deps.frontierResults.filter((r) =>
      planById.get(String(r.assignmentId))?.criterionIds.includes(criterion.id),
    );
    const verifierMatching = matching.filter((r) => planById.get(String(r.assignmentId))?.role !== "implementation");
    // User-facing criteria require independent evidence. Never fall back to
    // implementer self-attestation when the verifier is missing or failed.
    // The deterministic no-regression criterion is separately backed below.
    const chosen = verifierMatching;
    const ids: string[] = [];
    if (chosen.length === 0) {
      ids.push(graph.attachAssertion(criterion.id, {
        verdict: "fail",
        reason: "No successful assignment report covers this criterion",
      }));
    } else {
      for (const result of chosen) {
        const ref = deps.reportRefs.get(String(result.assignmentId));
        const assertionId = graph.attachAssertion(criterion.id, {
          verdict: "pass",
          reason: reportSummary(result.report) || `successful ${String(result.assignmentId)} run`,
          evidenceRefs: ref ? [String(ref)] : [],
        });
        if (ref) graph.attachArtifact(assertionId, String(ref));
        graph.attachRun(assertionId, { runId: result.report.runId, status: result.report.status });
        ids.push(assertionId);
      }
    }
    if (criterion.id === "crit-no-regression") {
      const assertionId = graph.attachAssertion(criterion.id, {
        verdict: "pass",
        reason: `Baseline comparison found ${delta.regressions.length} regressions`,
        evidenceRefs: [String(verificationRef)],
      });
      graph.attachArtifact(assertionId, String(verificationRef));
      ids.push(assertionId);
    }
    assertionsByCriterion.set(criterion.id, ids);
  }
  const manifest = graph.manifestFor(deps.entry.contract.completionCriteria.map((c) => c.id));
  if (manifest.coverage.uncovered.length > 0) {
    return failTerminal(deps, `evidence-incomplete:${manifest.coverage.uncovered.join(",")}`);
  }
  const manifestRef = deps.writeArtifact(JSON.stringify(manifest));

  // Map hard user requirements to evidence. Generated contracts retain
  // one-to-one identity; arbitrary explicit criterion IDs conservatively bind
  // every hard requirement to the full explicit criterion set.
  const requirementSources = requirementSourcesFromAssertions(
    deps.entry.contract,
    assertionsByCriterion,
  );

  const finishShortPath = (
    policy: "verification-only" | "single-review",
    findings: readonly ReviewFinding[],
    reviewAccepted?: boolean,
  ): CompletionFlowResult => {
    const routeRef = deps.writeArtifact(JSON.stringify({
      depth,
      policy,
      from: deps.store.get(deps.goalId)?.state,
      verificationRef,
      manifestRef,
      at: new Date().toISOString(),
    }));
    dispatchEvent(
      deps.store,
      deps.goalId,
      {
        type: "LifecycleRerouted",
        to: "COMPLETION_GATE",
        depth,
        reasonRef: routeRef,
        driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
      },
      deps.receiptLog,
    );
    const gate = evaluateCompletion({
      contract: deps.entry.contract,
      verification: { passed: verificationAccepted, details: `${delta.regressions.length} regression(s)` },
      findings,
      auditPolicy: policy,
      ...(reviewAccepted === undefined ? {} : { reviewAccepted }),
      evidenceManifest: manifest,
      requirementSources,
    });
    const completionRef = deps.writeArtifact(JSON.stringify({
      gate,
      depth,
      policy,
      manifestRef,
      verificationRef,
      routeRef,
    }));
    dispatchEvent(
      deps.store,
      deps.goalId,
      {
        type: "CompletionEvaluated",
        reportRef: completionRef,
        accepted: gate.status === "DONE",
        driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
      },
      deps.receiptLog,
    );
    if (gate.status === "REPAIRING") {
      return { ok: false, reason: `repair-requested:${gate.summary}`, reportRef: completionRef };
    }
    if (gate.status === "BLOCKED") {
      dispatchEvent(
        deps.store, deps.goalId,
        { type: "BlockDeclared", blockerRefs: [completionRef], driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) },
        deps.receiptLog,
      );
      return { ok: false, reason: `completion-gate-BLOCKED:${gate.summary}`, reportRef: completionRef };
    }
    if (gate.status === "FAILED") return failTerminal(deps, `completion-gate-FAILED:${gate.summary}`);
    return { ok: true, reportRef: completionRef };
  };

  if (depth === "quick") {
    return finishShortPath("verification-only", []);
  }

  // 3. Fresh review child over the evidence manifest and requested outcome.
  const reviewerPrompt = [
    `Review goal ${String(deps.goalId)} after successful execution and verification.`,
    `User task: ${record.userTask}`,
    `Evidence manifest: ${JSON.stringify(manifest)}`,
    "Report ERROR: <reason> for a concrete repairable defect. Use BLOCKER: <reason> only when repair cannot safely proceed. Otherwise report ACCEPTED: <summary>.",
  ].join("\n");
  let reviewReport: ReportEnvelope;
  try {
    reviewReport = await deps.executeReader(
      makePostAssignment(`review-${String(deps.goalId)}`, "verifier", reviewerPrompt, deps.entry.refs.contractRef),
      { goalId: deps.goalId, root },
    );
  } catch (err) {
    return failTerminal(deps, `review-child-failed:${(err as Error)?.message ?? String(err)}`);
  }
  const findings = reviewFindings(reviewReport);
  const reviewRef = deps.writeArtifact(JSON.stringify(reviewReport));
  dispatchEvent(
    deps.store,
    deps.goalId,
    {
      type: "ReviewCompleted",
      reviewRef,
      candidateIds: findings.map((f) => f.id),
      driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
    },
    deps.receiptLog,
  );

  if (depth === "standard") {
    return finishShortPath("single-review", findings, isReviewAccepted(reviewReport, findings));
  }

  // 4. Deterministic adjudication: preserve every review finding in evidence;
  // blocker/error findings stay confirmed, informational findings are non-blocking.
  const decisions = findings.map((f) => ({
    findingId: f.id,
    decision: f.severity === "blocker" || f.severity === "error" ? "confirmed" : "dismissed",
    reason: f.message,
  }));
  const decisionRef = deps.writeArtifact(JSON.stringify(decisions));
  dispatchEvent(
    deps.store,
    deps.goalId,
    { type: "AdjudicationCompleted", decisionRefs: [decisionRef], driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) },
    deps.receiptLog,
  );

  // 5. Two genuinely fresh read-only auditor children. Their ReportEnvelope
  // session identities derive from child sessionPath (or unique run identity).
  const auditPrompt = [
    `Final audit for goal ${String(deps.goalId)}.`,
    `Contract: ${JSON.stringify(deps.entry.contract)}`,
    `Evidence manifest: ${JSON.stringify(manifest)}`,
    `Review findings: ${JSON.stringify(findings)}`,
    "Return the required structured audit object. outcome must be ACCEPTED only if every contract criterion is supported and no blocking defect remains.",
    "claims must cite exact evidence-manifest nodeIds. evidenceChecklist must enumerate the artifact refs you actually checked; use the raw ref after the artifact: node prefix and set present truthfully.",
  ].join("\n");
  let auditReports: [ReportEnvelope, ReportEnvelope];
  try {
    const a1 = await deps.executeReader(
      makePostAssignment(`audit-1-${String(deps.goalId)}`, "auditor", auditPrompt, deps.entry.refs.contractRef),
      { goalId: deps.goalId, root },
    );
    const a2 = await deps.executeReader(
      makePostAssignment(`audit-2-${String(deps.goalId)}`, "auditor", auditPrompt, deps.entry.refs.contractRef),
      { goalId: deps.goalId, root },
    );
    auditReports = [a1, a2];
  } catch (err) {
    return failTerminal(deps, `final-audit-child-failed:${(err as Error)?.message ?? String(err)}`);
  }

  const asAuditorSession = (report: ReportEnvelope): AuditorSession => {
    const output = parseFinalAuditorOutput(report.structuredOutput);
    return {
      sessionId: report.sessionId,
      runId: report.runId,
      outcome: auditOutcome(report),
      findings: reviewFindings(report),
      evidenceChecklist: output
        ? output.evidenceChecklist.map((item) => ({
            artifactRef: item.artifactRef as ArtifactRef,
            description: item.description,
            present: item.present,
          }))
        : [],
      claims: output?.claims ?? [],
    };
  };
  const auditorSessions: [AuditorSession, AuditorSession] = [
    asAuditorSession(auditReports[0]),
    asAuditorSession(auditReports[1]),
  ];

  const frontierIndexEntries: AssignmentIndexEntry[] = deps.frontierResults.map((r) => {
    const pa = planById.get(String(r.assignmentId));
    return {
      runId: r.report.runId,
      sessionId: r.report.sessionId,
      role: pa?.role === "implementation" ? "implementer" : "verifier",
      planEpoch: deps.entry.plan.planEpoch,
      mutationCapable: pa?.role === "implementation",
      appendedAt: String(r.report.createdAt),
    };
  });
  const auditorIndexEntries: AssignmentIndexEntry[] = auditReports.map((r) => ({
    runId: r.runId,
    sessionId: r.sessionId,
    role: "auditor",
    planEpoch: deps.entry.plan.planEpoch,
    mutationCapable: false,
    appendedAt: String(r.createdAt),
  }));
  const assignmentIndex: AssignmentIndex = { version: 1, entries: [...frontierIndexEntries, ...auditorIndexEntries] };
  const audit = runFinalAudit({
    goalId: String(deps.goalId),
    contract: deps.entry.contract,
    baselineRef: deps.entry.refs.baselineRef,
    deltaRef: verificationRef,
    findings,
    snapshotRefs: [deps.entry.refs.snapshotRef],
    assignmentIndex,
    auditorSessions,
    manifest,
  });
  const auditRefs = auditReports.map((r) => deps.writeArtifact(JSON.stringify(r))) as [ArtifactRef, ArtifactRef];
  dispatchEvent(
    deps.store,
    deps.goalId,
    {
      type: "FinalAuditCompleted",
      auditRefs,
      accepted: audit.status === "DONE",
      driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
    },
    deps.receiptLog,
  );
  if (audit.status !== "DONE") {
    const afterAudit = deps.store.get(deps.goalId);
    if ((afterAudit?.finalAuditAttempts ?? 0) >= 2) {
      const evidenceRef = deps.writeArtifact(JSON.stringify({ stage: "final-audit", reason: audit.reason, attempts: afterAudit?.finalAuditAttempts ?? 0, at: new Date().toISOString() }));
      dispatchEvent(deps.store, deps.goalId, { type: "ConvergenceLimitReached", evidenceRef, driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) }, deps.receiptLog);
      return { ok: false, reason: `non-convergent:final-audit:${audit.reason}`, reportRef: evidenceRef };
    }
    const reasonRef = deps.writeArtifact(JSON.stringify({ stage: "final-audit", reason: audit.reason, auditRefs, at: new Date().toISOString() }));
    dispatchEvent(deps.store, deps.goalId, { type: "RepairRequested", reasonRef, driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) }, deps.receiptLog);
    return { ok: false, reason: `repair-requested:final-audit:${audit.reason}`, reportRef: reasonRef };
  }

  // 6. Machine completion gate. A DONE result is the only path to the DONE event.
  const gate = evaluateCompletion({
    contract: deps.entry.contract,
    verification: { passed: verificationAccepted, details: `${delta.regressions.length} regression(s)` },
    findings,
    audit,
    evidenceManifest: manifest,
    requirementSources,
  });
  const completionRef = deps.writeArtifact(JSON.stringify({ gate, manifestRef, verificationRef, auditRefs }));
  dispatchEvent(
    deps.store,
    deps.goalId,
    {
      type: "CompletionEvaluated",
      reportRef: completionRef,
      accepted: gate.status === "DONE",
      driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId),
    },
    deps.receiptLog,
  );
  if (gate.status === "REPAIRING") {
    return { ok: false, reason: `repair-requested:${gate.summary}`, reportRef: completionRef };
  }
  if (gate.status === "BLOCKED") {
    dispatchEvent(
      deps.store, deps.goalId,
      { type: "BlockDeclared", blockerRefs: [completionRef], driverFence: currentFence(deps.store, deps.goalId, deps.driverSessionId) },
      deps.receiptLog,
    );
    return { ok: false, reason: `completion-gate-BLOCKED:${gate.summary}`, reportRef: completionRef };
  }
  if (gate.status === "FAILED") return failTerminal(deps, `completion-gate-FAILED:${gate.summary}`);
  return { ok: true, reportRef: completionRef };
}
