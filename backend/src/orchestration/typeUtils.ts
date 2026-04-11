// ============================================================
// OTM Orchestration — Type Utilities
// Safe typed accessors for untrusted input (request bodies,
// inbound payloads). Used across orchestration modules.
// Never throws — returns undefined on missing or wrong-type.
// ============================================================

/**
 * Safely extract a string field from an unknown record.
 * Returns undefined if the key is absent or the value is not a string.
 * Never casts or coerces.
 */
export function extractString(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Safely extract a number field from an unknown record.
 * Returns undefined if the key is absent or the value is not a number.
 */
export function extractNumber(
  obj: Record<string, unknown>,
  key: string
): number | undefined {
  const val = obj[key];
  return typeof val === 'number' ? val : undefined;
}

/**
 * Safely extract a nested object from an unknown record.
 * Returns undefined if the key is absent or the value is not a plain object.
 */
export function extractObject(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const val = obj[key];
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}
