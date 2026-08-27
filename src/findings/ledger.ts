/**
 * FindingLedger — bounded, paged in-memory ledger for findings.
 *
 * Constraints:
 *   - Max 4096 findings total
 *   - 256 findings per page, 16 root pages
 *   - CRUD with status transitions
 *   - Same-fingerprint observations merge (newer context appended)
 *   - 24-observation cap per finding
 */

import { computeFindingFingerprint, type FindingFingerprint } from "./fingerprint.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

export type FindingStatus = "candidate" | "reproduced" | "confirmed" | "fixed" | "dismissed" | "superseded";

export type Observation = {
  /** ISO-8601 timestamp. */
  readonly at: string;
  /** Human-readable context of this observation. */
  readonly context: string;
  /** Optional source identifier (tool, session, etc). */
  readonly source?: string;
};

export type FindingRecord = {
  readonly id: string;
  readonly fingerprint: FindingFingerprint;
  readonly claim: string;
  readonly targetEntities: readonly string[];
  readonly severity: FindingSeverity;
  status: FindingStatus;
  readonly source: string;
  readonly filePath?: string;
  readonly observations: Observation[];
  readonly createdAt: string;
  updatedAt: string;
};

export type PageResult = {
  readonly page: number;
  readonly pageSize: number;
  readonly totalFindings: number;
  readonly totalPages: number;
  readonly items: readonly FindingRecord[];
};

// ─── Constants ────────────────────────────────────────────────────────────

export const MAX_FINDINGS = 4096;
export const PAGE_SIZE = 256;
export const ROOT_PAGES = 16; // 256 * 16 = 4096
export const MAX_OBSERVATIONS = 24;

// ─── Ledger ───────────────────────────────────────────────────────────────

export class FindingLedger {
  /** Ordered list of all findings (newest appended). */
  private findings: FindingRecord[] = [];
  /** fingerprint → index in findings array for O(1) lookup */
  private index = new Map<string, number>();
  private nextId = 1;

  /** Total number of findings. */
  get size(): number {
    return this.findings.length;
  }

  /** Whether the ledger is full. */
  get isFull(): boolean {
    return this.findings.length >= MAX_FINDINGS;
  }

  /** Total number of pages (may be 0). */
  get totalPages(): number {
    return this.findings.length === 0
      ? 0
      : Math.ceil(this.findings.length / PAGE_SIZE);
  }

  /**
   * Add a new finding, or merge if same fingerprint exists.
   * Returns the finding record.
   *
   * @throws if ledger is full AND this is a new fingerprint
   */
  add(input: {
    claim: string;
    targetEntities: readonly string[];
    severity: FindingSeverity;
    source: string;
    filePath?: string;
    observationContext: string;
    now?: string;
  }): FindingRecord {
    const now = input.now ?? new Date().toISOString();
    const fingerprint = computeFindingFingerprint(input.claim, input.targetEntities);

    // Check for existing finding with same fingerprint → merge
    const existingIdx = this.index.get(fingerprint);
    if (existingIdx !== undefined) {
      const existing = this.findings[existingIdx];
      // 24-observation cap: still escalate severity, but stop pushing observations
      if (existing.observations.length < MAX_OBSERVATIONS) {
        existing.observations.push({
          at: now,
          context: input.observationContext,
          source: input.source,
        });
      }
      existing.updatedAt = now;
      // Escalate severity if new observation is higher
      if (severityRank(input.severity) > severityRank(existing.severity)) {
        (existing as { severity: FindingSeverity }).severity = input.severity;
      }
      return existing;
    }

    // New fingerprint — check capacity
    if (this.isFull) {
      throw new Error(`FindingLedger full: ${MAX_FINDINGS} findings maximum`);
    }

    const id = `finding-${this.nextId++}`;
    const record: FindingRecord = {
      id,
      fingerprint,
      claim: input.claim,
      targetEntities: input.targetEntities,
      severity: input.severity,
      status: "candidate",
      source: input.source,
      filePath: input.filePath,
      observations: [{ at: now, context: input.observationContext, source: input.source }],
      createdAt: now,
      updatedAt: now,
    };

    this.findings.push(record);
    this.index.set(fingerprint, this.findings.length - 1);
    return record;
  }

  /**
   * Get a finding by ID.
   */
  get(id: string): FindingRecord | undefined {
    return this.findings.find((f) => f.id === id);
  }

  /**
   * Get a finding by fingerprint.
   */
  getByFingerprint(fp: FindingFingerprint): FindingRecord | undefined {
    const idx = this.index.get(fp);
    return idx !== undefined ? this.findings[idx] : undefined;
  }

  /**
   * Update finding status.
   * Valid transitions:
   *   candidate → reproduced | confirmed | dismissed | superseded
   *   reproduced → confirmed | dismissed | superseded
   *   confirmed → fixed | dismissed | superseded
   *   fixed → (terminal)
   *   dismissed → (terminal)
   *   superseded → (terminal)
   *
   * @throws on invalid transition
   */
  transitionStatus(
    id: string,
    newStatus: FindingStatus,
    now?: string,
  ): FindingRecord {
    const finding = this.findings.find((f) => f.id === id);
    if (!finding) {
      throw new Error(`Finding not found: ${id}`);
    }
    if (!isValidTransition(finding.status, newStatus)) {
      throw new Error(
        `Invalid transition: ${finding.status} → ${newStatus} for finding ${id}`,
      );
    }
    (finding as { status: FindingStatus }).status = newStatus;
    finding.updatedAt = now ?? new Date().toISOString();
    return finding;
  }

  /**
   * Remove a finding by ID — transitions to "dismissed" (no hard delete).
   */
  remove(id: string): boolean {
    const finding = this.findings.find((f) => f.id === id);
    if (!finding) return false;
    (finding as { status: FindingStatus }).status = "dismissed";
    finding.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * List findings, optionally filtered by status and severity.
   */
  list(opts?: {
    status?: FindingStatus;
    severity?: FindingSeverity;
    page?: number;
  }): PageResult {
    let filtered = this.findings;
    if (opts?.status) {
      filtered = filtered.filter((f) => f.status === opts.status);
    }
    if (opts?.severity) {
      filtered = filtered.filter((f) => f.severity === opts.severity);
    }

    const page = opts?.page ?? 0;
    const start = page * PAGE_SIZE;
    const items = filtered.slice(start, start + PAGE_SIZE);

    return {
      page,
      pageSize: PAGE_SIZE,
      totalFindings: filtered.length,
      totalPages: Math.ceil(filtered.length / PAGE_SIZE) || 0,
      items,
    };
  }

  /**
   * Get all findings matching a predicate.
   */
  where(predicate: (f: FindingRecord) => boolean): readonly FindingRecord[] {
    return this.findings.filter(predicate);
  }

  /**
   * Clear all findings.
   */
  clear(): void {
    this.findings = [];
    this.index.clear();
    this.nextId = 1;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  P3: 0,
  P2: 1,
  P1: 2,
  P0: 3,
};

function severityRank(s: FindingSeverity): number {
  return SEVERITY_ORDER[s];
}

const VALID_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  candidate: ["reproduced", "confirmed", "dismissed", "superseded"],
  reproduced: ["confirmed", "dismissed", "superseded"],
  confirmed: ["fixed", "dismissed", "superseded"],
  fixed: [],
  dismissed: [],
  superseded: [],
};

function isValidTransition(from: FindingStatus, to: FindingStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
