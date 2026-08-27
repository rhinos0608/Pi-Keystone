import { describe, it, expect } from "vitest";
import { computeFindingFingerprint, sameFinding } from "../../src/findings/fingerprint.js";

describe("computeFindingFingerprint", () => {
  it("produces same fingerprint for same claim and targets", () => {
    const fp1 = computeFindingFingerprint("auth bug in login", ["src/auth.ts", "src/login.ts"]);
    const fp2 = computeFindingFingerprint("auth bug in login", ["src/auth.ts", "src/login.ts"]);
    expect(fp1).toBe(fp2);
  });

  it("is 64 hex characters (SHA-256)", () => {
    const fp = computeFindingFingerprint("test claim", ["entity"]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different claim → different fingerprint", () => {
    const fp1 = computeFindingFingerprint("claim A", ["entity"]);
    const fp2 = computeFindingFingerprint("claim B", ["entity"]);
    expect(fp1).not.toBe(fp2);
  });

  it("different targets → different fingerprint", () => {
    const fp1 = computeFindingFingerprint("same claim", ["a.ts"]);
    const fp2 = computeFindingFingerprint("same claim", ["b.ts"]);
    expect(fp1).not.toBe(fp2);
  });

  it("is order-independent for target entities", () => {
    const fp1 = computeFindingFingerprint("claim", ["x.ts", "a.ts"]);
    const fp2 = computeFindingFingerprint("claim", ["a.ts", "x.ts"]);
    expect(fp1).toBe(fp2);
  });

  it("is case-insensitive for claim", () => {
    const fp1 = computeFindingFingerprint("Auth Bug", ["file.ts"]);
    const fp2 = computeFindingFingerprint("auth bug", ["file.ts"]);
    expect(fp1).toBe(fp2);
  });

  it("handles empty targets", () => {
    const fp = computeFindingFingerprint("orphan claim", []);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sameFinding", () => {
  it("returns true for identical fingerprints", () => {
    const fp = computeFindingFingerprint("test", ["file.ts"]);
    expect(sameFinding(fp, fp)).toBe(true);
  });

  it("returns false for different fingerprints", () => {
    const fp1 = computeFindingFingerprint("claim A", ["file.ts"]);
    const fp2 = computeFindingFingerprint("claim B", ["file.ts"]);
    expect(sameFinding(fp1, fp2)).toBe(false);
  });
});
