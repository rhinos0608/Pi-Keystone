# Pi-Keystone

> Durable Pi goal-lifecycle extension and orchestration runtime. Keystone owns preparation, adaptive-depth confirmation, pi-subagents child spawning, mutation authority, recovery, evidence, review/audit, and completion gating. Pure dispatch builders remain public seams, but the production extension drives the lifecycle itself.

## Goal state machine

19 states defined in `src/domain/types.ts`. Transitions enforced by `src/domain/goal-record.ts`.

### States

| State | Category |
|---|---|
| `CREATED` | Initial |
| `PREPARING` | Prep |
| `RECONCILING` | Prep |
| `CONTRACT_REVIEW` | Prep |
| `READY` | Pre-execution |
| `EXECUTING` | Execution loop |
| `VERIFYING` | Execution loop |
| `REVIEWING` | Execution loop |
| `ADJUDICATING` | Execution loop |
| `REPAIRING` | Execution loop |
| `FINAL_AUDIT` | Execution loop |
| `COMPLETION_GATE` | Execution loop |
| `PAUSED` | Suspension |
| `CANCELLING` | Teardown |
| `DONE` | Terminal |
| `BLOCKED` | Terminal |
| `FAILED` | Terminal |
| `NON_CONVERGENT` | Terminal |
| `CANCELLED` | Terminal |

### Terminal states

`DONE`, `BLOCKED`, `FAILED`, `NON_CONVERGENT`, `CANCELLED` — no transitions out.

### Valid transitions (`TRANSITIONS` in `src/domain/goal-record.ts`)

```
CREATED         → PREPARING, BLOCKED, FAILED, CANCELLING
PREPARING       → RECONCILING, BLOCKED, FAILED, PAUSED, CANCELLING
RECONCILING     → PREPARING, CONTRACT_REVIEW, BLOCKED, FAILED
CONTRACT_REVIEW → READY, RECONCILING, BLOCKED, FAILED
READY           → EXECUTING, BLOCKED, FAILED, CANCELLING
EXECUTING       → VERIFYING, BLOCKED, FAILED, CANCELLING
VERIFYING       → REVIEWING, EXECUTING, REPAIRING, BLOCKED, FAILED
REVIEWING       → ADJUDICATING, FINAL_AUDIT, BLOCKED, FAILED
ADJUDICATING    → REPAIRING, REVIEWING, FINAL_AUDIT, BLOCKED, FAILED, NON_CONVERGENT
REPAIRING       → VERIFYING, NON_CONVERGENT, BLOCKED, FAILED
FINAL_AUDIT     → COMPLETION_GATE, ADJUDICATING, BLOCKED, FAILED, NON_CONVERGENT
COMPLETION_GATE → DONE, REPAIRING, PAUSED, BLOCKED, FAILED, CANCELLING
PAUSED          → RECONCILING, CANCELLING, FAILED
CANCELLING      → CANCELLED, FAILED
```

### Global transition rules

- Any nonterminal, non-`CANCELLING` state → `CANCELLING` (via `CancelRequested`)
- Any nonterminal, non-`CANCELLING` state → `PAUSED` (via `PauseRequested`)
- `CANCELLING` → only `CANCELLED` or `FAILED`
- Terminal states → no transitions

### Resumable states (after compaction)

`CREATED`, `PREPARING`, `RECONCILING`, `CONTRACT_REVIEW`, `READY`, `EXECUTING`, `VERIFYING`, `REVIEWING`, `ADJUDICATING`, `REPAIRING`, `FINAL_AUDIT`, `COMPLETION_GATE` — defined in `src/continuation.ts`.

Excluded from resume: `PAUSED`, `CANCELLING`, `DONE`, `BLOCKED`, `FAILED`, `NON_CONVERGENT`, `CANCELLED`.

---

## Leases

Three lease types govern concurrency. DriverLease and MutationLease use monotonic fencing tokens; SnapshotPinLease has no fencing token.

### Driver lease (`DriverLease` — `src/domain/types.ts`)

One per goal. Governs which session owns the goal lifecycle.

```
fencingToken: number   // monotonically increases per acquisition
acquiredAt: ISO8601
heartbeatAt: ISO8601
expiresAt: ISO8601
```

**Acquisition** (`src/runtime/driver.ts`):
- No active lease (missing or expired) → new lease, `fenceCounter++`
- Active lease, same session → heartbeat (extend expiry)
- Active lease, different session → rejected, no mutation

**Fencing**: Every event carrying `driverFence` is checked in `dispatchEvent()` (`src/runtime/lifecycle.ts`). Once fencing is active for a goal (an `activeDriverLease` exists or `driverFenceCounter > 0`), the check goes through `validateFencedEvent()` — the event token must equal the active lease's `fencingToken` and the lease must be unexpired; otherwise a `FenceError` is thrown and nothing persists. Goals that never acquired a lease keep a legacy counter check (`validateDriverFence()`: token `=== driverFenceCounter`) so pre-lease bootstrap events (fence 0) still dispatch. Leases persist via `DriverLeaseAcquired` / `DriverLeaseReleased` events (CAS-guarded `acquireDriverLeasePersisted` / `releaseDriverLeasePersisted` in `src/runtime/driver.ts`) — never bare object mutation. Default TTL: 60s.

**GoalRecord fields**: `activeDriverLease`, `driverFenceCounter`.

### Mutation lease (`MutationLease` — `src/domain/types.ts`)

One per goal (on GoalRecord). Governs per-assignment write authority.

```
fencingToken: number              // monotonically increasing persisted counter per canonical worktree (directory-lock guarded)
phase: "ACQUIRED" | "AUTHORITY_READY" | "MUTATING" | "SETTLING"
assignmentId: AssignmentId
sessionId: string
workerProcessIdentity: string     // pid + process-start key
canonicalWorkspaceRoot: string
allowedCanonicalPaths: string[]
baseDirtySignature: string
authorityReceiptRef?: ArtifactRef
inFlightToolCallId?: string
```

**Phase progression**: `ACQUIRED` → `AUTHORITY_READY` → `MUTATING` → `SETTLING`

- `ACQUIRED`: lease held, worker may read context (acquisition turn)
- `AUTHORITY_READY`: authority receipt recorded, mutation turn may proceed
- `MUTATING`: worker applying changes
- `SETTLING`: changes applied, awaiting confirmation

**Lease validation** (`src/execution/mutation-launcher.ts`): Only `ACQUIRED` and `AUTHORITY_READY` phases are launchable. Expired leases are rejected.

**GoalRecord fields**: `activeMutationLease`, `mutationFenceCounter`.

### Per-worktree mutation lease (`src/execution/mutation-lease.ts`)

Exclusive write lock per canonical worktree root. Authority is persisted at `${canonicalRoot}/.keystone-lease.json`; acquisition uses a cross-process directory lock plus atomic exclusive lease creation, and fencing tokens come from a persisted monotonic counter. The in-process map is only a cache. TTL defaults to 30s, heartbeats extend live leases, and corrupt lease/counter state fails closed. Provides `acquireLease`, `releaseLease`, `checkLease`, heartbeat, and phase progression.

### Snapshot pin lease (`SnapshotPinLease` — `src/domain/types.ts`)

Pins snapshot IDs to prevent GC during active work.

```
snapshotId: SnapshotId
purpose: "R0" | "CHECKPOINT" | "OPEN_FINDING" | "RN"
renewedAt: ISO8601
expiresAt: ISO8601
```

Managed by `src/store/snapshot-roots.ts`: `pinSnapshots()`, `unpinGoal()`, `getActiveRoots()`, `canGC()`.

---

## DAG-based assignment scheduling

`src/execution/scheduler.ts` — Kahn's algorithm topological sort.

- `resolveOrder(scheduled)` → `layers: AssignmentId[][]` — groups of assignments that can run in parallel
- `executeSchedule(scheduled, executor)` — runs layer-by-layer; each layer's assignments execute concurrently via `Promise.allSettled` (one throwing executor never loses sibling results, later layers still run). Result contract: `ok: true` only when every executor succeeded; any executor failure yields `ok: false` with partial results + per-assignment failures; unresolvable DAG yields `ok: false` with `errors`
- Error cases: `DUPLICATE_ID`, `UNKNOWN_DEPENDENCY`, `CYCLE_DETECTED`
- Scheduler is stateless, makes no reducer edits

---

## Convergence hard caps

`src/review/convergence.ts` — `checkProgress()` enforces these limits:

| Constant | Value | Status produced |
|---|---|---|
| `CAP_SAME_FINGERPRINT_CYCLES` | 2 | `NO_PROGRESS` |
| `CAP_REPAIR_CYCLES` | 3 | `REPAIR_LIMIT` |
| `CAP_REVIEW_CYCLES` | 5 | `REVIEW_LIMIT` |
| `CAP_FINAL_AUDIT_ROUNDS` | 2 | `FINAL_AUDIT_LIMIT` |
| `CAP_TERMINAL_DISPATCHES` | 8 | `TERMINAL_DISPATCH_LIMIT` |

**NO_PROGRESS / stall detection**: Two consecutive review cycles with identical sorted fingerprint sets → `NO_PROGRESS`. Checked via `hasSameFingerprintStall()`.

**Cap ordering**: Terminal dispatch → Final audit → Repair → Review → Same-fingerprint stall. Most specific checked first.

**`reserveCap()`**: Pre-flight check — call before dispatching an action. Blocks when `current + 1 > cap` (i.e. it allows reaching exactly the cap but rejects the next action that would exceed it). `checkProgress()` (used after the fact) detects when a cap has already been reached (`>=` comparisons) and returns a limit status. These are two different functions with different semantics — `reserveCap` is preventive, `checkProgress` is retrospective.

**`ConvergenceLimitReached` event**: Active production behavior. Repair/final-audit convergence checks dispatch it when their bounded retry limits are exhausted, transitioning the goal to `NON_CONVERGENT` with an evidence artifact. `checkProgress()` and cap helpers remain the reusable policy primitives.

---

## Branded ID conventions

All defined in `src/domain/types.ts`. String-wrapped branded types — opaque, structurally distinct from plain strings.

| Type | Underlying | Purpose |
|---|---|---|
| `GoalId` | UUIDv7 | Goal identity |
| `SnapshotId` | sha256 manifest | Snapshot identity |
| `ArtifactRef` | sha256 CAS ref | Artifact pointer |
| `FindingId` | string | Finding identity |
| `AssignmentId` | string | Assignment identity |
| `ISO8601` | string | Timestamp |

**Rules**: Never concatenate branded IDs. Never compare a branded ID with a plain string. Cast only at boundaries (e.g. `as GoalId`). Types enforced at compile time via `readonly __brand` phantom field.

---

## Reducer / store ownership boundaries

### GoalStore (`src/store/goal-store.ts`)

Owns persistence. Atomic JSON files via tmp+rename. CRUD operations: `create`, `get`, `update`, `list`, `delete`.

`update()` accepts an optional `GoalReducer` (default: `goalReducer`). Applies reducer → validates transition → persists. Increments `recordVersion` (optimistic concurrency token). Generates `lastTransitionId`.

### GoalReducer (pure function)

`goalReducer(event, record) → record`. Applies a `GoalEvent` to a `GoalRecord`, returns new record. Defense-in-depth: also calls `validateTransition` internally. No I/O, no side effects.

Custom reducers can be injected via `GoalStore.update()` or `dispatchEvent()`.

### Lifecycle dispatch (`src/runtime/lifecycle.ts`)

`dispatchEvent(store, goalId, event, receiptLog, reducer?)` — the full pipeline:
1. Read current record from store
2. Validate driver fence (if event carries one)
3. Apply reducer → new record
4. Validate state transition
5. Persist
6. Append receipt log entry

`startGoal()` — creates record + dispatches `GoalStarted`.

### Key boundary

- **GoalStore** owns file I/O and persistence
- **goalReducer** is pure state transition logic
- **dispatchEvent** coordinates read → validate → reduce → persist → log
- **Context compiler, projections, convergence** are pure functions that read GoalRecord but never write it directly
- **Launchers** (`dispatchMutation`, `dispatchReadOnly`) are pure builders — they construct delegation configs, never call the store
- **Live execution paths** (`executeMutation`, `executeReadOnly`, `runExecutionFrontier`) are the store-writing exception: they persist runs and completion events via `dispatchEvent`/CAS. `runExecutionFrontier` is the orchestrator-owned runner (ExecutionStarted → scheduler → per-result completion dispatch)

---

## Execution boundary — CRITICAL

The production Pi extension is a self-driving lifecycle controller. `/goal create` prepares and persists a flow, the confirmation TUI approves adaptive depth, and release/run paths acquire the driver lease, execute the frontier through pi-subagents, verify, repair when required, review/audit, and evaluate the machine completion gate.

The `dispatchMutation`, `dispatchReadOnly`, and `dispatchRepair` APIs are still pure builders. They remain useful embedding/test seams, while the production controller composes them with the live execution paths.

### `dispatchRepair()` (`src/review/repair.ts`)

Builds the repair value object only. The controller owns repair child execution, durable run binding, mutation authority, post-repair verification, and convergence handling.

### `dispatchMutation()` / `executeMutation()`

`dispatchMutation()` builds the acquisition/mutation delegation. The live controller first runs a fresh read-only acquisition child to discover the exact write-set, acquires the per-worktree lease, captures S1, obtains conflict approval when needed, advances authority, then `executeMutation()` spawns the guarded mutation child and maintains the lease heartbeat.

### `dispatchReadOnly()` / `executeReadOnly()`

`dispatchReadOnly()` builds a read-only delegation. `executeReadOnly()` performs the real pi-subagents spawn and correlates `async-complete`; production uses it for frontier verifiers, mutation acquisition, review, and final-audit children.

**Remaining host-proof gap:** the host ladder proves real extension loading and RPC/extension-order compatibility, but several lifecycle ladder stages still use fake-child seams. A real pi-subagents mutation/restart/audit/tiny-feature `DONE` ladder is still the principal integration acceptance item.

---

## Supporting systems

### Tool policy (`src/execution/tool-policy.ts`)

Three modes: `read-only` (exact allowlist), `restricted` (explicit allowlist), and `mutation`. Mutation requires a structural permit bound to the active `leaseId + fencingToken`; textual mode denies bash, command-capable mutation modes allow only exact approved commands, and MCP tools require explicit lease allowlisting.

### Worker guard (`src/execution/worker-guard.ts`)

Parent-side worker guard handles orchestration bookkeeping, while `src/child/keystone-child-guard.ts` is the actual confinement boundary inside mutation children. The child guard re-reads the persisted live lease on every enforced tool call, blocks missing/expired/replaced authority, validates write targets against the exact acquired write-set, checks symlink containment, denies unknown tools fail-closed, and applies the bash/MCP policy carried by the launch-bound lease.

### Authority receipts (`src/execution/authority-receipt.ts`)

Proves read-before-write authority acquisition. Receipts retain a per-session in-memory index for fast coverage checks, but production also writes canonical receipt bytes into the controller CAS and stores the resulting `authorityReceiptRef` on the mutation lease. CAS-ref mismatches fail closed, so recovery/audit references survive process restart.

### Context compiler (`src/context/compiler.ts`)

Builds a `GoalContextView` per role (planner/worker/reviewer/orchestrator) with token-budget-aware item fitting.

### Findings ledger (`src/findings/ledger.ts`)

Append-only finding records with pagination. `MAX_FINDINGS`, `PAGE_SIZE`, `ROOT_PAGES`.

### Baseline (`src/baseline/`)

Content-sensitive S0/S1 worktree snapshots, repository package-script execution through the detected package manager, failure fingerprinting, pre-existing-damage ownership, and baseline comparison. Dirty/red workspaces are valid baselines; new post-execution fingerprints count as goal-owned regressions even when a check remains FAIL → FAIL.

### Contract (`src/contract/`)

Goal contracts with statement draft, critique, freezing, and amendment workflows.

### Observability (`src/observability/`)

Phase counters, receipt logging, and log redaction.

### Audit (`src/audit/`)

Final audit (two-auditor model) and completion gate evaluation.

### Recovery (`src/runtime/recovery.ts`)

Cancellation settlement, quarantine for indeterminate mutations, startup recovery for orphaned leases.

---

## Package structure

```
src/
  domain/          Types, goal record, event constructors
  store/           GoalStore, snapshot roots, active index, artifact store, atomic JSON
  runtime/         Driver, lifecycle, recovery, commands, feature-detect
  execution/       Scheduler, launchers, leases, worker guard, tool policy, authority receipts
  rpc/             SubagentRpcClient, run registry, pi-subagents bridge
  child/           Keystone child guard extension (loaded in mutation children)
  evidence/        Evidence graph, manifests
  context/         Compiler, projections, compaction, types
  planning/        Provisional plan, reconciliation, orchestrator
  contract/        Draft, critique, amendment, canonical, orchestrator
  baseline/        Runner, snapshot, worktree, compare, orchestrator, failure fingerprint
  findings/        Ledger, fingerprint, adjudication
  review/          Discovery, convergence, repair, types
  verification/    Verification run, criterion evaluator
  audit/           Final audit, completion gate
  observability/   Counters, receipts, redaction
  ui/              Progress, completion report, cancellation
```

---

## Verification

```
git diff --check     → clean
tsc --noEmit         → 0 errors
vitest run           → 65 passed files / 1054 passing tests, 1 opt-in live E2E skipped
vitest run test/host → 3 passed files / 16 passing tests, 1 opt-in live E2E skipped
npm run test:live-e2e → standard-depth real-child path reaches DONE; full-depth additionally requires an available configured oracle chain
```
