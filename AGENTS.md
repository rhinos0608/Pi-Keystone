# Pi-Keystone

> Orchestration toolkit for Pi goal lifecycle. NOT a self-running system — provides state machines, leases, scheduling primitives, and dispatch value objects. The caller owns session spawning, worker execution, and mutation authority tracking.

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

**Fencing**: Every event carrying `driverFence` must match the GoalRecord's `driverFenceCounter`. `dispatchEvent()` calls `validateDriverFence()` which does a simple `===` check against the counter — it does NOT call `validateFencedEvent()` or check active/expiry state on the lease. `validateFencedEvent()` (in `driver.ts`) is a separate function that validates against the active lease's `fencingToken` and checks lease expiry, but is not used by the dispatch pipeline. Default TTL: 60s.

**GoalRecord fields**: `activeDriverLease`, `driverFenceCounter`.

### Mutation lease (`MutationLease` — `src/domain/types.ts`)

One per goal (on GoalRecord). Governs per-assignment write authority.

```
fencingToken: number              // wall-clock timestamp (Date.now()), not a strictly monotonic counter
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

Exclusive write lock per worktree root. In-memory map keyed by the raw `root` string (not canonicalized) + disk persistence (`${root}/.keystone-lease.json`). TTL default: 30s. Stale leases auto-expired on next check. Provides `acquireLease`, `releaseLease`, `checkLease`.

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
- `executeSchedule(scheduled, executor)` — runs layer-by-layer; each layer's assignments execute concurrently via `Promise.all`
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

**`ConvergenceLimitReached` event**: Defined in `src/domain/events.ts` and handled in the goal reducer (sets state to `NON_CONVERGENT`), but no production code path currently dispatches it. The convergence system uses `checkProgress()` returning status codes instead. Treat the event constructor as plumbing for future use, not active runtime behavior.

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

---

## Execution boundary — CRITICAL

**This repo is an orchestration toolkit, not a self-running lifecycle.**

Three dispatch functions build delegation / dispatch VALUE OBJECTS only:

### `dispatchRepair()` (`src/review/repair.ts`)

Takes a `ReviewFinding`, `RepairAssignment`, previous findings, and `ImpactCone`. Returns a `RepairDispatch` value object containing `findingId`, `assignmentId`, `impactCone`, `previousFindings`. **Does not launch sessions, spawn workers, or execute repairs.**

### `dispatchMutation()` (`src/execution/mutation-launcher.ts`)

Takes an assignment descriptor, `ContextView`, and `MutationLease`. Returns a `MutationLaunchResult` with two `MutationTurn` objects (acquisition + mutation) and the validated lease. **Does not launch sessions or execute mutations.**

### `dispatchReadOnly()` (`src/execution/read-only-launcher.ts`)

Takes an assignment descriptor and `ContextView`. Returns a `ReadOnlyLaunchResult` with a `WorkerDelegation` config and null report. **Does not launch sessions or execute read-only work.**

### What the caller must do (currently: nothing in this codebase)

1. Call the dispatch function to get the value object
2. Spawn a fresh Pi session (or subagent)
3. Pass the delegation config to the session
4. Track authority progression (phase transitions on the mutation lease)
5. Capture the `WorkerReport` when the session completes
6. Dispatch the corresponding completion event (`AssignmentCompleted`, `RepairCompleted`, etc.) via `dispatchEvent()`

**`dispatchReadOnly` and `dispatchMutation`** are re-exported from `src/index.ts` for external consumers. **`dispatchRepair` is NOT exported** — it is internal to `src/review/repair.ts`.

---

## Supporting systems

### Tool policy (`src/execution/tool-policy.ts`)

Three modes: `read-only` (denies bash/write/edit/mcp), `restricted` (allowlist), `mutation` (requires permit token).

### Worker guard (`src/execution/worker-guard.ts`)

Intercepts tool-call events. Validates session ID, lease expiry, and that the lease root is non-empty for file-writing tools. Does NOT validate that the target path falls under the root — path extraction and validation happen upstream (per the code's own comment). Enforces tool policy at call time.

### Authority receipts (`src/execution/authority-receipt.ts`)

Proves a read completed before a mutation. In-memory store. `recordReceipt()` → `validateReceipts()` ensures all requested resource IDs were covered.

### Context compiler (`src/context/compiler.ts`)

Builds a `GoalContextView` per role (planner/worker/reviewer/orchestrator) with token-budget-aware item fitting.

### Findings ledger (`src/findings/ledger.ts`)

Append-only finding records with pagination. `MAX_FINDINGS`, `PAGE_SIZE`, `ROOT_PAGES`.

### Baseline (`src/baseline/`)

Git worktree state capture, check execution, failure fingerprinting, baseline comparison.

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
  context/         Compiler, projections, compaction, types
  planning/        Provisional plan, reconciliation, orchestrator
  contract/        Draft, critique, amendment, canonical, orchestrator
  baseline/        Runner, worktree, compare, orchestrator, failure fingerprint
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
tsc --noEmit         → 0 errors
vitest run           → 49 test files, 670 tests, all passing
```
