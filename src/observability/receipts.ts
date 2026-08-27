// Append-only receipt log for goal events.
// One JSON line per receipt. Crash-safe via fsync.

import {
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";

export type ReceiptOutcome = "SUCCESS" | "FAILURE" | "PENDING";

export type Receipt = {
  readonly id: string;
  readonly ts: string; // ISO8601
  readonly goalId: string;
  readonly phase: string;
  readonly outcome: ReceiptOutcome;
  readonly detail?: string;
};

let nextSeq = 1;

function genId(): string {
  return `rcpt-${Date.now()}-${nextSeq++}`;
}

/**
 * Append a receipt to the log file with fsync for crash safety.
 * Creates the file and parent dirs if absent.
 */
export function appendReceipt(
  filePath: string,
  goalId: string,
  phase: string,
  outcome: ReceiptOutcome,
  detail?: string,
): Receipt {
  mkdirSync(dirname(filePath), { recursive: true });
  const receipt: Receipt = {
    id: genId(),
    ts: new Date().toISOString(),
    goalId,
    phase,
    outcome,
    ...(detail !== undefined ? { detail } : {}),
  };
  const line = JSON.stringify(receipt) + "\n";
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return receipt;
}

/**
 * Read all receipts from the file. Returns empty array if file absent.
 */
export function readReceipts(filePath: string): Receipt[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l) as Receipt);
}

/**
 * Filter receipts by goalId.
 */
export function receiptsForGoal(filePath: string, goalId: string): Receipt[] {
  return readReceipts(filePath).filter((r) => r.goalId === goalId);
}
