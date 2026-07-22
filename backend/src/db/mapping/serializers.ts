// ============================================================
// OTM — DAL Primitive Serializers (Schema v1.1)
// CJS module. Centralized row↔domain primitives the per-table
// mappers build on (fixtures handoff §3 hydration rules):
//   - INTEGER 0/1 ↔ boolean
//   - ISO-8601 UTC TEXT timestamps pass through as strings
//     (domain keeps timestamps as strings, never Date)
//   - JSON-in-TEXT ↔ parsed values (canonical compact on write)
// House error rule: operational failures (malformed / wrong-shape
// JSON read from the DB) return typed results — never throw.
// Pure functions, no logging, no I/O.
// ============================================================

import { Bool01 } from '../schemaConstants';

export type MapFailureReason = 'malformed_json' | 'wrong_shape';

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: MapFailureReason; detail: string };

export function boolFromDb(v: Bool01): boolean {
  return v === 1;
}

export function boolToDb(v: boolean): Bool01 {
  return v ? 1 : 0;
}

/** Identity by contract: timestamps are ISO-8601 UTC TEXT in row AND domain. */
export function timestampFromDb(v: string): string {
  return v;
}

/** Identity by contract: timestamps are ISO-8601 UTC TEXT in row AND domain. */
export function timestampToDb(v: string): string {
  return v;
}

/** Canonical compact JSON — the corpus stores every JSON-TEXT value this way. */
export function jsonToDb(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonFromDb(text: string, column: string): MapResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'malformed_json', detail: `${column}: ${msg}` };
  }
}

export function stringArrayFromDb(text: string, column: string): MapResult<string[]> {
  const parsed = jsonFromDb(text, column);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return { ok: false, reason: 'wrong_shape', detail: `${column}: expected a JSON array of strings` };
  }
  const items: string[] = [];
  for (const item of parsed.value) {
    if (typeof item !== 'string') {
      return { ok: false, reason: 'wrong_shape', detail: `${column}: expected a JSON array of strings` };
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

export function jsonObjectFromDb(text: string, column: string): MapResult<Record<string, unknown>> {
  const parsed = jsonFromDb(text, column);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, reason: 'wrong_shape', detail: `${column}: expected a JSON object` };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as-cast audit debt (otm#85): DAL validation internals, checked field-by-field
  return { ok: true, value: parsed.value as Record<string, unknown> };
}
