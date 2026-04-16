// ============================================================
// OTM — Output Router Tests
// CJS module. Run via: npm run test:router
// Pure function tests require no mocks.
// Channel tests use injected mock client functions.
// ============================================================

import {
  formatForSms,
  formatForPush,
  routeToApp,
  routeToSms,
  routeToPush,
  routeToLog,
  routeOutput,
  OutputRouterError,
  SMS_MAX_CHARS,
  PUSH_BODY_MAX_CHARS,
  SmsSend,
  AppWsSend,
  PushSend,
} from '../src/orchestration/outputRouter';
import { RouteInstruction } from '../src/orchestration/types';

// ── Fixtures ──────────────────────────────────────────────────

const BASE_INSTRUCTION: RouteInstruction = {
  channel:    'app',
  sessionId:  'session-001',
  requestId:  'req-001',
};

const SHORT_TEXT = 'PM interval for the 6700 is 250 hours per the service manual.';

const MARKDOWN_TEXT =
  '## PM Status\n**6700 Tamper** — overdue by 3 days.\n- Check hydraulics\n- Replace filters\n```code block```';

// Must exceed SMS_MAX_CHARS (1600). Each sentence is ~24 chars.
// 70 repetitions = 1680 chars of body + prefix = ~1726 chars total.
const LONG_TEXT = 'First sentence here. '
  + 'Third sentence is next. '.repeat(70)
  + 'Final sentence ends here.';

// ── Test Runner ───────────────────────────────────────────────

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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
    fn:           () => Promise<unknown>,
    expectedName: string,
    label:        string
  ): Promise<OutputRouterError> {
    try {
      await fn();
      throw new Error(`Expected ${expectedName} but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(`${label} — got '${(err as Error).name}' instead of '${expectedName}'`);
      }
      return err as OutputRouterError;
    }
  }

  console.log('\nOutput Router Tests\n');

  // ── formatForSms ──────────────────────────────────────────

  test('formatForSms: strips bold markdown', () => {
    const result = formatForSms('**Bold text** here');
    assert(!result[0]!.includes('**'), 'must strip ** markers');
    assert(result[0]!.includes('Bold text'), 'content must be preserved');
  });

  test('formatForSms: strips headers', () => {
    const result = formatForSms('## Section Header\nContent follows');
    assert(!result[0]!.includes('##'), 'must strip header markers');
    assert(result[0]!.includes('Section Header'), 'header text must be preserved');
  });

  test('formatForSms: strips code ticks', () => {
    const result = formatForSms('Use `npm install` to install');
    assert(!result[0]!.includes('`'), 'must strip backticks');
    assert(result[0]!.includes('npm install'), 'content must be preserved');
  });

  test('formatForSms: strips list markers', () => {
    const result = formatForSms('- Item one\n- Item two\n* Item three');
    assert(!result[0]!.match(/^[-*]\s/m), 'must strip list markers');
    assert(result[0]!.includes('Item one'), 'list content must be preserved');
  });

  test('formatForSms: returns single segment for short text', () => {
    const result = formatForSms(SHORT_TEXT);
    assert(result.length === 1, 'short text must produce one segment');
    assert(result[0]!.length <= SMS_MAX_CHARS, 'segment must be within SMS_MAX_CHARS');
  });

  test('formatForSms: splits long text into multiple segments within limit', () => {
    // LONG_TEXT exceeds SMS_MAX_CHARS — must produce more than one segment
    assert(LONG_TEXT.length > SMS_MAX_CHARS, `fixture must exceed ${SMS_MAX_CHARS} chars (got ${LONG_TEXT.length})`);
    const result = formatForSms(LONG_TEXT);
    assert(result.length > 1, `long text must produce multiple segments, got ${result.length}`);
    for (const segment of result) {
      assert(segment.length <= SMS_MAX_CHARS, `segment exceeds SMS_MAX_CHARS: ${segment.length}`);
    }
  });

  test('formatForSms: hard fallback appends ellipsis when no sentence boundary found', () => {
    const noBreak = 'A'.repeat(SMS_MAX_CHARS + 100);
    const result = formatForSms(noBreak);
    assert(result.length > 0, 'must produce at least one segment');
    assert(result[0]!.endsWith('…'), 'hard-truncated segment must end with ellipsis');
    assert(result[0]!.length <= SMS_MAX_CHARS + 1, 'hard-truncated segment must respect limit');
  });

  test('formatForSms: strips full markdown block correctly', () => {
    const result = formatForSms(MARKDOWN_TEXT);
    assert(!result[0]!.includes('##'), 'must strip headers');
    assert(!result[0]!.includes('**'), 'must strip bold');
    assert(!result[0]!.includes('```'), 'must strip code fences');
    assert(!result[0]!.match(/^[-*]\s/m), 'must strip list markers');
  });

 // ── formatForPush ─────────────────────────────────────────
  // Three explicit states per 2026-04-11 Phase 2 audit fix:
  //   1. no key provided          → encryptedContent omitted, notification fires
  //   2. valid key provided       → encryptedContent present (iv, authTag, ciphertext)
  //   3. malformed key provided   → encryptedContent omitted, notification fires
  // Invariant: notification fires in all three states; plaintext never transmitted.

  // Valid test key — 64 hex chars. Deterministic, non-secret, test-only.
  const VALID_TEST_KEY   = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const INVALID_TEST_KEY = 'not-a-valid-hex-key';

  test('formatForPush: no key — encryptedContent omitted, notification fires', () => {
    const result = formatForPush(SHORT_TEXT, 'session-001');
    const notif  = result['notification'] as { title: string; body: string };
    const data   = result['data']         as Record<string, unknown>;
    assert(notif.title === 'OneTrackMind', 'title must be OneTrackMind');
    assert(typeof notif.body === 'string' && notif.body.length > 0, 'body must be non-empty string');
    assert(data['sessionId'] === 'session-001', 'sessionId must be in data');
    assert(!('encryptedContent' in data), 'encryptedContent must be omitted when no key provided');
  });

  test('formatForPush: valid key — encryptedContent present with iv, authTag, ciphertext', () => {
    const result = formatForPush(SHORT_TEXT, 'session-001', VALID_TEST_KEY);
    const data   = result['data'] as Record<string, unknown>;
    assert('encryptedContent' in data, 'encryptedContent must be present when valid key provided');
    const enc = data['encryptedContent'] as { iv: string; authTag: string; ciphertext: string };
    assert(typeof enc.iv === 'string'         && /^[0-9a-f]+$/i.test(enc.iv),         'iv must be hex string');
    assert(typeof enc.authTag === 'string'    && /^[0-9a-f]+$/i.test(enc.authTag),    'authTag must be hex string');
    assert(typeof enc.ciphertext === 'string' && /^[0-9a-f]+$/i.test(enc.ciphertext), 'ciphertext must be hex string');
    assert(enc.ciphertext !== SHORT_TEXT, 'ciphertext must not equal plaintext (no leak)');
    assert(!enc.ciphertext.includes(SHORT_TEXT), 'ciphertext must not contain plaintext substring');
  });

  test('formatForPush: invalid key — encryptedContent omitted, notification fires', () => {
    // Suppress expected console.error during this test only
    const origErr = console.error;
    console.error = () => { /* swallow expected failure log */ };
    try {
      const result = formatForPush(SHORT_TEXT, 'session-001', INVALID_TEST_KEY);
      const notif  = result['notification'] as { title: string; body: string };
      const data   = result['data']         as Record<string, unknown>;
      assert(notif.title === 'OneTrackMind', 'notification must still fire on key failure');
      assert(data['sessionId'] === 'session-001', 'sessionId must be present on key failure');
      assert(!('encryptedContent' in data), 'encryptedContent must be omitted on key failure');
    } finally {
      console.error = origErr;
    }
  });

  test('formatForPush: body truncated to PUSH_BODY_MAX_CHARS', () => {
    const longText = 'X'.repeat(PUSH_BODY_MAX_CHARS + 100);
    const result   = formatForPush(longText, 'session-001');
    const notif    = result['notification'] as { body: string };
    assert(
      notif.body.length <= PUSH_BODY_MAX_CHARS,
      `push body must be ≤ ${PUSH_BODY_MAX_CHARS} chars`
    );
  });
  
  // ── routeToApp ────────────────────────────────────────────

  await test('routeToApp: success delivers to app channel', async () => {
    const mockSend: AppWsSend = async () => { /* success */ };
    const result = await routeToApp(SHORT_TEXT, BASE_INSTRUCTION, mockSend);
    assert(result.success === true, 'must be success');
    assert(result.channel === 'app', 'channel must be app');
    assert(result.delivered.includes('app'), 'must include app in delivered');
    assert(result.failed.length === 0, 'failed must be empty');
    assert(result.segmentCount === 1, 'segmentCount must be 1');
  });

  await test('routeToApp: send failure returns failed with reason', async () => {
    const mockSend: AppWsSend = async () => { throw new Error('WebSocket closed'); };
    const result = await routeToApp(SHORT_TEXT, BASE_INSTRUCTION, mockSend);
    assert(result.success === false, 'must be failure');
    assert(result.failed.length === 1, 'must have one failed entry');
    assert(result.failed[0]!.reason.includes('WebSocket closed'), 'reason must be included');
    assert(result.delivered.length === 0, 'delivered must be empty');
  });

  // ── routeToSms ────────────────────────────────────────────

  await test('routeToSms: single recipient success', async () => {
    const sends: string[] = [];
    const mockSend: SmsSend = async (to) => { sends.push(to); };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'sms', recipients: ['+13125550100'],
    };
    const result = await routeToSms(SHORT_TEXT, instruction, mockSend);
    assert(result.success === true, 'must be success');
    assert(result.delivered.includes('+13125550100'), 'must include recipient in delivered');
    assert(result.segmentCount === 1, 'short text must be 1 segment');
  });

  await test('routeToSms: multiple recipients — partial failure isolated', async () => {
    const mockSend: SmsSend = async (to) => {
      if (to === '+13125550199') throw new Error('invalid number');
    };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION,
      channel:    'sms',
      recipients: ['+13125550100', '+13125550199'],
    };
    const result = await routeToSms(SHORT_TEXT, instruction, mockSend);
    assert(result.success === false, 'partial failure must yield success=false');
    assert(result.delivered.includes('+13125550100'), 'successful recipient in delivered');
    assert(result.failed.some(f => f.recipient === '+13125550199'), 'failed recipient in failed');
    assert(result.failed[0]!.reason.includes('invalid number'), 'reason must be present');
  });

  await test('routeToSms: throws OutputRouterError on empty recipients', async () => {
    const mockSend: SmsSend = async () => { /* no-op */ };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'sms', recipients: [],
    };
    const err = await assertRejects(
      () => routeToSms(SHORT_TEXT, instruction, mockSend),
      'OutputRouterError',
      'must throw on empty recipients'
    );
    assert(err.cause === 'no_recipients', `cause must be no_recipients, got ${err.cause}`);
  });

  await test('routeToSms: SMS text is formatted (markdown stripped) before send', async () => {
    const captured: string[] = [];
    const mockSend: SmsSend = async (_, body) => { captured.push(body); };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'sms', recipients: ['+13125550100'],
    };
    await routeToSms(MARKDOWN_TEXT, instruction, mockSend);
    assert(captured.length > 0, 'must have sent at least one segment');
    assert(!captured[0]!.includes('**'), 'markdown must be stripped before send');
    assert(!captured[0]!.includes('##'), 'headers must be stripped before send');
  });

  // ── routeToPush ───────────────────────────────────────────

  await test('routeToPush: single token success', async () => {
    const mockSend: PushSend = async () => { /* success */ };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'push', recipients: ['fcm-token-abc'],
    };
    const result = await routeToPush(SHORT_TEXT, instruction, mockSend);
    assert(result.success === true, 'must be success');
    assert(result.delivered.includes('fcm-token-abc'), 'token in delivered');
    assert(result.segmentCount === 1, 'push is always 1 segment');
  });

  await test('routeToPush: throws OutputRouterError on empty recipients', async () => {
    const mockSend: PushSend = async () => { /* no-op */ };
    const instruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'push', recipients: [],
    };
    const err = await assertRejects(
      () => routeToPush(SHORT_TEXT, instruction, mockSend),
      'OutputRouterError',
      'must throw on empty recipients'
    );
    assert(err.cause === 'no_recipients', `cause must be no_recipients`);
  });

  // ── routeToLog ────────────────────────────────────────────

  test('routeToLog: returns success result with log channel', () => {
    const result = routeToLog(BASE_INSTRUCTION);
    assert(result.success === true, 'must be success');
    assert(result.channel === 'log', 'channel must be log');
    assert(result.delivered.includes('log'), 'delivered must include log');
    assert(result.segmentCount === 1, 'segmentCount must be 1');
  });

  // ── routeOutput ───────────────────────────────────────────

  await test('routeOutput: routes to correct channel on instruction', async () => {
    const mockSend: AppWsSend = async () => { /* success */ };
    const result = await routeOutput(SHORT_TEXT, BASE_INSTRUCTION, { appWsSend: mockSend });
    assert(result.channel === 'app', 'must route to app channel');
    assert(result.success === true, 'must succeed');
  });

  await test('routeOutput: throws OutputRouterError when required client missing', async () => {
    const smsInstruction: RouteInstruction = {
      ...BASE_INSTRUCTION, channel: 'sms', recipients: ['+13125550100'],
    };
    const err = await assertRejects(
      () => routeOutput(SHORT_TEXT, smsInstruction, {}),
      'OutputRouterError',
      'must throw when smsSend client missing'
    );
    assert(err.cause === 'delivery_error', `cause must be delivery_error, got ${err.cause}`);
    assert(err.channel === 'sms', 'channel must be sms');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
