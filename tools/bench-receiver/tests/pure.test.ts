// Hand-rolled test harness matching backend/tests house style
// (no jest/vitest; ✓/✗ output; non-zero exit on failure).

import {
  corpusPathsFor,
  insideSyncRoot,
  isSafeSegment,
  secretMatches,
  validateSubmission,
  SUBMISSION_SCHEMA,
} from '../src/pure';

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}`);
    console.error(`  ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function validAudioBody(): Record<string, unknown> {
  return {
    schema: SUBMISSION_SCHEMA,
    entry: {
      id: '4f2b8a1e-0000-4000-8000-000000000001',
      payload_kind: 'audio',
      trigger_source: 'ui-button',
      origin_timestamp: '2026-07-21T10:00:00.000Z',
      device_provenance: { device_model: 'iPhone17,1' },
      session_id: 'dev-session',
      arm_label: 'builtin+vi',
      utterance_id: 'U01',
      audio_format: { container: 'wav', sample_rate: 24000 },
      capture_metadata: { schema: 'capture_metadata.v1' },
    },
    payload: { kind: 'audio', audioBase64: 'AAAA', format: { container: 'wav' } },
  };
}

// ── validateSubmission ────────────────────────────────────────

test('accepts a valid audio submission', () => {
  const result = validateSubmission(validAudioBody());
  assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  if (result.ok) {
    assert(result.value.entry.arm_label === 'builtin+vi', 'arm_label parsed');
    assert(result.value.payload.kind === 'audio', 'payload kind parsed');
  }
});

test('accepts a valid text submission', () => {
  const body = validAudioBody();
  (body.entry as Record<string, unknown>).payload_kind = 'text';
  body.payload = { kind: 'text', text: 'bench text-note' };
  const result = validateSubmission(body);
  assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
});

test('rejects discriminator mismatch between entry and payload', () => {
  const body = validAudioBody();
  body.payload = { kind: 'text', text: 'mismatched' };
  const result = validateSubmission(body);
  assert(!result.ok, 'expected failure');
  if (!result.ok) {
    assert(result.reason === 'invalid_input', 'reason invalid_input');
    assert(result.detail.includes('payload.kind'), 'detail names the field');
    assert(!result.retryable, 'not retryable');
  }
});

test('rejects wrong schema', () => {
  const body = validAudioBody();
  body.schema = 'otm-bench-capture.v0';
  assert(!validateSubmission(body).ok, 'expected failure');
});

test('rejects non-object body', () => {
  assert(!validateSubmission('not an object').ok, 'string body');
  assert(!validateSubmission(null).ok, 'null body');
  assert(!validateSubmission([1, 2]).ok, 'array body');
});

test('rejects missing required entry fields', () => {
  for (const field of [
    'id',
    'payload_kind',
    'trigger_source',
    'origin_timestamp',
    'session_id',
    'arm_label',
    'capture_metadata',
  ]) {
    const body = validAudioBody();
    delete (body.entry as Record<string, unknown>)[field];
    assert(!validateSubmission(body).ok, `missing ${field} accepted`);
  }
});

test('rejects path-traversal identifiers', () => {
  for (const evil of ['../evil', 'a/b', 'a\\b', '..', '.', '', 'x'.repeat(65)]) {
    const body = validAudioBody();
    (body.entry as Record<string, unknown>).session_id = evil;
    assert(!validateSubmission(body).ok, `traversal session_id ${JSON.stringify(evil)} accepted`);
  }
});

test('rejects empty audioBase64', () => {
  const body = validAudioBody();
  body.payload = { kind: 'audio', audioBase64: '', format: null };
  assert(!validateSubmission(body).ok, 'empty audio accepted');
});

// ── isSafeSegment ─────────────────────────────────────────────

test('safe-segment accepts the real arm labels', () => {
  for (const label of [
    'builtin-raw',
    'builtin+vi',
    'builtin-std',
    'ac-bt+vi',
    'bc-bt-std',
    'builtin-earsplugged',
    'builtin-mounted-fixed',
    'field20260801',
  ]) {
    assert(isSafeSegment(label), `${label} rejected`);
  }
});

// ── corpusPathsFor ────────────────────────────────────────────

test('derives corpus paths by session/arm with kind-specific extension', () => {
  const parsed = validateSubmission(validAudioBody());
  assert(parsed.ok, 'fixture valid');
  if (parsed.ok) {
    const paths = corpusPathsFor('/corpus', parsed.value.entry);
    assert(
      paths.dataPath === '/corpus/dev-session/builtin+vi/4f2b8a1e-0000-4000-8000-000000000001.wav',
      `unexpected dataPath ${paths.dataPath}`,
    );
    assert(paths.jsonPath.endsWith('.json'), 'json sidecar path');
  }
});

// ── insideSyncRoot ────────────────────────────────────────────

test('detects corpus dirs inside cloud-sync roots', () => {
  const home = '/Users/bench';
  assert(
    insideSyncRoot('/Users/bench/Library/Mobile Documents/x/corpus', home) !== null,
    'iCloud Drive not detected',
  );
  assert(
    insideSyncRoot('/Users/bench/Library/CloudStorage/Dropbox/corpus', home) !== null,
    'CloudStorage not detected',
  );
  assert(
    insideSyncRoot('/Users/bench/Dropbox', home) !== null,
    'exact sync root not detected',
  );
});

test('does not flag clean or boundary-adjacent paths', () => {
  const home = '/Users/bench';
  assert(insideSyncRoot('/Users/bench/otm-bench/corpus', home) === null, 'clean path flagged');
  assert(insideSyncRoot('/Users/bench/Dropboxx/corpus', home) === null, 'prefix trickery flagged');
});

// ── secretMatches ─────────────────────────────────────────────

test('secret comparison', () => {
  assert(secretMatches('s3cret', 's3cret'), 'equal secrets rejected');
  assert(!secretMatches('wrong', 's3cret'), 'wrong secret accepted');
  assert(!secretMatches(undefined, 's3cret'), 'missing secret accepted');
  assert(!secretMatches('', 's3cret'), 'empty secret accepted');
});

process.exit(failures > 0 ? 1 : 0);
