// Phase-transition counters: how many times each state was entered.
// In-memory accumulation, flush to disk as JSONL. Crash-safe on flush.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

export type PhaseCount = {
  readonly phase: string;
  readonly count: number;
};

/**
 * In-memory phase-transition counter.
 * Tracks how many times each (goalId, phase) pair was entered.
 */
export class PhaseCounter {
  private counts = new Map<string, Map<string, number>>();

  /** Record one entry into `phase` for `goalId`. */
  enter(goalId: string, phase: string): void {
    let phases = this.counts.get(goalId);
    if (!phases) {
      phases = new Map();
      this.counts.set(goalId, phases);
    }
    phases.set(phase, (phases.get(phase) ?? 0) + 1);
  }

  /** Return counts for a goal. */
  snapshot(goalId: string): PhaseCount[] {
    const phases = this.counts.get(goalId);
    if (!phases) return [];
    return [...phases.entries()]
      .map(([phase, count]) => ({ phase, count }))
      .sort((a, b) => a.phase.localeCompare(b.phase));
  }

  /** Total transitions across all goals. */
  totalCount(): number {
    let total = 0;
    for (const phases of this.counts.values()) {
      for (const c of phases.values()) total += c;
    }
    return total;
  }

  /** Reset all counters. */
  clear(): void {
    this.counts.clear();
  }

  /**
   * Flush current state to a JSONL file (crash-safe: atomic write).
   * Each line: { goalId, phase, count }.
   */
  flush(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const lines: string[] = [];
    for (const [goalId, phases] of this.counts) {
      for (const [phase, count] of phases) {
        lines.push(JSON.stringify({ goalId, phase, count }));
      }
    }
    writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""), {
      flag: "w",
    });
  }

  /**
   * Load counters from a JSONL file, merging into current state.
   */
  load(filePath: string): void {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) return;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        goalId: string;
        phase: string;
        count: number;
      };
      let phases = this.counts.get(entry.goalId);
      if (!phases) {
        phases = new Map();
        this.counts.set(entry.goalId, phases);
      }
      phases.set(entry.phase, (phases.get(entry.phase) ?? 0) + entry.count);
    }
  }
}
