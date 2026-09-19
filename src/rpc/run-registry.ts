// RunRegistry — maps pi-subagents runId ⇄ Keystone AssignmentId,
// holding the Wave 1 RunRecord for each live run.

import type { AssignmentId, RunRecord } from "../domain/types.js";

export interface RunRegistration {
  runId: string;
  assignmentId: AssignmentId;
  record: RunRecord;
}

export class RunRegistry {
  private readonly byRunId = new Map<string, RunRegistration>();
  private readonly runIdByAssignment = new Map<string, string>();

  register(runId: string, assignmentId: AssignmentId, record: RunRecord): void {
    if (!runId) throw new Error("register requires a non-empty runId.");
    const existing = this.byRunId.get(runId);
    if (existing) this.runIdByAssignment.delete(existing.assignmentId as string);
    const staleRunId = this.runIdByAssignment.get(assignmentId as string);
    if (staleRunId !== undefined && staleRunId !== runId) this.byRunId.delete(staleRunId);
    this.byRunId.set(runId, { runId, assignmentId, record });
    this.runIdByAssignment.set(assignmentId as string, runId);
  }

  lookupByRunId(runId: string): RunRegistration | undefined {
    return this.byRunId.get(runId);
  }

  lookupByAssignmentId(assignmentId: AssignmentId): RunRegistration | undefined {
    const runId = this.runIdByAssignment.get(assignmentId as string);
    return runId === undefined ? undefined : this.byRunId.get(runId);
  }

  updateRecord(runId: string, record: RunRecord): boolean {
    const entry = this.byRunId.get(runId);
    if (!entry) return false;
    entry.record = record;
    return true;
  }

  removeByRunId(runId: string): boolean {
    const entry = this.byRunId.get(runId);
    if (!entry) return false;
    this.byRunId.delete(runId);
    if (this.runIdByAssignment.get(entry.assignmentId as string) === runId) {
      this.runIdByAssignment.delete(entry.assignmentId as string);
    }
    return true;
  }

  clear(): void {
    this.byRunId.clear();
    this.runIdByAssignment.clear();
  }

  get size(): number {
    return this.byRunId.size;
  }
}
