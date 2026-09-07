// ============================================================
// OTM Orchestration — Type Utilities
// Safe typed accessors for untrusted input (request bodies,
// inbound payloads, JSON.parse output, caught errors). Used
// across orchestration modules.
// Never throws — returns undefined on missing or wrong-type.
// Helpers: extractString, extractNumber, extractObject,
//          extractArray, extractBoolean, extractOneOf<T>,
//          toRecord, errorMessage.
//
// This module is the orchestration layer's narrow waist for
// unknown→T narrowing: the two `as` casts below are the only
// sanctioned ones (consistent-type-assertions is 'never'
// everywhere else), so every other module narrows through
// these helpers instead of casting.
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
 * Narrow an unknown value to a plain object record, or undefined when it
 * is null, an array, or not an object. JSON.parse output, DB rows, and
 * require()d modules all pass through here, so the orchestration layer's
 * unknown→Record narrowing happens in exactly one audited place.
 */
export function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- sanctioned narrow waist: the orchestration layer's single unknown→Record narrowing; `object` is not assignable to an index-signature type, so the shape check above cannot narrow without this
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Safely extract a nested object from an unknown record.
 * Returns undefined if the key is absent or the value is not a plain object.
 */
export function extractObject(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  return toRecord(obj[key]);
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- sanctioned narrow waist: widening `allowed` for includes() and narrowing `val` back to T are the two halves of the one membership check on this line
  return (allowed as readonly string[]).includes(val) ? (val as T) : undefined;
}

/**
 * Message of a caught value. catch clauses receive `unknown`; this is
 * the single place that turns one into text, so call sites never need
 * `(err as Error)`. Non-Error throwables are stringified. Never throws.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
