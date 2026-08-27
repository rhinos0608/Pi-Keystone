// Redaction: sanitize PII/secrets from logs before persistence.
// Pattern-based detection on strings, recursive on objects.

/** Patterns that indicate sensitive data. */
const REDACTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
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
 * Redact all string values in an object (deep).
 * Returns a new object; original untouched.
 */
export function redactObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input) as T;
  if (Array.isArray(input)) return input.map((item) => redactObject(item)) as T;
  if (typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // Redact keys that look like secrets
      if (/secret|token|password|key|auth/i.test(key) && typeof value === "string") {
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
