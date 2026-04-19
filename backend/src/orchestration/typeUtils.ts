// ============================================================
// OTM Orchestration — Type Utilities
// Safe typed accessors for untrusted input (request bodies,
// inbound payloads). Used across orchestration modules.
// Never throws — returns undefined on missing or wrong-type.
// Helpers: extractString, extractNumber, extractObject,
//          extractArray, extractBoolean, extractOneOf<T>.
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

/**
 * Safely extract an array field from an unknown record.
 * Returns undefined if the key is absent or the value is not an array.
 * Elements are returned as `unknown[]`; callers validate element types
 * (typically via `.filter((v): v is string => typeof v === 'string')`
 * or by mapping through extractString / extractOneOf).
 */
export function extractArray(
  obj: Record<string, unknown>,
  key: string
): unknown[] | undefined {
  const val = obj[key];
  return Array.isArray(val) ? val : undefined;
}

/**
 * Safely extract a boolean field from an unknown record.
 * Strict typeof check — no truthy/falsy coercion, no "true"/"false"
 * string parsing, no 0/1 coercion. Returns undefined unless the value
 * is literally a boolean.
 */
export function extractBoolean(
  obj: Record<string, unknown>,
  key: string
): boolean | undefined {
  const val = obj[key];
  return typeof val === 'boolean' ? val : undefined;
}

/**
 * Safely extract a string-union field from an unknown record.
 * Returns undefined unless the value is a string AND is present in
 * the `allowed` list. Case-sensitive. Preserves the literal type of
 * `allowed` so callers get `T | undefined` (e.g. pass `['a','b'] as const`).
 *
 * Typical use: validating DB-row values against a known enum / discriminator
 * set at an untrusted boundary.
 */
export function extractOneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const val = obj[key];
  if (typeof val !== 'string') return undefined;
  // Cast is safe: gated by the includes() membership check above.
  return (allowed as readonly string[]).includes(val) ? (val as T) : undefined;
}
