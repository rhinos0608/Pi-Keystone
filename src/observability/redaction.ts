// Redaction: sanitize PII/secrets from logs before persistence.
// Pattern-based detection on strings, recursive on objects.
//
// NOTE (ownership): this module redacts when CALLED — wiring at call sites
// (launchers, log emitters) is launcher-owned, not done here. Call
// redactString/redactObject before persisting or emitting logs.

/** Patterns that indicate sensitive data. */
const REDACTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // Keystone authority sentinel blocks (lease transport — never loggable)
  {
    label: "KEYSTONE_AUTHORITY",
    re: /---KEYSTONE-AUTHORITY-V1[\s\S]*?---END-KEYSTONE-AUTHORITY-V1/g,
  },
  // Lease JSON values keyed by lease field names (full lease field set)
  {
    label: "LEASE_ID",
    re: /"(?:leaseId|fencingToken|assignmentId|sessionId|goalId|workerProcessIdentity|canonicalWorkspaceRoot|allowedCanonicalPaths|approvedCommands|allowedMcpTools|dirtySignature|baseDirtySignature)"\s*:\s*(?:"[^"]*"|\[[^\]]*\]|[^,}\s]+)/g,
  },
  // Email addresses
  { label: "EMAIL", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // API keys / tokens (common prefixes)
  {
    label: "API_KEY",
    re: /\b(sk-[a-zA-Z0-9]{20,}|ak_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|xoxb-[a-zA-Z0-9-]+)\b/g,
  },
  // Generic secrets / bearer tokens
  {
    label: "SECRET",
    re: /(secret|token|password|passwd|authorization|bearer)\s*[:=]\s*\S+/gi,
  },
  // AWS-style keys
  {
    label: "AWS_KEY",
    re: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  // Private keys
  {
    label: "PRIVATE_KEY",
    re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  },
  // SSN-like (US)
  { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card numbers (simplified)
  { label: "CREDIT_CARD", re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  // Phone numbers (US)
  {
    label: "PHONE",
    re: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
];

/**
 * Redact a single string. Returns redacted copy; original untouched.
 */
export function redactString(input: string): string {
  let result = input;
  for (const { re } of REDACTION_PATTERNS) {
    // Reset regex lastIndex for global patterns
    re.lastIndex = 0;
    result = result.replace(re, "[REDACTED]");
  }
  return result;
}

/**
 * Redact an Error's message (and message-bearing fields) for safe rethrow/logging.
 * Returns an error of the same constructor with a redacted message.
 */
export function redactError(err: unknown): unknown {
  if (err instanceof Error) {
    const safe = Object.create(Object.getPrototypeOf(err)) as Error;
    Object.defineProperty(safe, "message", {
      value: redactString(err.message),
      enumerable: false,
      writable: true,
      configurable: true,
    });
    if (typeof err.stack === "string") {
      Object.defineProperty(safe, "stack", {
        value: redactString(err.stack),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    // Preserve typed CAS/identity fields: the fresh instance drops every own
    // enumerable prop (code, goalId, expectedVersion, actualVersion, ...).
    // Copy them over, redacting string values only (numbers/booleans pass
    // through; lease material in strings is still scrubbed).
    for (const key of Object.keys(err)) {
      if (key === "message" || key === "stack") continue;
      const value = (err as unknown as Record<string, unknown>)[key];
      (safe as unknown as Record<string, unknown>)[key] =
        typeof value === "string" ? redactString(value) : value;
    }
    return safe;
  }
  if (typeof err === "string") return redactString(err);
  if (err !== null && typeof err === "object") return redactObject(err);
  return err;
}

/**
 * Redact all values in an object (deep) by key for lease/secret material.
 * Non-string values (numbers, arrays, objects) under a sensitive key are
 * redacted too — not just strings.
 */
export function redactObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input) as T;
  if (Array.isArray(input)) return input.map((item) => redactObject(item)) as T;
  if (typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // Redact keys that look like secrets or lease material (any value type)
      if (/secret|token|passwd|password|api[-_ ]?key|private[-_ ]?key|authorization|bearer|sessionId|goalId|workerProcessIdentity|canonicalWorkspaceRoot|allowedCanonicalPaths|approvedCommands|allowedMcpTools|dirtySignature|baseDirtySignature/i.test(key)
        || /^(leaseId|fencingToken|assignmentId)$/.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result as T;
  }
  return input;
}

/**
 * Get the list of active redaction patterns (for testing/introspection).
 */
export function getRedactionPatterns(): readonly { label: string; re: RegExp }[] {
  return REDACTION_PATTERNS;
}
