/// <reference types="node" />

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordReceipt,
  hashReceipt,
  canonicalReceiptBytes,
  validateReceipts,
  clearReceipts,
  listReceipts,
  _resetStore,
  type AuthorityReceipt,
} from "../../src/execution/authority-receipt.js";

beforeEach(() => {
  _resetStore();
});

const SESSION = "test-sess";

function makeReceipt(overrides: Partial<AuthorityReceipt> = {}): AuthorityReceipt {
  return {
    toolCallId: "tc-1",
    resourceIds: ["/src/a.ts"],
    timestamp: Date.now(),
    sessionId: SESSION,
    ...overrides,
  };
}

// ─── record + list ──────────────────────────────────────────────────────────

describe("recordReceipt / listReceipts", () => {
  it("records a receipt", () => {
    const r = makeReceipt();
    recordReceipt(r);
    expect(listReceipts(SESSION)).toHaveLength(1);
  });

  it("accumulates multiple receipts", () => {
    recordReceipt(makeReceipt({ toolCallId: "tc-1", resourceIds: ["/a.ts"] }));
    recordReceipt(makeReceipt({ toolCallId: "tc-2", resourceIds: ["/b.ts"] }));
    expect(listReceipts(SESSION)).toHaveLength(2);
  });

  it("persists canonical receipt bytes through an explicit CAS store", () => {
    const receipt = makeReceipt();
    const expected = hashReceipt(receipt);
    let stored = "";
    const store = {
      writeArtifact(content: Buffer | string) {
        stored = Buffer.isBuffer(content) ? content.toString("utf8") : content;
        return expected;
      },
      readArtifact() { return Buffer.from(stored, "utf8"); },
      hasArtifact() { return stored.length > 0; },
    };
    const ref = recordReceipt(receipt, store);
    expect(ref).toBe(expected);
    expect(stored).toBe(canonicalReceiptBytes(receipt));
  });
});

// ─── validate ───────────────────────────────────────────────────────────────

describe("validateReceipts", () => {
  it("valid when all resources covered", () => {
    recordReceipt(makeReceipt({ resourceIds: ["/a.ts", "/b.ts"] }));
    const result = validateReceipts(SESSION, ["/a.ts"]);
    expect(result.valid).toBe(true);
  });

  it("invalid when resource missing", () => {
    recordReceipt(makeReceipt({ resourceIds: ["/a.ts"] }));
    const result = validateReceipts(SESSION, ["/a.ts", "/missing.ts"]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.missing).toEqual(["/missing.ts"]);
    }
  });

  it("valid when no receipts needed", () => {
    const result = validateReceipts(SESSION, []);
    expect(result.valid).toBe(true);
  });

  it("covers resources from multiple receipts", () => {
    recordReceipt(makeReceipt({ toolCallId: "tc-1", resourceIds: ["/a.ts"] }));
    recordReceipt(makeReceipt({ toolCallId: "tc-2", resourceIds: ["/b.ts"] }));
    const result = validateReceipts(SESSION, ["/a.ts", "/b.ts"]);
    expect(result.valid).toBe(true);
  });
});

// ─── clear ──────────────────────────────────────────────────────────────────

describe("clearReceipts", () => {
  it("removes all receipts for session", () => {
    recordReceipt(makeReceipt());
    clearReceipts(SESSION);
    expect(listReceipts(SESSION)).toHaveLength(0);
  });

  it("does not affect other sessions", () => {
    recordReceipt(makeReceipt());
    recordReceipt(makeReceipt({ sessionId: "other-sess" }));
    clearReceipts(SESSION);
    expect(listReceipts(SESSION)).toHaveLength(0);
    expect(listReceipts("other-sess")).toHaveLength(1);
  });
});

// ─── isolation ──────────────────────────────────────────────────────────────

describe("session isolation", () => {
  it("different sessions do not share receipts", () => {
    recordReceipt(makeReceipt({ sessionId: "s1", resourceIds: ["/a.ts"] }));
    recordReceipt(makeReceipt({ sessionId: "s2", resourceIds: ["/b.ts"] }));
    expect(listReceipts("s1")).toHaveLength(1);
    expect(listReceipts("s2")).toHaveLength(1);
    expect(validateReceipts("s1", ["/b.ts"]).valid).toBe(false);
  });
});
