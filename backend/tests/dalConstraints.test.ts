// ============================================================
// OTM — DAL-Enforced Constraints Test (Schema v1.1)
// CJS module. Run via: npm run test:dal-constraints
// Live exercise of the pure functions behind the corpus catalog's
// enforcedBy:'dal' constraints (dedup window, idempotency-key
// expiry arithmetic, device ownership) — corpus rows where the
// corpus constrains the behavior, synthetic inputs for the
// boundaries it leaves to the contract. Ownership and identifiers
// rejection details are asserted EXACTLY against the manifest's
// pinned expectedError strings.
// Governing doc: docs/handoffs/OTM_Phase4.1_Fixtures_ClaudeCode_Handoff.md
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { DeviceTable } from './fixtures/constraints';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';
import {
  CONTENT_HASH_KEY_TTL_MS,
  DEDUP_WINDOW_MS,
  DedupCandidate,
  PROVIDER_ID_KEY_TTL_MS,
  checkIdempotencyExpiry,
  decideDedup,
  validateDeviceWrite,
} from '../src/db/mapping/dalConstraints';
import { IdempotencyKeyRow, idempotencyKeysFromDb } from '../src/db/mapping/idempotencyKeys';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

type Row = Record<string, unknown>;

function readJson(rel: string): Row {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, rel), 'utf8')) as Row;
}
function getRow(e: FixtureEntry): Row {
  if (e.inline) return e.inline.row;
  if (e.files) return readJson(e.files.row);
  throw new Error(`fixture ${e.id} has neither files nor inline content`);
}
function entryById(id: string): FixtureEntry {
  const e = MANIFEST.find((x) => x.id === id);
  if (!e) throw new Error(`manifest entry not found: ${id}`);
  return e;
}
function dedupCandidateOf(row: Row): DedupCandidate {
  return { contentHash: row['content_hash'] as string, createdAt: row['created_at'] as string };
}

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

  console.log('\ndalConstraints Tests\n');

  // ── 1. CL-DAL-DEDUP-WINDOW ────────────────────────────────────
  test('dedup — window constant is exactly 10 minutes', () => {
    assert(DEDUP_WINDOW_MS === 600000, `DEDUP_WINDOW_MS is ${DEDUP_WINDOW_MS}`);
  });

  test('dedup — corpus outside-window pair (Δ=11min, same hash) → store', () => {
    const a = dedupCandidateOf(getRow(entryById('comms_log:dedup-window-outside-a')));
    const b = dedupCandidateOf(getRow(entryById('comms_log:dedup-window-outside-b')));
    assert(a.contentHash === b.contentHash, 'scenario precondition: the pair shares content_hash');
    const [earlier, later] =
      Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? [a, b] : [b, a];
    const decision = decideDedup(later, [earlier]);
    assert(decision.action === 'store', `outside the window must store, got ${decision.action}`);
  });

  test('dedup — same hash Δ=4min → suppress with duplicateOf', () => {
    const existing: DedupCandidate = { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:00:00Z' };
    const incoming: DedupCandidate = { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:04:00Z' };
    const decision = decideDedup(incoming, [existing]);
    assert(decision.action === 'suppress', 'inside the window must suppress');
    assert(
      decision.action === 'suppress' && decision.duplicateOf === existing,
      'duplicateOf must reference the matched existing candidate',
    );
  });

  test('dedup — boundary pinned inclusive: Δ=exactly 10min → suppress; Δ=10min+1ms → store', () => {
    const existing: DedupCandidate = { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:00:00Z' };
    const atBoundary = decideDedup(
      { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:10:00Z' },
      [existing],
    );
    assert(atBoundary.action === 'suppress', 'Δ = DEDUP_WINDOW_MS must suppress (inclusive boundary)');
    const pastBoundary = decideDedup(
      { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:10:00.001Z' },
      [existing],
    );
    assert(pastBoundary.action === 'store', 'Δ = DEDUP_WINDOW_MS + 1ms must store');
  });

  test('dedup — different hash inside the window → store', () => {
    const decision = decideDedup(
      { contentHash: 'a'.repeat(64), createdAt: '2026-06-07T14:01:00Z' },
      [{ contentHash: 'b'.repeat(64), createdAt: '2026-06-07T14:00:00Z' }],
    );
    assert(decision.action === 'store', 'different content_hash never dedupes');
  });

  test('dedup — incoming earlier than existing (negative Δ) → store', () => {
    const decision = decideDedup(
      { contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:00:00Z' },
      [{ contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:05:00Z' }],
    );
    assert(decision.action === 'store', 'the window looks backward from the incoming row only');
  });

  test('dedup — cross-provider: signature has no provider, so provider cannot exempt', () => {
    // The corpus survivor row documents the outlook copy; the yahoo
    // copy arrived inside the window and was suppressed by the DAL.
    const survivor = dedupCandidateOf(getRow(entryById('comms_log:dedup-cross-provider')));
    const survivorMs = Date.parse(survivor.createdAt);
    const incoming: DedupCandidate = {
      contentHash: survivor.contentHash,
      createdAt: new Date(survivorMs + 3 * 60 * 1000).toISOString(),
    };
    const decision = decideDedup(incoming, [survivor]);
    assert(decision.action === 'suppress', 'identical content via another provider must suppress');
  });

  test('dedup — unparseable timestamp throws (precondition violation)', () => {
    let threw = false;
    try {
      decideDedup(
        { contentHash: 'h'.repeat(64), createdAt: 'not-a-timestamp' },
        [{ contentHash: 'h'.repeat(64), createdAt: '2026-06-07T14:00:00Z' }],
      );
    } catch {
      threw = true;
    }
    assert(threw, 'garbage timestamps are a caller bug, not an operational failure');
  });

  // ── 2. IK-DAL-EXPIRY-ARITHMETIC ───────────────────────────────
  test('expiry — TTL constants are exactly 90d / 24h', () => {
    assert(PROVIDER_ID_KEY_TTL_MS === 90 * 24 * 3600 * 1000, `provider_id TTL is ${PROVIDER_ID_KEY_TTL_MS}`);
    assert(CONTENT_HASH_KEY_TTL_MS === 24 * 3600 * 1000, `content_hash TTL is ${CONTENT_HASH_KEY_TTL_MS}`);
  });

  test('expiry — every valid idempotency_keys fixture embodies the exact arithmetic', () => {
    const entries = MANIFEST.filter((e) => e.kind === 'valid' && e.table === 'idempotency_keys');
    assert(entries.length >= 5, `expected ≥ 5 valid idempotency_keys fixtures, found ${entries.length}`);
    for (const e of entries) {
      const hydrated = idempotencyKeysFromDb(getRow(e) as unknown as IdempotencyKeyRow);
      assert(hydrated.ok, `${e.id}: hydration must succeed`);
      if (hydrated.ok) {
        const res = checkIdempotencyExpiry(hydrated.value);
        assert(res.ok, `${e.id}: ${res.ok ? '' : res.detail}`);
      }
    }
  });

  test('expiry — swapped TTLs and ±1ms skew → expiry_mismatch', () => {
    const providerIdWith24h = checkIdempotencyExpiry({
      keyType: 'provider_id',
      firstSeenAt: '2026-06-05T10:00:00Z',
      expiresAt: '2026-06-06T10:00:00Z',
    });
    assert(!providerIdWith24h.ok && providerIdWith24h.reason === 'expiry_mismatch', 'provider_id + 24h must mismatch');
    const contentHashWith90d = checkIdempotencyExpiry({
      keyType: 'content_hash',
      firstSeenAt: '2026-06-05T11:00:00Z',
      expiresAt: '2026-09-03T11:00:00Z',
    });
    assert(!contentHashWith90d.ok && contentHashWith90d.reason === 'expiry_mismatch', 'content_hash + 90d must mismatch');
    const plus1ms = checkIdempotencyExpiry({
      keyType: 'content_hash',
      firstSeenAt: '2026-06-05T11:00:00Z',
      expiresAt: '2026-06-06T11:00:00.001Z',
    });
    assert(!plus1ms.ok && plus1ms.reason === 'expiry_mismatch', '+1ms must mismatch (exact ms equality)');
    const minus1ms = checkIdempotencyExpiry({
      keyType: 'content_hash',
      firstSeenAt: '2026-06-05T11:00:00Z',
      expiresAt: '2026-06-06T10:59:59.999Z',
    });
    assert(!minus1ms.ok && minus1ms.reason === 'expiry_mismatch', '-1ms must mismatch (exact ms equality)');
  });

  test('expiry — garbage timestamp → unparseable_timestamp (typed, not thrown)', () => {
    const res = checkIdempotencyExpiry({
      keyType: 'provider_id',
      firstSeenAt: 'not-a-timestamp',
      expiresAt: '2026-09-03T10:00:00Z',
    });
    assert(!res.ok && res.reason === 'unparseable_timestamp', 'must return unparseable_timestamp');
  });

  // ── 3. DV-OWN-COMMS-BACKEND-FIELD / DV-OWN-CONTACTS-READONLY ──
  test('ownership — both corpus fixtures rejected with the manifest expectedError exactly', () => {
    const entries = MANIFEST.filter(
      (e) =>
        e.kind === 'invalid' &&
        (e.rejects === 'DV-OWN-COMMS-BACKEND-FIELD' || e.rejects === 'DV-OWN-CONTACTS-READONLY'),
    );
    assert(entries.length === 2, `expected the 2 ownership fixtures, found ${entries.length}`);
    for (const e of entries) {
      const res = validateDeviceWrite(e.table as DeviceTable, getRow(e));
      assert(!res.ok, `${e.id}: device write must be rejected`);
      if (!res.ok) {
        assert(res.reason === 'ownership_violation', `${e.id}: reason ${res.reason}`);
        assert(
          res.detail === e.expectedError,
          `${e.id}: detail "${res.detail}" must equal manifest expectedError "${e.expectedError}"`,
        );
      }
    }
  });

  test('ownership — legal device_comms_log writes pass', () => {
    const ackWrite = validateDeviceWrite('device_comms_log', {
      id: 'fa0700fa-0700-4700-8700-fa0700fa0700',
      user_acknowledged_at: '2026-06-06T08:15:00Z',
      user_action_taken: 'dismissed',
    });
    assert(ackWrite.ok, 'ack + action on device_comms_log is the legal write');
    const idOnly = validateDeviceWrite('device_comms_log', { id: 'fa0700fa-0700-4700-8700-fa0700fa0700' });
    assert(idOnly.ok, 'id-only payload touches no backend-owned column');
  });

  test('ownership — device_comms_log payload touching a backend column → rejected', () => {
    const res = validateDeviceWrite('device_comms_log', {
      id: 'fa0700fa-0700-4700-8700-fa0700fa0700',
      user_acknowledged_at: '2026-06-06T08:15:00Z',
      body: 'edited on device',
    });
    assert(!res.ok && res.reason === 'ownership_violation', 'backend-owned column must reject');
  });

  test('ownership — device_contacts rejects every payload (read-only cache)', () => {
    const idOnly = validateDeviceWrite('device_contacts', { id: 'ca0001ca-0001-4001-8001-ca0001ca0001' });
    assert(!idOnly.ok, 'even an id-only payload is rejected: the device may write nothing');
    const empty = validateDeviceWrite('device_contacts', {});
    assert(!empty.ok, 'an empty payload is still a write attempt');
  });

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
