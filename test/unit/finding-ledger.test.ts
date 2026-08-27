import { describe, it, expect } from "vitest";
import {
  FindingLedger,
  MAX_FINDINGS,
  MAX_OBSERVATIONS,
  PAGE_SIZE,
  ROOT_PAGES,
} from "../../src/findings/ledger.js";

const NOW = "2025-01-01T00:00:00.000Z";

function addFinding(
  ledger: FindingLedger,
  overrides?: { claim?: string; severity?: "P0" | "P1" | "P2" | "P3"; source?: string },
) {
  return ledger.add({
    claim: overrides?.claim ?? "test finding",
    targetEntities: [overrides?.claim ?? "test finding"],
    severity: overrides?.severity ?? "P2",
    source: overrides?.source ?? "test",
    observationContext: "test observation",
    now: NOW,
  });
}

describe("FindingLedger", () => {
  // ─── Capacity ─────────────────────────────────────────────────────

  it("has correct capacity constants", () => {
    expect(MAX_FINDINGS).toBe(4096);
    expect(PAGE_SIZE).toBe(256);
    expect(ROOT_PAGES).toBe(16);
    expect(PAGE_SIZE * ROOT_PAGES).toBe(MAX_FINDINGS);
    expect(MAX_OBSERVATIONS).toBe(24);
  });

  it("starts empty", () => {
    const ledger = new FindingLedger();
    expect(ledger.size).toBe(0);
    expect(ledger.isFull).toBe(false);
    expect(ledger.totalPages).toBe(0);
  });

  // ─── Add ──────────────────────────────────────────────────────────

  it("adds a finding and returns it", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    expect(f.id).toMatch(/^finding-/);
    expect(f.status).toBe("candidate");
    expect(f.observations).toHaveLength(1);
    expect(ledger.size).toBe(1);
  });

  it("deduplicates by fingerprint and merges observations", () => {
    const ledger = new FindingLedger();
    const f1 = ledger.add({
      claim: "auth bug",
      targetEntities: ["src/auth.ts"],
      severity: "P2",
      source: "tool-a",
      observationContext: "first observation",
      now: NOW,
    });
    const f2 = ledger.add({
      claim: "auth bug",
      targetEntities: ["src/auth.ts"],
      severity: "P0", // higher severity
      source: "tool-b",
      observationContext: "second observation",
      now: "2025-01-02T00:00:00.000Z",
    });
    expect(f1.id).toBe(f2.id); // same finding
    expect(f1.observations).toHaveLength(2);
    expect(f1.severity).toBe("P0"); // escalated
    expect(ledger.size).toBe(1);
  });

  it("caps observations at MAX_OBSERVATIONS (24)", () => {
    const ledger = new FindingLedger();
    // Add 25 observations for same fingerprint
    for (let i = 0; i < 25; i++) {
      ledger.add({
        claim: "repeated bug",
        targetEntities: ["entity"],
        severity: "P3",
        source: "test",
        observationContext: `obs-${i}`,
        now: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const findings = ledger.where((f) => f.claim === "repeated bug");
    expect(findings).toHaveLength(1);
    expect(findings[0].observations).toHaveLength(24); // capped, not 25
  });

  it("still escalates severity after observation cap reached", () => {
    const ledger = new FindingLedger();
    // Fill to cap
    for (let i = 0; i < 24; i++) {
      ledger.add({
        claim: "escalation test",
        targetEntities: ["entity"],
        severity: "P3",
        source: "test",
        observationContext: `obs-${i}`,
        now: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    // 25th observation — should cap obs but escalate severity
    ledger.add({
      claim: "escalation test",
      targetEntities: ["entity"],
      severity: "P0",
      source: "test",
      observationContext: "critical observation",
      now: "2025-01-01T00:01:00.000Z",
    });
    const finding = ledger.where((f) => f.claim === "escalation test")[0];
    expect(finding.observations).toHaveLength(24); // still capped
    expect(finding.severity).toBe("P0"); // escalated
  });

  it("throws when full and adding new fingerprint", () => {
    const ledger = new FindingLedger();
    // Fill to capacity
    for (let i = 0; i < MAX_FINDINGS; i++) {
      ledger.add({
        claim: `finding-${i}`,
        targetEntities: [`entity-${i}`],
        severity: "P3",
        source: "fill",
        observationContext: "fill",
        now: NOW,
      });
    }
    expect(ledger.isFull).toBe(true);
    expect(() =>
      ledger.add({
        claim: "overflow",
        targetEntities: ["overflow-entity"],
        severity: "P3",
        source: "fill",
        observationContext: "fill",
        now: NOW,
      }),
    ).toThrow("FindingLedger full");
  });

  it("allows adding when full if same fingerprint (merge)", () => {
    const ledger = new FindingLedger();
    for (let i = 0; i < MAX_FINDINGS; i++) {
      ledger.add({
        claim: `finding-${i}`,
        targetEntities: [`entity-${i}`],
        severity: "P3",
        source: "fill",
        observationContext: "fill",
        now: NOW,
      });
    }
    // Merge into existing
    const merged = ledger.add({
      claim: "finding-0",
      targetEntities: ["entity-0"],
      severity: "P3",
      source: "merge",
      observationContext: "merge observation",
      now: NOW,
    });
    expect(merged.observations).toHaveLength(2);
  });

  // ─── Get ──────────────────────────────────────────────────────────

  it("gets finding by ID", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger, { claim: "lookup test" });
    expect(ledger.get(f.id)).toBe(f);
    expect(ledger.get("nonexistent")).toBeUndefined();
  });

  it("gets finding by fingerprint", () => {
    const ledger = new FindingLedger();
    const f = ledger.add({
      claim: "fp lookup",
      targetEntities: ["entity"],
      severity: "P3",
      source: "test",
      observationContext: "test",
      now: NOW,
    });
    const found = ledger.getByFingerprint(f.fingerprint);
    expect(found?.id).toBe(f.id);
  });

  // ─── Status transitions ──────────────────────────────────────────

  it("transitions candidate → confirmed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    const updated = ledger.transitionStatus(f.id, "confirmed", NOW);
    expect(updated.status).toBe("confirmed");
  });

  it("transitions candidate → reproduced", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    const updated = ledger.transitionStatus(f.id, "reproduced", NOW);
    expect(updated.status).toBe("reproduced");
  });

  it("transitions candidate → dismissed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    const updated = ledger.transitionStatus(f.id, "dismissed", NOW);
    expect(updated.status).toBe("dismissed");
  });

  it("transitions candidate → superseded", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    const updated = ledger.transitionStatus(f.id, "superseded", NOW);
    expect(updated.status).toBe("superseded");
  });

  it("transitions confirmed → fixed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "confirmed", NOW);
    const updated = ledger.transitionStatus(f.id, "fixed", NOW);
    expect(updated.status).toBe("fixed");
  });

  it("transitions confirmed → dismissed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "confirmed", NOW);
    const updated = ledger.transitionStatus(f.id, "dismissed", NOW);
    expect(updated.status).toBe("dismissed");
  });

  it("transitions reproduced → confirmed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "reproduced", NOW);
    const updated = ledger.transitionStatus(f.id, "confirmed", NOW);
    expect(updated.status).toBe("confirmed");
  });

  it("rejects invalid transition dismissed → candidate", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "dismissed", NOW);
    expect(() => ledger.transitionStatus(f.id, "candidate", NOW)).toThrow("Invalid transition");
  });

  it("rejects invalid transition fixed → confirmed", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "confirmed", NOW);
    ledger.transitionStatus(f.id, "fixed", NOW);
    expect(() => ledger.transitionStatus(f.id, "confirmed", NOW)).toThrow("Invalid transition");
  });

  it("rejects invalid transition superseded → candidate", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    ledger.transitionStatus(f.id, "superseded", NOW);
    expect(() => ledger.transitionStatus(f.id, "candidate", NOW)).toThrow("Invalid transition");
  });

  it("throws for nonexistent finding", () => {
    const ledger = new FindingLedger();
    expect(() => ledger.transitionStatus("nonexistent", "confirmed")).toThrow("not found");
  });

  // ─── Remove (soft-delete → dismissed) ─────────────────────────────

  it("soft-deletes finding by ID (transitions to dismissed)", () => {
    const ledger = new FindingLedger();
    const f = addFinding(ledger);
    expect(ledger.remove(f.id)).toBe(true);
    expect(ledger.size).toBe(1); // still in ledger
    expect(ledger.get(f.id)?.status).toBe("dismissed");
  });

  it("returns false for nonexistent removal", () => {
    const ledger = new FindingLedger();
    expect(ledger.remove("nonexistent")).toBe(false);
  });

  it("index remains intact after soft-delete", () => {
    const ledger = new FindingLedger();
    const f1 = ledger.add({
      claim: "first",
      targetEntities: ["e1"],
      severity: "P3",
      source: "test",
      observationContext: "test",
      now: NOW,
    });
    const f2 = ledger.add({
      claim: "second",
      targetEntities: ["e2"],
      severity: "P3",
      source: "test",
      observationContext: "test",
      now: NOW,
    });
    ledger.remove(f1.id);
    expect(ledger.getByFingerprint(f2.fingerprint)?.id).toBe(f2.id);
    // Removed finding is still findable by ID (just dismissed)
    expect(ledger.get(f1.id)?.status).toBe("dismissed");
  });

  // ─── List / pagination ───────────────────────────────────────────

  it("lists findings with pagination", () => {
    const ledger = new FindingLedger();
    for (let i = 0; i < 300; i++) {
      ledger.add({
        claim: `item-${i}`,
        targetEntities: [`entity-${i}`],
        severity: "P3",
        source: "test",
        observationContext: "test",
        now: NOW,
      });
    }
    const page0 = ledger.list({ page: 0 });
    expect(page0.items).toHaveLength(PAGE_SIZE);
    expect(page0.totalFindings).toBe(300);
    expect(page0.totalPages).toBe(2);

    const page1 = ledger.list({ page: 1 });
    expect(page1.items).toHaveLength(44); // 300 - 256 = 44
  });

  it("filters by status", () => {
    const ledger = new FindingLedger();
    const f1 = addFinding(ledger, { claim: "candidate-one" });
    const f2 = addFinding(ledger, { claim: "confirmed-one" });
    ledger.transitionStatus(f2.id, "confirmed", NOW);
    const candidateFindings = ledger.list({ status: "candidate" });
    expect(candidateFindings.items).toHaveLength(1);
    expect(candidateFindings.items[0].id).toBe(f1.id);
  });

  it("filters by severity", () => {
    const ledger = new FindingLedger();
    addFinding(ledger, { severity: "P3" });
    addFinding(ledger, { severity: "P0" });
    const p0s = ledger.list({ severity: "P0" });
    expect(p0s.items).toHaveLength(1);
  });

  // ─── Where ────────────────────────────────────────────────────────

  it("filters with predicate", () => {
    const ledger = new FindingLedger();
    addFinding(ledger, { claim: "auth bug" });
    addFinding(ledger, { claim: "ui glitch" });
    const authFindings = ledger.where((f) => f.claim.includes("auth"));
    expect(authFindings).toHaveLength(1);
  });

  // ─── Clear ────────────────────────────────────────────────────────

  it("clears all findings", () => {
    const ledger = new FindingLedger();
    addFinding(ledger);
    addFinding(ledger);
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.totalPages).toBe(0);
  });
});
