// ============================================================
// OTM — Primary Call Tests
// CJS module. Run via: npm run test:primary
//
// Test strategy: middle path (Option B + isolated unit test)
// - accumulateDeltas: pure function, tested directly (no mock)
// - error paths: timeout, empty response, api_error (mock stream)
// - happy path: marked integration test — requires live API key
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  primaryCall,
  accumulateDeltas,
  PrimaryCallError,
  PRIMARY_CALL_MODEL,
} from '../src/orchestration/primaryCall';
import { PrimaryCallInput, AssemblerOutput, Message } from '../src/orchestration/types';

// ── Mock Stream Builder ───────────────────────────────────────
// Minimal structural mock for the SDK stream handle.
// Fires registered text callbacks in finalMessage() before resolving,
// matching real SDK ordering (all text events fire before stream closes).

interface MockStreamOptions {
  texts?:             string[];
  neverResolve?:      boolean;
  rejectWith?:        Error;
  finalMessageData?:  { usage: { input_tokens: number; output_tokens: number }; model: string };
}

function makeMockClient(options: MockStreamOptions): Anthropic {
  const mock = {
    messages: {
      stream: () => {
        const textCallbacks: Array<(text: string) => void> = [];

        return {
          on(event: string, cb: (text: string) => void) {
            if (event === 'text') textCallbacks.push(cb);
            return this;
          },
          abort() { /* no-op in mock */ },
          finalMessage(): Promise<unknown> {
            if (options.neverResolve) return new Promise(() => { /* intentionally hangs */ });
            if (options.rejectWith)   return Promise.reject(options.rejectWith);
            return new Promise(resolve => {
              // Fire text callbacks before resolving — mirrors real SDK behavior
              (options.texts ?? []).forEach(t => textCallbacks.forEach(cb => cb(t)));
              resolve(options.finalMessageData ?? {
                usage: { input_tokens: 150, output_tokens: 80 },
                model: PRIMARY_CALL_MODEL,
              });
            });
          },
        };
      },
    },
  };
  return mock as unknown as Anthropic;
}

// ── Fixtures ──────────────────────────────────────────────────

const BASE_MESSAGES: Message[] = [
  { role: 'user', content: "What's the PM interval on the 6700?" },
];

const BASE_ASSEMBLER_OUTPUT: AssemblerOutput = {
  systemPrompt:        'You are the OTM assistant.',
  messages:            BASE_MESSAGES,
  tokenEstimate:       3_000,
  contextWindowUsedPct: 2,
  historyTrimmed:      false,
  historyTurnsTrimmed: 0,
};

const BASE_INPUT: PrimaryCallInput = {
  assemblerOutput: BASE_ASSEMBLER_OUTPUT,
  sessionId:       'session-001',
  requestId:       'req-001',
};

// ── Test Runner ───────────────────────────────────────────────

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
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

  async function assertRejects(
    fn: () => Promise<unknown>,
    expectedName: string,
    label: string
  ): Promise<PrimaryCallError> {
    try {
      await fn();
      throw new Error(`Expected ${expectedName} but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(`${label} — got '${(err as Error).name}' instead of '${expectedName}'`);
      }
      return err as PrimaryCallError;
    }
  }

  console.log('\nPrimary Call Tests\n');

  // ── 1. accumulateDeltas — pure function ───────────────────
  test('accumulateDeltas joins deltas in order', () => {
    const result = accumulateDeltas(['Hello', ', ', 'world', '!']);
    assert(result === 'Hello, world!', 'must join all deltas in order');
  });

  test('accumulateDeltas returns empty string for empty array', () => {
    assert(accumulateDeltas([]) === '', 'empty array must return empty string');
  });

  test('accumulateDeltas returns single delta unchanged', () => {
    assert(accumulateDeltas(['only']) === 'only', 'single delta must be returned as-is');
  });

  test('accumulateDeltas preserves whitespace and newlines', () => {
    const result = accumulateDeltas(['line one\n', 'line two\n']);
    assert(result === 'line one\nline two\n', 'whitespace must be preserved exactly');
  });

  // ── 2. Timeout ────────────────────────────────────────────
  await test('throws PrimaryCallError with cause=timeout when stream hangs', async () => {
    const client = makeMockClient({ neverResolve: true });
    const err = await assertRejects(
      () => primaryCall(BASE_INPUT, client, 50), // 50ms timeout for test speed
      'PrimaryCallError',
      'must throw PrimaryCallError on timeout'
    );
    assert(err.cause === 'timeout', `cause must be 'timeout', got '${err.cause}'`);
    assert(err.sessionId === 'session-001', 'must carry sessionId');
    assert(err.requestId === 'req-001', 'must carry requestId');
  });

  // ── 3. Empty response ─────────────────────────────────────
  await test('throws PrimaryCallError with cause=empty_response when buffer is empty', async () => {
    const client = makeMockClient({ texts: [] }); // no text deltas
    const err = await assertRejects(
      () => primaryCall(BASE_INPUT, client),
      'PrimaryCallError',
      'must throw PrimaryCallError on empty response'
    );
    assert(err.cause === 'empty_response', `cause must be 'empty_response', got '${err.cause}'`);
  });

  await test('throws PrimaryCallError with cause=empty_response when response is only whitespace', async () => {
    const client = makeMockClient({ texts: ['   ', '\n', '\t'] });
    const err = await assertRejects(
      () => primaryCall(BASE_INPUT, client),
      'PrimaryCallError',
      'must throw on whitespace-only response'
    );
    assert(err.cause === 'empty_response', `cause must be 'empty_response'`);
  });

  // ── 4. API error ──────────────────────────────────────────
  await test('throws PrimaryCallError with cause=api_error when SDK rejects', async () => {
    const sdkError = new Error('rate_limit_exceeded');
    const client = makeMockClient({ rejectWith: sdkError });
    const err = await assertRejects(
      () => primaryCall(BASE_INPUT, client),
      'PrimaryCallError',
      'must throw PrimaryCallError on API error'
    );
    assert(err.cause === 'api_error', `cause must be 'api_error', got '${err.cause}'`);
    assert(
      err.message.includes('rate_limit_exceeded'),
      'error message must include original SDK error'
    );
  });

  // ── 5. PrimaryCallError carries context ───────────────────
  await test('PrimaryCallError carries sessionId, requestId, and cause', async () => {
    const client = makeMockClient({ neverResolve: true });
    const err = await assertRejects(
      () => primaryCall(BASE_INPUT, client, 50),
      'PrimaryCallError',
      'must throw PrimaryCallError'
    );
    assert(err.name      === 'PrimaryCallError', 'name must be PrimaryCallError');
    assert(err.sessionId === BASE_INPUT.sessionId, 'sessionId must match input');
    assert(err.requestId === BASE_INPUT.requestId, 'requestId must match input');
    assert(typeof err.cause === 'string', 'cause must be a string');
  });

  // ── 6. Output contract (mock happy path) ──────────────────
  await test('returns PrimaryCallOutput with correct shape on success', async () => {
    const client = makeMockClient({
      texts: ['The PM interval ', 'for the 6700 is ', '250 hours per spec.'],
      finalMessageData: {
        usage: { input_tokens: 200, output_tokens: 45 },
        model: PRIMARY_CALL_MODEL,
      },
    });
    const result = await primaryCall(BASE_INPUT, client);
    assert(
      result.responseText === 'The PM interval for the 6700 is 250 hours per spec.',
      'responseText must be fully accumulated'
    );
    assert(result.inputTokens  === 200,             'inputTokens must match usage');
    assert(result.outputTokens === 45,              'outputTokens must match usage');
    assert(result.model        === PRIMARY_CALL_MODEL, 'model must be echoed from response');
    assert(typeof result.durationMs === 'number',   'durationMs must be a number');
    assert(result.durationMs >= 0,                  'durationMs must be non-negative');
  });

  // ── 7. INTEGRATION TEST (skipped — requires live API key) ─
  // To run manually: set ANTHROPIC_API_KEY and call primaryCall with a real client.
  // This covers: actual stream accumulation, real usage metadata, real model string.
  test('[INTEGRATION — skipped] happy path with live API', () => {
    console.log('    → Skipped. Run manually with ANTHROPIC_API_KEY set.');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
