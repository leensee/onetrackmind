// ============================================================
// OTM — Canonical Content Hash Tests (Phase 4.1)
// CJS module. Run via: npm run test:content-hash
// Exercises src/comms/contentHash — the single hash definition
// the idempotencyChecker gate and commsLogWriter (4.2) share.
// Mechanism-comprehensive per the fixtures handoff: one case per
// distinct failure mechanism, not combinatorial over values.
// Synthetic identifiers only (@example.com / 555-01xx).
// ============================================================

import { computeContentHash } from '../src/comms/contentHash';

const HEX64 = /^[0-9a-f]{64}$/;

const BASE = {
  fromIdentifier: 'alice@example.com',
  toIdentifiers: ['bob@example.com', 'carol@example.com'],
  body: 'Quarterly numbers attached.',
};

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

  console.log('\ncontentHash Tests\n');

  // ── determinism + shape ───────────────────────────────────────
  test('deterministic — identical input twice yields identical hash', () => {
    assert(computeContentHash(BASE) === computeContentHash({ ...BASE }), 'hashes differ');
  });

  test('shape — 64-char lowercase hex', () => {
    assert(HEX64.test(computeContentHash(BASE)), `not 64 lowercase hex: ${computeContentHash(BASE)}`);
  });

  // ── recipient-order invariance (pinned canonicalization) ─────
  test('recipient order is canonicalized — [b,c] ≡ [c,b]', () => {
    const reordered = { ...BASE, toIdentifiers: ['carol@example.com', 'bob@example.com'] };
    assert(computeContentHash(BASE) === computeContentHash(reordered), 'reorder changed hash');
  });

  test('sort is code-unit — uppercase sorts before lowercase, both orders agree', () => {
    const a = { ...BASE, toIdentifiers: ['Bob@example.com', 'alice@example.com'] };
    const b = { ...BASE, toIdentifiers: ['alice@example.com', 'Bob@example.com'] };
    assert(computeContentHash(a) === computeContentHash(b), 'code-unit sort not order-invariant');
  });

  test('recipient multiplicity is content — [a,a] ≠ [a]', () => {
    const doubled = { ...BASE, toIdentifiers: ['bob@example.com', 'bob@example.com'] };
    const single = { ...BASE, toIdentifiers: ['bob@example.com'] };
    assert(computeContentHash(doubled) !== computeContentHash(single), 'duplicate recipient collapsed');
  });

  // ── injectivity (delimiter / boundary / escape / field-swap) ──
  test('injective — from "a,b" + to [] ≠ from "a" + to ["b"] (no delimiter collision)', () => {
    const x = { fromIdentifier: 'a,b', toIdentifiers: [], body: '' };
    const y = { fromIdentifier: 'a', toIdentifiers: ['b'], body: '' };
    assert(computeContentHash(x) !== computeContentHash(y), 'delimiter collision');
  });

  test('injective — to ["ab"] ≠ to ["a","b"] (array boundaries encoded)', () => {
    const x = { ...BASE, toIdentifiers: ['ab'] };
    const y = { ...BASE, toIdentifiers: ['a', 'b'] };
    assert(computeContentHash(x) !== computeContentHash(y), 'array-boundary collision');
  });

  test('injective — embedded quote vs pre-escaped quote differ', () => {
    const x = { ...BASE, body: 'a"b' };
    const y = { ...BASE, body: 'a\\"b' };
    assert(computeContentHash(x) !== computeContentHash(y), 'escape collision');
  });

  test('injective — from/body values are position-bound (no field swap)', () => {
    const x = { fromIdentifier: 'x', toIdentifiers: [], body: 'y' };
    const y = { fromIdentifier: 'y', toIdentifiers: [], body: 'x' };
    assert(computeContentHash(x) !== computeContentHash(y), 'field-swap collision');
  });

  // ── verbatim values (no normalization) ────────────────────────
  test('verbatim — surrounding whitespace is content', () => {
    const padded = { ...BASE, fromIdentifier: ' alice@example.com ' };
    assert(computeContentHash(BASE) !== computeContentHash(padded), 'whitespace folded');
  });

  test('verbatim — case is content (no case-fold)', () => {
    const upper = { ...BASE, fromIdentifier: 'Alice@example.com' };
    assert(computeContentHash(BASE) !== computeContentHash(upper), 'case folded');
  });

  test('body whitespace is content — "a\\nb" ≠ "a b"', () => {
    const x = { ...BASE, body: 'a\nb' };
    const y = { ...BASE, body: 'a b' };
    assert(computeContentHash(x) !== computeContentHash(y), 'newline collapsed');
  });

  // ── empty edges (schema allows empty body) ────────────────────
  test('empty edges — empty body / empty recipients / all-empty each hash without throwing', () => {
    const emptyBody = computeContentHash({ ...BASE, body: '' });
    const emptyTo = computeContentHash({ ...BASE, toIdentifiers: [] });
    const allEmpty = computeContentHash({ fromIdentifier: '', toIdentifiers: [], body: '' });
    assert(HEX64.test(emptyBody) && HEX64.test(emptyTo) && HEX64.test(allEmpty), 'empty edge not 64-hex');
    assert(emptyBody !== emptyTo && emptyTo !== allEmpty, 'distinct empty edges collided');
  });

  // ── caller input is not mutated ───────────────────────────────
  test('does not mutate the caller\'s toIdentifiers array', () => {
    const to = ['carol@example.com', 'bob@example.com'];
    computeContentHash({ ...BASE, toIdentifiers: to });
    assert(to[0] === 'carol@example.com' && to[1] === 'bob@example.com', 'caller array was sorted in place');
  });

  // ── summary ───────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('contentHash tests crashed:', err);
  process.exit(1);
});
