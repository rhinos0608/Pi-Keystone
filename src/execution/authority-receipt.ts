// Authority receipt — proves a read before a mutation.

// ─── Types ──────────────────────────────────────────────────────────────────

export type AuthorityReceipt = {
  toolCallId: string;
  resourceIds: string[];
  timestamp: number;
  sessionId: string;
};

// ─── In-memory store ────────────────────────────────────────────────────────

const receipts = new Map<string, AuthorityReceipt[]>();

function receiptsKey(sessionId: string): string {
  return sessionId;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Record a receipt for a read that completed (acquisition phase).
 */
export function recordReceipt(receipt: AuthorityReceipt): void {
  const key = receiptsKey(receipt.sessionId);
  const list = receipts.get(key) ?? [];
  list.push(receipt);
  receipts.set(key, list);
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
}
