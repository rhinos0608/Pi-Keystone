import { describe, it, expect } from "vitest";
import type { ConvergenceHistory, ReviewCycleEntry } from "../../src/review/types.js";
import { checkProgress, reserveCap } from "../../src/review/convergence.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function cycle(overrides: Partial<ReviewCycleEntry> & { action: ReviewCycleEntry["action"] }): ReviewCycleEntry {
  return {
    cycleIndex: overrides.cycleIndex ?? 0,
    timestamp: overrides.timestamp ?? "2025-01-01T00:00:00Z",
    findingFingerprints: overrides.findingFingerprints ?? [],
    action: overrides.action,
  };
}

function history(cycles: ReviewCycleEntry[]): ConvergenceHistory {
  return { cycles };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("checkProgress", () => {
  it("returns CONVERGING for empty history", () => {
    const result = checkProgress(history([]));
    expect(result.status).toBe("CONVERGING");
    expect(result.reviewCycles).toBe(0);
    expect(result.repairCycles).toBe(0);
  });

  it("counts review and repair cycles correctly", () => {
    const h = history([
      cycle({ action: "review", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
      cycle({ action: "review", cycleIndex: 2 }),
    ]);
    const result = checkProgress(h);
    expect(result.reviewCycles).toBe(2);
    expect(result.repairCycles).toBe(1);
  });

  it("returns NO_PROGRESS for 2 consecutive same-fingerprint review cycles", () => {
    const h = history([
      cycle({ action: "review", findingFingerprints: ["fp-a", "fp-b"] }),
      cycle({ action: "review", findingFingerprints: ["fp-a", "fp-b"] }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("NO_PROGRESS");
  });

  it("returns CONVERGING when fingerprints differ between review cycles", () => {
    const h = history([
      cycle({ action: "review", findingFingerprints: ["fp-a"] }),
      cycle({ action: "repair" }),
      cycle({ action: "review", findingFingerprints: ["fp-c"] }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("CONVERGING");
  });

  it("returns REPAIR_LIMIT at 3 repair cycles", () => {
    const h = history([
      cycle({ action: "repair", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
      cycle({ action: "repair", cycleIndex: 2 }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("REPAIR_LIMIT");
    expect(result.repairCycles).toBe(3);
  });

  it("returns REVIEW_LIMIT at 5 review cycles", () => {
    const h = history([
      cycle({ action: "review", cycleIndex: 0 }),
      cycle({ action: "review", cycleIndex: 1 }),
      cycle({ action: "review", cycleIndex: 2 }),
      cycle({ action: "review", cycleIndex: 3 }),
      cycle({ action: "review", cycleIndex: 4 }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("REVIEW_LIMIT");
  });

  it("returns FINAL_AUDIT_LIMIT at 2 final-audit rounds", () => {
    const h = history([
      cycle({ action: "final_audit", cycleIndex: 0 }),
      cycle({ action: "final_audit", cycleIndex: 1 }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("FINAL_AUDIT_LIMIT");
    expect(result.finalAuditRounds).toBe(2);
  });

  it("returns TERMINAL_DISPATCH_LIMIT at 8 terminal dispatches", () => {
    const cycles: ReviewCycleEntry[] = Array.from({ length: 8 }, (_, i) =>
      cycle({ action: "terminal_dispatch", cycleIndex: i }),
    );
    const result = checkProgress(history(cycles));
    expect(result.status).toBe("TERMINAL_DISPATCH_LIMIT");
    expect(result.terminalDispatches).toBe(8);
  });

  it("caps take priority in order: terminal > final_audit > repair > review", () => {
    const h = history([
      cycle({ action: "repair", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
      cycle({ action: "repair", cycleIndex: 2 }),
      cycle({ action: "final_audit", cycleIndex: 3 }),
      cycle({ action: "final_audit", cycleIndex: 4 }),
    ]);
    const result = checkProgress(h);
    expect(result.status).toBe("FINAL_AUDIT_LIMIT");
  });
});

describe("reserveCap", () => {
  it("allows action on empty history", () => {
    const result = reserveCap(history([]), "review");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("blocks review when at cap (5 reviews)", () => {
    const h = history(
      Array.from({ length: 5 }, (_, i) => cycle({ action: "review", cycleIndex: i })),
    );
    const result = reserveCap(h, "review");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("review");
    expect(result.reason).toContain("5");
  });

  it("allows review at 4 reviews (one below cap)", () => {
    const h = history(
      Array.from({ length: 4 }, (_, i) => cycle({ action: "review", cycleIndex: i, findingFingerprints: [`fp-${i}`] })),
    );
    const result = reserveCap(h, "review");
    expect(result.allowed).toBe(true);
  });

  it("blocks repair when at cap (3 repairs)", () => {
    const h = history([
      cycle({ action: "repair", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
      cycle({ action: "repair", cycleIndex: 2 }),
    ]);
    const result = reserveCap(h, "repair");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("repair");
  });

  it("allows repair at 2 repairs", () => {
    const h = history([
      cycle({ action: "repair", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
    ]);
    const result = reserveCap(h, "repair");
    expect(result.allowed).toBe(true);
  });

  it("blocks final_audit when at cap (2 final audits)", () => {
    const h = history([
      cycle({ action: "final_audit", cycleIndex: 0 }),
      cycle({ action: "final_audit", cycleIndex: 1 }),
    ]);
    const result = reserveCap(h, "final_audit");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("final_audit");
  });

  it("blocks terminal_dispatch when at cap (8)", () => {
    const h = history(
      Array.from({ length: 8 }, (_, i) =>
        cycle({ action: "terminal_dispatch", cycleIndex: i }),
      ),
    );
    const result = reserveCap(h, "terminal_dispatch");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("terminal_dispatch");
  });

  it("different action types don't interfere", () => {
    // 3 repairs should not block adding a review
    const h = history([
      cycle({ action: "repair", cycleIndex: 0 }),
      cycle({ action: "repair", cycleIndex: 1 }),
      cycle({ action: "repair", cycleIndex: 2 }),
    ]);
    const result = reserveCap(h, "review");
    expect(result.allowed).toBe(true);
  });

  it("blocks review on same-fingerprint stall scenario", () => {
    // 2 reviews with same fingerprints → adding a 3rd review would stall
    const h = history([
      cycle({ action: "review", findingFingerprints: ["fp-a", "fp-b"] }),
      cycle({ action: "review", findingFingerprints: ["fp-a", "fp-b"] }),
    ]);
    const result = reserveCap(h, "review");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("NO_PROGRESS");
  });

  it("allows review when fingerprints differ", () => {
    const h = history([
      cycle({ action: "review", findingFingerprints: ["fp-a"] }),
      cycle({ action: "review", findingFingerprints: ["fp-b"] }),
    ]);
    const result = reserveCap(h, "review");
    expect(result.allowed).toBe(true);
  });
});
