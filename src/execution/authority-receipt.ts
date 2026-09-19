// Authority receipt — proves a read before a mutation.
//
// Receipts live in a fast in-memory index (per-session) and are additionally
// content-hashed to a CAS artifact ref. When an artifact store is configured
// via `configureAuthorityReceiptStore`, the canonical receipt bytes are
// persisted under that ref, so receipts survive process restarts and can be
// cited as evidence (e.g. `MutationLease.authorityReceiptRef`).

import { createHash } from "node:crypto";
import type { ArtifactRef } from "../domain/types.js";
import type { ArtifactStore } from "../store/artifact-store.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type AuthorityReceipt = {
  toolCallId: string;
  resourceIds: string[];
  timestamp: number;
  sessionId: string;
  /** CAS ref of the canonical receipt bytes. Always computed on record. */
  artifactRef?: ArtifactRef;
};

export type ReceiptArtifactStore = Pick<ArtifactStore, "writeArtifact" | "readArtifact" | "hasArtifact">;

// ─── In-memory store ────────────────────────────────────────────────────────

const receipts = new Map<string, AuthorityReceipt[]>();

let receiptStore: ReceiptArtifactStore | null = null;

function receiptsKey(sessionId: string): string {
  return sessionId;
}

/** Canonical bytes for hashing/persistence: stable key order, sorted resources. */
export function canonicalReceiptBytes(receipt: AuthorityReceipt): string {
  return JSON.stringify({
    toolCallId: receipt.toolCallId,
    resourceIds: [...receipt.resourceIds].sort(),
    timestamp: receipt.timestamp,
    sessionId: receipt.sessionId,
  });
}

/** Content hash (sha256) of the canonical receipt bytes, as an ArtifactRef. */
export function hashReceipt(receipt: AuthorityReceipt): ArtifactRef {
  return createHash("sha256").update(canonicalReceiptBytes(receipt), "utf-8").digest("hex") as ArtifactRef;
}

/** Bind (or unbind with null) the CAS artifact store used for persistence. */
export function configureAuthorityReceiptStore(store: ReceiptArtifactStore | null): void {
  receiptStore = store;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Record a receipt for a read that completed (acquisition phase).
 * Returns the receipt's CAS artifact ref; persists the canonical bytes
 * through the configured store when one is bound.
 */
export function recordReceipt(
  receipt: AuthorityReceipt,
  storeOverride?: ReceiptArtifactStore,
): ArtifactRef {
  const ref = receipt.artifactRef ?? hashReceipt(receipt);
  receipt.artifactRef = ref;
  const store = storeOverride ?? receiptStore;
  if (store) {
    const persistedRef = store.writeArtifact(Buffer.from(canonicalReceiptBytes(receipt), "utf-8"));
    if (persistedRef !== ref) {
      throw new Error(`authority receipt CAS mismatch: expected ${ref}, persisted ${persistedRef}`);
    }
  }
  const key = receiptsKey(receipt.sessionId);
  const list = receipts.get(key) ?? [];
  list.push(receipt);
  receipts.set(key, list);
  return ref;
}

/** Read persisted receipt bytes by ref; null when no store bound or ref unknown. */
export function readReceiptArtifact(ref: ArtifactRef, storeOverride?: ReceiptArtifactStore): Buffer | null {
  const store = storeOverride ?? receiptStore;
  if (!store || !store.hasArtifact(ref)) return null;
  return store.readArtifact(ref);
}

/**
 * Validate that at least one receipt covers all requested resource IDs.
 * Returns { valid: true } or { valid: false, missing: [...] }.
 */
export function validateReceipts(
  sessionId: string,
  resourceIds: string[],
): { valid: true } | { valid: false; missing: string[] } {
  const list = receipts.get(receiptsKey(sessionId)) ?? [];
  const covered = new Set<string>();
  for (const r of list) {
    for (const id of r.resourceIds) {
      covered.add(id);
    }
  }
  const missing = resourceIds.filter((id) => !covered.has(id));
  if (missing.length === 0) {
    return { valid: true };
  }
  return { valid: false, missing };
}

/**
 * Clear all stored receipts for a session (e.g. on session end).
 */
export function clearReceipts(sessionId: string): void {
  receipts.delete(receiptsKey(sessionId));
}

/**
 * Returns all receipts for a session (for inspection / testing).
 */
export function listReceipts(sessionId: string): readonly AuthorityReceipt[] {
  return receipts.get(receiptsKey(sessionId)) ?? [];
}

/**
 * Reset the entire store. Test-only.
 */
export function _resetStore(): void {
  receipts.clear();
  receiptStore = null;
}
