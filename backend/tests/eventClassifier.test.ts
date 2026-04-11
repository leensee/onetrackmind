// ============================================================
// OTM — Event Classifier Tests
// CJS module. Run via: npm run test:classifier
// ============================================================

import { classifyEvent, ClassificationError, RawInput } from '../src/orchestration/eventClassifier';
import { NormalizedEmailNotification } from '../src/orchestration/types';

// ── Helpers ───────────────────────────────────────────────────

const BASE_META = {
  requestId: 'req-001',
  sessionId: 'session-001',
  userId:    'user-001',
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

  function assertThrows(fn: () => void, expectedName: string, message: string): void {
    try {
      fn();
      throw new Error(`Expected ${expectedName} to be thrown but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(
          `${message} — got '${(err as Error).name}' instead of '${expectedName}'`
        );
      }
    }
  }

  console.log('\nEvent Classifier Tests\n');

  // ── 1. app source ─────────────────────────────────────────
  test('classifies app source as user_message', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'app',
      body:   { content: "What's the PM interval on the 6700?" },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'user_message', 'eventType must be user_message');
    assert(result.rawContent === "What's the PM interval on the 6700?", 'rawContent must match body.content');
    assert(result.metadata.channel === 'app', 'channel must be app');
    assert(result.metadata.sessionId === 'session-001', 'sessionId must be set');
  });

  test('throws ClassificationError when app body.content is missing', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'app', body: {} }),
      'ClassificationError',
      'must throw on missing content'
    );
  });

  test('throws ClassificationError when app body.content is blank', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'app', body: { content: '   ' } }),
      'ClassificationError',
      'must throw on blank content'
    );
  });

  test('throws ClassificationError when app body.content is wrong type', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'app', body: { content: 42 } }),
      'ClassificationError',
      'must throw when content is not a string'
    );
  });

  // ── 2. sms source ─────────────────────────────────────────
  // Route handler normalizes provider fields to 'body', 'sender', 'threadId'
  test('classifies sms source as inbound_sms', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'sms',
      body: {
        body:     'Hey, parts shipped yesterday.',
        sender:   '+13125550100',
        threadId: 'thread-abc',
      },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'inbound_sms', 'eventType must be inbound_sms');
    assert(result.rawContent === 'Hey, parts shipped yesterday.', 'rawContent must be verbatim normalized body');
    assert(result.metadata.channel === 'sms', 'channel must be sms');
    assert(result.metadata.sender === '+13125550100', 'sender must come from normalized sender field');
    assert(result.metadata.threadId === 'thread-abc', 'threadId must come from normalized threadId field');
  });

  test('throws ClassificationError when sms body.body field is missing', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'sms', body: { sender: '+13125550100' } }),
      'ClassificationError',
      'must throw on missing body field'
    );
  });

  test('accepts empty string body for sms — valid MMS with no text', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'sms',
      body: { body: '', sender: '+13125550100' },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'inbound_sms', 'should still classify as inbound_sms');
    assert(result.rawContent === '', 'empty body is valid for MMS');
  });

  test('sms metadata sender and threadId are undefined when absent', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'sms',
      body: { body: 'Test message' },
    };
    const result = classifyEvent(input);
    assert(result.metadata.sender === undefined, 'sender must be undefined when absent');
    assert(result.metadata.threadId === undefined, 'threadId must be undefined when absent');
  });

  // ── 3. email source ───────────────────────────────────────
  // Route handler produces NormalizedEmailNotification — classifier
  // never sees provider-specific payload shapes.

  const normalizedEmail: NormalizedEmailNotification = {
    messageId:    'msg-001',
    threadId:     'thread-001',
    emailAddress: 'kurt@example.com',
    provider:     'gmail',
  };

  test('classifies email source as inbound_email', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'email',
      body:   {},
      normalizedEmail,
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'inbound_email', 'eventType must be inbound_email');
    assert(result.metadata.channel === 'email', 'channel must be email');
    assert(result.metadata.sender === 'kurt@example.com', 'sender must come from normalizedEmail.emailAddress');
    assert(result.metadata.threadId === 'thread-001', 'threadId must come from normalizedEmail.threadId');
    assert(result.metadata.emailProvider === 'gmail', 'emailProvider must be carried as metadata');
  });

  test('email rawContent contains messageId, threadId, emailAddress, provider', () => {
    const input: RawInput = { ...BASE_META, source: 'email', body: {}, normalizedEmail };
    const result = classifyEvent(input);
    const parsed = JSON.parse(result.rawContent) as {
      messageId: string; threadId: string; emailAddress: string; provider: string;
    };
    assert(parsed.messageId === 'msg-001', 'rawContent must contain messageId');
    assert(parsed.threadId === 'thread-001', 'rawContent must contain threadId');
    assert(parsed.emailAddress === 'kurt@example.com', 'rawContent must contain emailAddress');
    assert(parsed.provider === 'gmail', 'rawContent must carry provider for context loader use');
  });

  test('email rawContent works with any provider — outlook', () => {
    const outlookEmail: NormalizedEmailNotification = {
      messageId:    'outlook-msg-999',
      emailAddress: 'kurt@company.com',
      provider:     'outlook',
    };
    const input: RawInput = { ...BASE_META, source: 'email', body: {}, normalizedEmail: outlookEmail };
    const result = classifyEvent(input);
    assert(result.eventType === 'inbound_email', 'eventType must be inbound_email regardless of provider');
    const parsed = JSON.parse(result.rawContent) as { provider: string };
    assert(parsed.provider === 'outlook', 'provider must be carried through');
  });

  test('email rawContent threadId is null when not provided', () => {
    const noThread: NormalizedEmailNotification = {
      messageId:    'msg-002',
      emailAddress: 'kurt@example.com',
      provider:     'imap',
    };
    const input: RawInput = { ...BASE_META, source: 'email', body: {}, normalizedEmail: noThread };
    const result = classifyEvent(input);
    const parsed = JSON.parse(result.rawContent) as { threadId: null };
    assert(parsed.threadId === null, 'threadId must be null when absent');
  });

  test('throws ClassificationError when email source missing normalizedEmail', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'email', body: {} }),
      'ClassificationError',
      'must throw when normalizedEmail is absent'
    );
  });

  // ── 4. internal source ────────────────────────────────────
  test('classifies internal source as system_trigger', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'internal',
      body:   {},
      internalPayload: { triggerType: 'pm_overdue', data: { machineId: 'pos-13', daysOverdue: 3 } },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'system_trigger', 'eventType must be system_trigger');
    assert(result.metadata.channel === 'internal', 'channel must be internal');
    const parsed = JSON.parse(result.rawContent) as { triggerType: string };
    assert(parsed.triggerType === 'pm_overdue', 'rawContent must contain triggerType');
  });

  test('throws ClassificationError when internal source missing internalPayload', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'internal', body: {} }),
      'ClassificationError',
      'must throw on missing internalPayload'
    );
  });

  // ── 5. lifecycle source ───────────────────────────────────
  test('classifies lifecycle source as session_lifecycle via internalPayload', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'lifecycle',
      body:   {},
      internalPayload: { triggerType: 'session_open', data: { deviceId: 'tablet-001' } },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'session_lifecycle', 'eventType must be session_lifecycle');
    assert(result.metadata.channel === 'lifecycle', 'channel must be lifecycle');
  });

  test('classifies lifecycle source via body.event fallback', () => {
    const input: RawInput = {
      ...BASE_META,
      source: 'lifecycle',
      body:   { event: 'session_close' },
    };
    const result = classifyEvent(input);
    assert(result.eventType === 'session_lifecycle', 'eventType must be session_lifecycle');
    assert(result.rawContent === 'session_close', 'rawContent must be body.event');
  });

  test('throws ClassificationError when lifecycle missing both payload and body.event', () => {
    assertThrows(
      () => classifyEvent({ ...BASE_META, source: 'lifecycle', body: {} }),
      'ClassificationError',
      'must throw on missing lifecycle content'
    );
  });

  // ── 6. Timestamp ──────────────────────────────────────────
  test('always sets a valid ISO 8601 timestamp', () => {
    const input: RawInput = { ...BASE_META, source: 'app', body: { content: 'test' } };
    const result = classifyEvent(input);
    const ts = new Date(result.timestamp);
    assert(!isNaN(ts.getTime()), 'timestamp must be a valid ISO 8601 date');
  });

  // ── 7. ClassificationError carries context ────────────────
  test('ClassificationError carries requestId and source', () => {
    try {
      classifyEvent({ ...BASE_META, source: 'app', body: {} });
      throw new Error('Expected ClassificationError');
    } catch (err) {
      const ce = err as ClassificationError;
      assert(ce.name === 'ClassificationError', 'error name must be ClassificationError');
      assert(ce.requestId === 'req-001', 'error must carry requestId');
      assert(ce.source === 'app', 'error must carry source');
    }
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
