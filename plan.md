# Keystone Pi Runtime Spine — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Keystone's state machine to real Pi children via pi-subagents RPC, repairing state/persistence/planning/completion defects so a tiny feature request reaches DONE end-to-end.

**Approach:** Keystone = durable orchestration/evidence controller (decides what must happen + what counts as proof). pi-subagents = child runtime (decides how children live/die). Pi host = extension host. Working tree = source of truth; mutations happen in place under a durable lease with a dirty-signature approval gate; exact write-set lease by default.

**Riskiest assumption:** pi-subagents RPC + session-scoped ceilings/required-child-extensions can express Keystone's per-assignment authority constraints (esp. extensionBindings transport of lease JSON into children, and required-child extension loading in detached children).

## Decisions to review

| Decision | Choice | Alternative | Late-change cost |
|---|---|---|---|
| Mutation location | User's working tree, in place | Isolated worktree + single fenced integration | High (touches lease, baseline, snapshot, approval) |
| Dirty-repo blocker | Collision with intended write-set only; not dirtiness per se | Any dirty repo blocks | Medium (approval gate shape) |
| Approval binding | dirtySignature + planEpoch + intendedWriteSet, stale on drift | Time-based approval | Low |
| Write-set strictness | Exact lease default; scoped only via explicit approval expansion | Scoped patterns default | Medium |
| Bash for mutation children | No arbitrary bash for `textual` mode; command-capable classes need separate policy | Unrestricted bash | Low now, painful later if wrong |
| Peer dep | `@earendil-works/pi-coding-agent` as `peerDependencies: "*"`; manifest key `"pi": { "extensions": [...] }`; `keywords: ["pi-package"]` | Keep `piConfig`/`pi>=0.84.1` | Low |

## Known unknowns

1. **Host-level test harness.** Real Pi load for integration tests: `pi -e ./ext.ts` (docs/extensions.md:100) plus RPC mode (`docs/rpc.md`) for noninteractive control. Default: tests spawn real `pi` subprocess in RPC mode with Keystone extension loaded; if RPC mode cannot trigger `/goal` command, pivot to a session_start bootstrap flag. Containment: in-process unit tests against `createKeystone()` always runnable regardless.
2. **Child authority transport.** Assume `extensionBindings` (spawn param, verified `src/extension/schemas.ts:260-366`) carries lease JSON to the child guard extension. Pivot: encode lease JSON in task text; guard parses. Verify at Task 6 with a live spawn test.
3. **Required-extensions one-shot.** `registerRequiredChildExtensions` throws if snapshot exists (must dispose first). Keystone registers once per session at `session_start`; re-registers after `session_shutdown`. Verified `src/shared/required-child-extensions.ts:68-76`.

## Global Constraints

- Every task ends: `tsc --noEmit` 0 errors + `vitest run` all pass.
- No commits, no stash/reset/checkout/restore/overwrite of user changes — hard invariant.
- Earendil Pi 0.85.1; core imports as peer deps.
- Verification commands run by host via `execFile` (no shell string).
- Extension factory: no background resources at load; defer to `session_start`, cleanup in `session_shutdown` (docs/extensions.md:222-224).
- Read-only = tool **allowlist**, never denylist.

## Audit status — 2026-09-19

The implementation has moved substantially beyond the original checkbox state. Current verification is `git diff --check` clean, `tsc --noEmit` clean, and **65 test files / 1,054 tests passing** with one opt-in live E2E test skipped by default. The host subset is **16 passing / 1 opt-in live E2E skipped**.

Implemented and verified: Tasks 1–8, including the thin public entrypoint (`src/index.ts` is now three lines), live launcher/packaging/ceiling work, and child-side enforcement. The audit also repaired content-sensitive baseline identity, malformed fencing-counter fail-closed behavior, persistent authority receipts, cancellation-vs-acquisition races, real structured auditor claims, new-failure detection on pre-existing-red repositories, and a flaky dual-order host harness lifetime bug.

One acceptance item remains:

1. **Task 9 dedicated real-child ladder:** the standard-depth live E2E now drives real pi-subagents scout/worker/reviewer children through mutation, verification, independent review, and `DONE` using the user's `settings.json` role chains with no per-run model pins. The older numbered host ladder still uses fake-child seams for several individual restart/recovery/guard/auditor stages, so those scenarios should still be converted to dedicated real-child tests. Full-depth live E2E reaches the oracle spawn path, but its latest run was externally blocked because every model in the configured oracle fallback chain was unavailable.

The checkboxes below now reflect implementation status, not the age of the original plan.

---

### Task 1 (Wave 1): Repair state model, persistence, fencing

**Outcome:** Goal state has explicit per-assignment/run states; VERIFYING is reached only when the required DAG frontier is terminal; dispatch fencing uses the active-lease validator; persistence is compare-and-swap; corruption is distinguished from missing.

**Files (owns):**
- Modify: `src/domain/types.ts`, `src/domain/events.ts`, `src/domain/goal-record.ts`
- Modify: `src/store/goal-store.ts`, `src/runtime/lifecycle.ts`, `src/runtime/driver.ts`
- Modify: `src/execution/scheduler.ts` (fail-fast `Promise.all` → collect sibling results), `src/execution/assignment-index.ts` (real atomic write via `atomic-json` path; corrupt index → explicit error, not silent empty)
- Modify: `src/runtime/recovery.ts` (persistent, audited transitions via `dispatchEvent`, not object mutation)
- Tests: `test/unit/goal-reducer.test.ts`, `test/unit/driver.test.ts`, `test/unit/goal-lifecycle` integration, `test/unit/scheduler.test.ts`, `test/unit/assignment-index` (or new)

**Interfaces:**
- Consumes: existing `TRANSITIONS` table, `GoalStore.update(recordVersion)`.
- Produces (later tasks rely on):
  - `AssignmentState = CREATED | ACQUIRED | EXECUTING | VERIFYING | COMPLETED | FAILED | CANCELLED` tracked per assignment on the GoalRecord (e.g. `assignmentStates: Record<AssignmentId, AssignmentState>` + `activeRuns: Record<AssignmentId, RunRecord>` where `RunRecord { runId, sessionId, status, startedAt, endedAt?, resultRef? }`).
  - `AssignmentCompleted` transitions only the assignment's state; goal → `VERIFYING` only when all assignments in the current plan epoch reach `COMPLETED`/`FAILED` terminal-frontier per scheduler DAG.
  - `GoalStore.update` requires `recordVersion` match (CAS): mismatch → typed `VersionConflictError`, no write, no version increment.
  - `GoalStore.get`: `ENOENT` → null ("missing"); parse/permission errors → typed `StoreCorruptionError` (caller decides), never silent null.
  - `dispatchEvent` fence check calls `validateFencedEvent()` (active lease + expiry + token), replacing bare `===` counter check.
  - Ignored/invalid events (reducer no-op or terminal-state rejection) are surfaced as typed results/dispatch errors; they must not create fake transitions or bump `recordVersion`.

**Checks:**
- Red: current tests passing `AssignmentCompleted` once and seeing goal jump to VERIFYING; CAS test writing with stale `recordVersion`.
- Green: goal stays EXECUTING while frontier non-terminal; stale CAS throws `VersionConflictError`; corrupt JSON file throws `StoreCorruptionError`; stale `driverFence` against expired lease rejected.

- [x] Implement assignment/run states + frontier-gated VERIFYING
- [x] Implement CAS persistence + corruption typing
- [x] Active-lease fencing in `dispatchEvent`; explicit invalid-event results
- [x] Scheduler sibling-result collection; atomic/corrupt-safe assignment-index; recovery via audited transitions
- [x] Run `tsc --noEmit && npx vitest run`; record result

### Task 2 (Wave 2a): SubagentRpcClient

**Outcome:** One Keystone component speaks pi-subagents RPC; nothing else touches `subagents:rpc:v1:*`.

**Files (owns):**
- Create: `src/rpc/subagent-rpc-client.ts`, `src/rpc/types.ts`
- Create: `src/rpc/run-registry.ts` (map `runId` ⇄ `AssignmentId`/assignment run records)
- Tests: `test/unit/subagent-rpc-client.test.ts` (in-process fake `pi.events` bus per `test/unit/rpc.test.ts:57-66` pattern of pi-subagents)

**Interfaces:**
- Consumes: `pi.events.on/emit` (in-process EventBus), envelope shapes from recon (`SubagentRpcRequestEnvelope` / reply union, `SUBAGENT_RPC_METHODS`).
- Produces:
  - `class SubagentRpcClient { waitReady(): Promise<void>; ping(): Promise<PingInfo>; spawn(params): Promise<SpawnResult>; status(id): Promise<StatusResult>; result(runId): Promise<ResultResult>; stop(id): Promise<StopResult>; resume(id, msg): Promise<ResumeResult>; steer(id, msg, mode?): Promise<SteerResult> }`
  - requestId generation: keystone-scoped prefix `keystone-<goalId8>-<n>` (no CRLF).
  - `onAsyncComplete(handler)` wrapping `subagent:async-complete` with payload `{ runId, results: [{agent,status,summary,index,artifactPath,sessionPath}] }`.
  - Only client allowed to emit on `subagents:rpc:v1:request`.

**Checks:**
- Green: fake-bus test — waitReady→ping→spawn→reply correlation→async-complete delivery; timeout on missing reply → typed `RpcTimeoutError`.

- [x] Implement client + run registry
- [x] Fake-bus unit tests pass
- [x] `tsc --noEmit && npx vitest run`; record result

### Task 3 (Wave 2b): Planning from userTask

**Outcome:** `runPlanning()` derives assignments from `goal.userTask` + baseline context (baseline = background/constraints), producing assignments tied to canonical contract criterion IDs; planEpoch never resets to 0 on revision.

**Files (owns):**
- Modify: `src/planning/provisional-plan.ts`, `src/planning/reconciliation.ts`, `src/planning/orchestrator.ts`
- Tests: `test/unit/provisional-plan.test.ts`, `test/unit/reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 1's assignment-state types; baseline record shape (recon of current baseline types).
- Produces:
  - `PlanInput = { userTask, goalId, baseline: BaselineRecord, contextBudget, contractCriteria: CriterionId[] }`.
  - Assignments carry `criterionIds: CriterionId[]` referencing **existing** contract criteria (fix `c-${taskName}` fabrication); planner may emit `a-verify` only when contract criteria demand it — planner emits implementation assignments for a red baseline; a-verify alone only when no code changes are needed and all criteria are verification-shaped.
  - Plan revisions bump `planEpoch + 1`, preserving prior epoch history.
  - Deterministic coverage check: every contract criterion must map to ≥1 assignment or the plan is rejected (`PlanCoverageError`) — decomposition may be heuristic, coverage validation is exact.

**Checks:**
- Red: healthy repo + userTask "add X" currently yields only a-verify.
- Green: implementation assignment produced referencing a real criterion ID; epoch increments.

- [x] Implement userTask-driven planning + coverage validation
- [x] Update tests; run `tsc --noEmit && npx vitest run`; record result

### Task 4 (Wave 2c): Mutation lease, snapshots, approval gate

**Outcome:** Cross-process-atomic mutation lease; S0/S1 git snapshots; collision-only approval gate bound to dirtySignature + planEpoch + write-set.

**Files (owns):**
- Rewrite: `src/execution/mutation-lease.ts` (atomic acquisition: atomic file create via lock-free rename/mkdir check — reuse `src/store/directory-lock.ts` or `atomic-json` conventions; stale-owner recovery; monotonic fencing from persisted counter)
- Create: `src/baseline/snapshot.ts` (S0/S1 capture: `git status --porcelain=v2`, staged/unstaged/untracked, HEAD, `dirtySignature` = hash of normalized status + content hashes of listed paths)
- Create: `src/execution/approval.ts` (`MutationApproval` type + validation: current dirtySignature === approval's, planEpoch match, actual write-set ⊆ intended, lease valid; on drift → back to reconciliation)
- Modify: `src/execution/mutation-launcher.ts` (launchable only with valid lease; `allowedCanonicalPaths` from acquisition write-set, not planner guess)
- Tests: `test/unit/mutation-lease.test.ts`, new `test/unit/snapshot.test.ts`, `test/unit/approval.test.ts`

**Interfaces:**
- Produces (Task 6 consumes):
  - `MutationLease` (Keystone canonical, single family): `{ leaseId, fencingToken, goalId, assignmentId, sessionId, canonicalWorkspaceRoot, allowedCanonicalPaths, baseRevision, baseDirtySignature, planEpoch, approvalRef?, acquiredAt, heartbeatAt, expiresAt, phase }`.
  - `captureSnapshot(root): Promise<WorkspaceSnapshot>`; `diffSnapshots(a,b)`; conflict matrix: dirty/untracked path ∩ intended write-set → `DirtyConflict`; staged hits reported distinctly.
  - `evaluateApproval(approval, currentSnapshot, planEpoch, writeSet): APPROVED | STALE | CONFLICT`.
- Never: stash/reset/checkout/restore — absent by construction.

**Checks:**
- Red: two `acquireLease` calls from simulated second process (separate in-process map cleared, same disk root) both succeed.
- Green: second acquire blocked; stale lease (TTL expired) auto-recovers; approval invalidated when dirtySignature drifts; no-overlap dirt proceeds without approval.

- [x] Rewrite lease (atomic, cross-process, fencing, heartbeat)
- [x] Snapshot capture + diff + conflict matrix
- [x] Approval gate + launcher integration
- [x] Tests; `tsc --noEmit && npx vitest run`; record result

### Task 5 (Wave 2d): Evidence graph + completion + final audit

**Outcome:** Criteria/requirements link to verification assertions, artifacts, runs, findings, snapshot revisions; completion predicate computed from real hard requirements; auditors receive evidence manifest and return claims against IDs.

**Files (owns):**
- Modify: `src/verification/verification-run.ts`, `src/verification/criterion-evaluator.ts`, `src/audit/final-audit.ts`, `src/audit/completion-gate.ts`, `src/ui/completion-report.ts`
- Create: `src/evidence/graph.ts` (evidence-node graph: criterion → assertions → artifacts/runs/findings/snapshot-revision)
- Tests: `test/unit/criterion-evaluator.test.ts`, `test/unit/final-audit.test.ts`, `test/unit/completion-gate.test.ts`, new `test/unit/evidence-graph.test.ts`

**Interfaces:**
- Consumes: Task 1 run records; Task 4 snapshot refs.
- Produces:
  - `EvidenceGraph { addCriterion, attachAssertion(criterionId, assertion), attachRun, attachFinding, attachSnapshot, manifestFor(criteria): EvidenceManifest }` — `EvidenceManifest` is the single input to each final auditor (no self-built checklists).
  - `HardRequirement` carries its own evaluation source (assertion refs); completion gate evaluates, `satisfied: false` hardcoded stub deleted.
  - `runFinalAudit(manifest, auditorRecords)` validates: each auditor record's claims reference manifest IDs; contract coverage proven by graph, not checklist re-derivation.

**Checks:**
- Red: goal with hard requirements currently completes with `satisfied:false` stub.
- Green: completion gate requires every hard requirement backed by a passing assertion chain; auditor claim referencing unknown manifest ID rejected.

- [x] Evidence graph + manifest
- [x] Completion gate from real requirements
- [x] Auditor manifest validation
- [x] Tests; `tsc --noEmit && npx vitest run`; record result

### Task 6 (Wave 2e): Baseline ecosystem discovery

**Outcome:** Baseline detects ecosystem/scripts/versions instead of hardcoded npx tsc/vitest/eslint; fingerprints, retry/flaky classification, content hashes implemented; baseline semantics = "user's real workspace at goal start" (dirty/red happily), forming the pre-existing damage ledger.

**Files (owns):**
- Modify: `src/baseline/runner.ts`, `src/baseline/compare.ts`, `src/baseline/failure-fingerprint.ts`, `src/baseline/orchestrator.ts`, `src/baseline/types.ts`
- Tests: `test/unit/baseline-runner.test.ts`, `test/unit/baseline-compare.test.ts`, `test/unit/failure-fingerprint.test.ts`

**Interfaces:**
- Produces:
  - `detectEcosystem(root): { scripts: {typecheck?, test?, lint?}, toolVersions: Record<string,string>, packageManager }` from package.json/lockfiles (npm/pnpm/yarn/bun; fallback cargo/go/pyproject markers later — YAGNI: JS/TS first).
  - Check executions via `execFile` with resolved local binaries (`node_modules/.bin`) and recorded versions; `UNAVAILABLE` when absent (never fabricate).
  - `FailureFingerprint { id, checkId, file, line?, diagnostic }` from parseable test/lint/tsc output; retries classified flaky.
  - `BaselineRecord = { revision, dirtySignature, worktree: {staged, modified, untracked}, checks: {typecheck,test?,lint?}, failureFingerprints[], contentHashes }` — dirty/red allowed and preserved.

**Checks:**
- Red: fixture project without eslint → currently tries npx eslint.
- Green: scripts detected from package.json; UNAVAILABLE recorded; 17 pre-existing failures recorded as fingerprints, not owned by goal.

- [x] Ecosystem detect + execFile checks
- [x] Fingerprints + retry/flaky + hashes
- [x] Tests; `tsc --noEmit && npx vitest run`; record result

### Task 7 (Wave 3a): Extension entrypoint + packaging + launchers live

**Outcome:** Keystone is a real Pi extension: `src/index.ts` = thin default-export factory registering `/goal` command + `session_start`/`session_shutdown`/`session_before_compact` hooks, delegating to `createKeystone()`. Launchers (`dispatchReadOnly`/`dispatchMutation`) gain an execution path that actually spawns via Task 2's client. `dispatchRepair` exported.

**Files (owns):**
- Modify: `src/index.ts` (thin factory), `src/execution/mutation-launcher.ts`, `src/execution/read-only-launcher.ts`, `src/review/repair.ts` (export), `src/runtime/commands.ts`
- Modify: `package.json` (remove `piConfig`/peer `pi`; add `keywords:["pi-package"]`, `"pi":{"extensions":["./src/index.ts"]}`, `peerDependencies: { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*" }`)
- Tests: `test/unit/commands.test.ts`, `test/unit/launcher.test.ts`

**Interfaces:**
- Consumes: `createKeystone()` engine (kept), `SubagentRpcClient`, Task 4 lease/approval.
- Produces:
  - `export default async function (pi: ExtensionAPI): Promise<void>` → registers `/goal <create|status|cancel|...>` command, `goal:tool` (ToolDefinition for host-side status query), lifecycle hooks; background resources only after `session_start`.
  - `executeReadOnly(delegation, client)` / `executeMutation(lease, delegation, client)` — actual spawn + async-complete correlation → `AssignmentCompleted` dispatch.
  - Capability ceilings registered per session at first spawn: readers/planners/auditors `allowedTools: [read, grep, find, ls]`.

**Checks:**
- Green: `pi -e ./src/index.ts` loads without error (or session_start hook fires in RPC-mode test); `/goal create` writes durable GoalStore record; read-only spawn returns assignment completion.

- [x] Packaging fix + thin factory — `src/index.ts` is a three-line public entrypoint delegating to `src/keystone-extension.ts`
- [x] Live execution path for both launchers
- [x] Ceilings + required-child-extension registration (path registration here; guard content in Task 8)
- [x] `tsc --noEmit && npx vitest run`; record result

### Task 8 (Wave 3b): Child-side enforcement

**Outcome:** Mutation child cannot write outside scope: Keystone child guard extension runs **inside** the child (required child extension), validates paths against lease JSON, rejects out-of-scope edit/write/bash; parent-side denylist duct tape deleted.

**Files (owns):**
- Create: `src/child/keystone-child-guard.ts` (standalone Pi extension file, absolute path registered as required child extension)
- Modify: `src/execution/worker-guard.ts` (reduce to parent-side receipt bookkeeping; remove pretense of path confinement), `src/execution/tool-policy.ts` (allowlist only)
- Tests: `test/unit/child-guard.test.ts`, `test/unit/tool-policy.test.ts`

**Interfaces:**
- Consumes: Task 4 lease (delivered to child via `extensionBindings`), ceiling registration (Task 7).
- Produces:
  - Guard extension: `tool_call` handler; for `edit`/`write` (and config-derived tools) resolve target path (from tool params), validate against `allowedCanonicalPaths` + workspace root; violations → `{block:true, reason}`. Bash denied for `textual` mutation mode; command-capable classes require explicit policy approval in lease.
  - Lease receipt: guard confirms authority at acquisition; unknown/expired lease → block all write tools.

**Checks:**
- Green: unit tests with fake `pi.events` blocking `write` to `../escape.ts` and permitting `allowedCanonicalPaths`; live spawn test verifying guard loads in child (from Task 9 harness).

- [x] Child guard extension + bindings transport
- [x] Parent-side policy cleanup
- [x] Tests; `tsc --noEmit && npx vitest run`; record result

### Task 9 (Wave 4): Integration ladder + cross-module fixes

**Outcome:** Host-level tests pass; cross-module breakage fixed.

**Files (owns):**
- Create: `test/host/*.test.ts` (host ladder), reuse `test/fixtures/pi-runtime.ts` as seam
- Modify: any cross-module fallout (single fixer pass, coordinated; no parallel edits)

**Ladder:**
1. Keystone loads as real Pi extension (`pi -e`, headless RPC mode)
2. `/goal create` writes durable state readable across process restart
3. RPC spawn launches real read-only child; completion event correlates to assignment
4. Parallel children don't prematurely advance goal (frontier gate)
5. Mutation child cannot write outside scope (guard live)
6. Kill/restart resumes correctly (recovery startup path)
7. Stale fence rejected with expired lease
8. Cancellation never claims rollback without evidence
9. Two genuinely fresh auditor children execute against evidence manifest
10. Tiny feature request reaches DONE end-to-end

**Checks:** full ladder green; `tsc --noEmit` 0; `vitest run` all pass.

- [ ] Host ladder tests — suite is green and standard live E2E reaches `DONE` with real children, but several numbered restart/recovery/guard/auditor stages still use fake-child seams
- [x] Cross-module fixes
- [ ] Full verification gate — diff-check/typecheck/full Vitest and standard live E2E are green; dedicated real-child ladder conversion remains, and full-depth live E2E needs an available configured oracle chain

---

## Small-defect sweep (fold into owning tasks)

- assignment-index atomicity + corrupt-index error → Task 1
- `launcherAppend` authorizes parent launcher identity not `entry.sessionId` → Task 7
- Scheduler sibling completion info → Task 1
- Criterion ID scheme `c-*` real references; no fabricated `c-${taskName}` → Task 3
- `planEpoch` reset → Task 3
- `satisfied: false` stub → Task 5
- In-memory authority-receipt store → make persistent artifact-backed (Task 4, receipt becomes `ArtifactRef`)
- Duplicate type families (MutationLease/Assignment/GoalStore/contract) → consolidate to domain types during Tasks 1/4; flag any remnant in report
