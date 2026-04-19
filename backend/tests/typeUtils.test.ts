// ============================================================
// OTM — typeUtils Tests
// CJS module. Run via: npm run test:typeutils
// Covers TYU-3 (test coverage) + TYU-4/5 (new helpers).
// ============================================================

import {
  extractString,
  extractNumber,
  extractObject,
  extractArray,
  extractBoolean,
  extractOneOf,
} from '../src/orchestration/typeUtils';

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void): void {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
      failed++;
    }
  }

  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  console.log('\ntypeUtils Tests\n');

  // ── 1. extractString ──────────────────────────────────────
  test('extractString returns string value', () => {
    assert(extractString({ k: 'hello' }, 'k') === 'hello', 'must return string');
  });
  test('extractString returns empty string as-is', () => {
    assert(extractString({ k: '' }, 'k') === '', 'empty string is valid');
  });
  test('extractString returns undefined when key absent', () => {
    assert(extractString({}, 'k') === undefined, 'missing key → undefined');
  });
  test('extractString returns undefined for null value', () => {
    assert(extractString({ k: null }, 'k') === undefined, 'null → undefined');
  });
  test('extractString returns undefined for number value', () => {
    assert(extractString({ k: 42 }, 'k') === undefined, 'number → undefined');
  });
  test('extractString returns undefined for boolean value', () => {
    assert(extractString({ k: true }, 'k') === undefined, 'boolean → undefined');
  });
  test('extractString returns undefined for object value', () => {
    assert(extractString({ k: {} }, 'k') === undefined, 'object → undefined');
  });
  test('extractString returns undefined for array value', () => {
    assert(extractString({ k: [] }, 'k') === undefined, 'array → undefined');
  });

  // ── 2. extractNumber ──────────────────────────────────────
  test('extractNumber returns number value', () => {
    assert(extractNumber({ k: 42 }, 'k') === 42, 'must return number');
  });
  test('extractNumber returns zero as-is', () => {
    assert(extractNumber({ k: 0 }, 'k') === 0, 'zero is valid');
  });
  test('extractNumber returns negative as-is', () => {
    assert(extractNumber({ k: -1 }, 'k') === -1, 'negative is valid');
  });
  test('extractNumber returns undefined when key absent', () => {
    assert(extractNumber({}, 'k') === undefined, 'missing key → undefined');
  });
  test('extractNumber returns undefined for null value', () => {
    assert(extractNumber({ k: null }, 'k') === undefined, 'null → undefined');
  });
  test('extractNumber returns undefined for string value', () => {
    assert(extractNumber({ k: '42' }, 'k') === undefined, 'numeric string → undefined');
  });
  test('extractNumber returns undefined for boolean value', () => {
    assert(extractNumber({ k: true }, 'k') === undefined, 'boolean → undefined');
  });
  test('extractNumber returns NaN as-is (current lenient behavior)', () => {
    // Asserts current contract: typeof NaN === 'number' passes. If future work
    // tightens extractNumber to reject NaN, update this test alongside.
    const result = extractNumber({ k: NaN }, 'k');
    assert(typeof result === 'number' && Number.isNaN(result), 'NaN → NaN');
  });

  // ── 3. extractObject ──────────────────────────────────────
  test('extractObject returns plain object', () => {
    const obj = { a: 1 };
    assert(extractObject({ k: obj }, 'k') === obj, 'must return object reference');
  });
  test('extractObject returns empty object as-is', () => {
    const result = extractObject({ k: {} }, 'k');
    assert(result !== undefined && Object.keys(result).length === 0, 'empty object is valid');
  });
  test('extractObject returns undefined when key absent', () => {
    assert(extractObject({}, 'k') === undefined, 'missing key → undefined');
  });
  test('extractObject returns undefined for null value', () => {
    assert(extractObject({ k: null }, 'k') === undefined, 'null → undefined');
  });
  test('extractObject returns undefined for array value', () => {
    assert(extractObject({ k: [1, 2] }, 'k') === undefined, 'array → undefined');
  });
  test('extractObject returns undefined for string value', () => {
    assert(extractObject({ k: 'x' }, 'k') === undefined, 'string → undefined');
  });
  test('extractObject returns undefined for number value', () => {
    assert(extractObject({ k: 1 }, 'k') === undefined, 'number → undefined');
  });

  // ── 4. extractArray ───────────────────────────────────────
  test('extractArray returns array value', () => {
    const arr = [1, 'a', true];
    assert(extractArray({ k: arr }, 'k') === arr, 'must return array reference');
  });
  test('extractArray returns empty array as-is', () => {
    const result = extractArray({ k: [] }, 'k');
    assert(Array.isArray(result) && result.length === 0, 'empty array is valid');
  });
  test('extractArray returns undefined when key absent', () => {
    assert(extractArray({}, 'k') === undefined, 'missing key → undefined');
  });
  test('extractArray returns undefined for null value', () => {
    assert(extractArray({ k: null }, 'k') === undefined, 'null → undefined');
  });
  test('extractArray returns undefined for object value', () => {
    assert(extractArray({ k: {} }, 'k') === undefined, 'object → undefined');
  });
  test('extractArray returns undefined for string value', () => {
    assert(extractArray({ k: 'abc' }, 'k') === undefined, 'string → undefined');
  });
  test('extractArray returns undefined for number value', () => {
    assert(extractArray({ k: 42 }, 'k') === undefined, 'number → undefined');
  });
  test('extractArray composes with element filter for string[] result', () => {
    // Demonstrates the CL-6 remediation pattern: array-ness from extractArray,
    // element-typing via filter predicate. No `as string[]` cast required.
    const raw = extractArray({ k: ['a', 1, 'b', null, 'c'] }, 'k') ?? [];
    const strings: string[] = raw.filter((v): v is string => typeof v === 'string');
    assert(strings.length === 3, 'filter produces 3 strings');
    assert(strings[0] === 'a' && strings[1] === 'b' && strings[2] === 'c', 'filter preserves order');
  });

  // ── 5. extractBoolean ─────────────────────────────────────
  test('extractBoolean returns true', () => {
    assert(extractBoolean({ k: true }, 'k') === true, 'true → true');
  });
  test('extractBoolean returns false (not coerced to undefined)', () => {
    assert(extractBoolean({ k: false }, 'k') === false, 'false → false');
  });
  test('extractBoolean returns undefined when key absent', () => {
    assert(extractBoolean({}, 'k') === undefined, 'missing key → undefined');
  });
  test('extractBoolean returns undefined for null value', () => {
    assert(extractBoolean({ k: null }, 'k') === undefined, 'null → undefined');
  });
  test('extractBoolean returns undefined for "true" string (no coercion)', () => {
    assert(extractBoolean({ k: 'true' }, 'k') === undefined, '"true" string → undefined');
  });
  test('extractBoolean returns undefined for "false" string (no coercion)', () => {
    assert(extractBoolean({ k: 'false' }, 'k') === undefined, '"false" string → undefined');
  });
  test('extractBoolean returns undefined for 1 (no coercion)', () => {
    assert(extractBoolean({ k: 1 }, 'k') === undefined, '1 → undefined');
  });
  test('extractBoolean returns undefined for 0 (no coercion)', () => {
    assert(extractBoolean({ k: 0 }, 'k') === undefined, '0 → undefined');
  });
  test('extractBoolean returns undefined for object value', () => {
    assert(extractBoolean({ k: {} }, 'k') === undefined, 'object → undefined');
  });

  // ── 6. extractOneOf ───────────────────────────────────────

  // Compile-time narrowing check. If extractOneOf ever broadens its return
  // to `string | undefined`, this file will fail tsc and the test run breaks.
  const ALLOWED = ['approve', 'reject', 'edit'] as const;
  const narrowed: 'approve' | 'reject' | 'edit' | undefined =
    extractOneOf({ k: 'approve' }, 'k', ALLOWED);
  void narrowed; // suppress unused-local lint; the annotation itself is the test

  test('extractOneOf returns value when present in allowed', () => {
    assert(
      extractOneOf({ k: 'approve' }, 'k', ALLOWED) === 'approve',
      'allowed value returned'
    );
  });
  test('extractOneOf returns undefined when string not in allowed', () => {
    assert(
      extractOneOf({ k: 'maybe' }, 'k', ALLOWED) === undefined,
      'not-in-allowed → undefined'
    );
  });
  test('extractOneOf is case-sensitive', () => {
    assert(
      extractOneOf({ k: 'APPROVE' }, 'k', ALLOWED) === undefined,
      'wrong case → undefined'
    );
  });
  test('extractOneOf returns undefined for empty allowed list', () => {
    assert(
      extractOneOf({ k: 'approve' }, 'k', [] as const) === undefined,
      'empty allowed → undefined'
    );
  });
  test('extractOneOf returns undefined when key absent', () => {
    assert(extractOneOf({}, 'k', ALLOWED) === undefined, 'missing key → undefined');
  });
  test('extractOneOf returns undefined for null value', () => {
    assert(
      extractOneOf({ k: null }, 'k', ALLOWED) === undefined,
      'null → undefined'
    );
  });
  test('extractOneOf returns undefined for number value', () => {
    assert(
      extractOneOf({ k: 42 }, 'k', ALLOWED) === undefined,
      'number → undefined'
    );
  });
  test('extractOneOf returns undefined for boolean value', () => {
    assert(
      extractOneOf({ k: true }, 'k', ALLOWED) === undefined,
      'boolean → undefined'
    );
  });
  test('extractOneOf returns undefined for object value', () => {
    assert(
      extractOneOf({ k: {} }, 'k', ALLOWED) === undefined,
      'object → undefined'
    );
  });
  test('extractOneOf returns empty string if it appears in allowed list', () => {
    // Edge: empty string is a valid union member if caller wants it.
    const result = extractOneOf({ k: '' }, 'k', ['', 'x'] as const);
    assert(result === '', 'empty string is valid when in allowed');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
