// ============================================================
// Tests: observability/logger.ts — injected Logger seam
// Pure formatting helpers tested in isolation; the console-backed
// impl tested through an injected ConsoleSink (no monkey-patching,
// per the seam's own design goal). Run via: npm run test:logger
// ============================================================

import {
  ConsoleSink,
  Logger,
  createConsoleLogger,
  formatFieldValue,
  formatLogLine,
  noopLogger,
} from '../src/observability/logger';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Capturing sink ────────────────────────────────────────────

interface Captured {
  level: 'info' | 'warn' | 'error';
  message: string;
}

function capturingSink(lines: Captured[]): ConsoleSink {
  return {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  };
}

// ── formatFieldValue ──────────────────────────────────────────

console.log('\n[logger] formatFieldValue');
{
  assert(formatFieldValue('plain') === 'plain', 'string passes verbatim');
  assert(formatFieldValue(42) === '42', 'number stringified');
  assert(formatFieldValue(true) === 'true', 'boolean stringified');
  assert(formatFieldValue(null) === 'null', 'null stringified');
  assert(formatFieldValue(undefined) === 'undefined', 'undefined stringified');
  assert(formatFieldValue({ a: 1 }) === '{"a":1}', 'object → compact JSON');
  assert(formatFieldValue([1, 'x']) === '[1,"x"]', 'array → compact JSON');
  assert(formatFieldValue(() => {}) !== '', 'function degrades to a non-empty marker');

  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert(formatFieldValue(circular) === '[unserializable]', 'circular object → [unserializable], no throw');
}

// ── formatFieldValue — log-forgery hardening ──────────────────

console.log('\n[logger] newline escaping (log-line forgery)');
{
  assert(
    formatFieldValue('line1\nline2') === 'line1\\nline2',
    'LF in string value escaped'
  );
  assert(
    formatFieldValue('a\r\nb') === 'a\\r\\nb',
    'CRLF in string value escaped'
  );
  const forged = formatLogLine('Real', 'stored', { body: 'x\n[Real] forged line' });
  assert(
    !forged.includes('\n'),
    'field value cannot inject a second log line'
  );
  // JSON.stringify escapes newlines inside object values on its own.
  assert(
    formatFieldValue({ note: 'a\nb' }) === '{"note":"a\\nb"}',
    'newline inside JSON object value escaped by JSON encoding'
  );
}

// ── formatLogLine ─────────────────────────────────────────────

console.log('\n[logger] formatLogLine');
{
  assert(
    formatLogLine('CommsIngest', 'message stored') === '[CommsIngest] message stored',
    'no fields → namespace + message only'
  );
  assert(
    formatLogLine('CommsIngest', 'message stored', { commsLogId: 'abc', attempt: 2 }) ===
      '[CommsIngest] message stored commsLogId=abc attempt=2',
    'fields render as key=value pairs in order'
  );
  assert(
    formatLogLine('X', 'm', {}) === '[X] m',
    'empty fields object → no trailing content'
  );
}

// ── createConsoleLogger — level routing ───────────────────────

console.log('\n[logger] createConsoleLogger routes levels');
{
  const lines: Captured[] = [];
  const logger = createConsoleLogger('Test', capturingSink(lines));
  logger.info('i', { k: 1 });
  logger.warn('w');
  logger.error('e');

  assert(lines.length === 3, 'three lines captured');
  assert(lines[0]?.level === 'info' && lines[0]?.message === '[Test] i k=1', 'info routed with fields');
  assert(lines[1]?.level === 'warn' && lines[1]?.message === '[Test] w', 'warn routed');
  assert(lines[2]?.level === 'error' && lines[2]?.message === '[Test] e', 'error routed');
}

// ── createConsoleLogger — sink failure contained ──────────────

console.log('\n[logger] sink failure never breaks the caller');
{
  const throwingSink: ConsoleSink = {
    info: () => { throw new Error('sink down'); },
    warn: () => { throw new Error('sink down'); },
    error: () => { throw new Error('sink down'); },
  };
  const logger = createConsoleLogger('Test', throwingSink);
  let threw = false;
  try {
    logger.info('i');
    logger.warn('w');
    logger.error('e');
  } catch {
    threw = true;
  }
  assert(!threw, 'all three levels swallow sink throws');
}

// ── noopLogger ────────────────────────────────────────────────

console.log('\n[logger] noopLogger');
{
  // Satisfies the interface and does nothing — compile + no-throw check.
  const logger: Logger = noopLogger;
  let threw = false;
  try {
    logger.info('i', { k: 'v' });
    logger.warn('w');
    logger.error('e');
  } catch {
    threw = true;
  }
  assert(!threw, 'noopLogger accepts all calls silently');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n[logger] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
