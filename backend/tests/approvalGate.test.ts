// ============================================================
// OTM — Approval Gate Tests
// CJS module. Run via: npm run test:gate
// Pure function tests require no mocks.
// Async tests use mock EventEmitter and mock WsSend.
// ============================================================

import EventEmitter from 'events';
import {
  buildApprovalMessage,
  buildRegenLimitMessage,
  sendApprovalRequest,
  sendRegenLimitMessage,
  waitForDecision,
  submitFeedback,
  runApprovalGate,
  ApprovalGateError,
  InboundDecisionEvent,
  WsSend,
} from '../src/orchestration/approvalGate';
import { FeedbackPayload } from '../src/orchestration/types';

// ── Fixtures ──────────────────────────────────────────────────

const REQ_ID = 'req-001';
const SESSION_ID = 'session-001';

const BASE_PAYLOAD: FeedbackPayload = {
  sessionId:    SESSION_ID,
  timestamp:    new Date().toISOString(),
  eventType:    'user_message',
  initialInput: 'What is the PM interval?',
  attempts:     [],
  manualRegens: [],
  userAction:   'pending',
  sessionContextSnapshot: {
    activeFlags: [],
    openItems:   [],
  },
};

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
  ): Promise<ApprovalGateError> {
    try {
      await fn();
      throw new Error(`Expected ${expectedName} but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(`${label} — got '${(err as Error).name}' instead of '${expectedName}'`);
      }
      return err as ApprovalGateError;
    }
  }

  console.log('\nApproval Gate Tests\n');

  // ── buildApprovalMessage ──────────────────────────────────
  test('buildApprovalMessage: correct shape and options', () => {
    const msg = buildApprovalMessage(REQ_ID, 'Here is the draft shift update.');
    assert(msg['type'] === 'approval_required', 'type must be approval_required');
    assert(msg['requestId'] === REQ_ID, 'requestId must match');
    assert(msg['content'] === 'Here is the draft shift update.', 'content must match');
    const options = msg['options'] as string[];
    assert(Array.isArray(options), 'options must be array');
    assert(options.includes('approve'), 'must include approve');
    assert(options.includes('reject'), 'must include reject');
    assert(options.includes('edit'), 'must include edit');
  });

  // ── buildRegenLimitMessage ────────────────────────────────
  test('buildRegenLimitMessage: correct shape and options', () => {
    const msg = buildRegenLimitMessage(REQ_ID, 'Draft text', 'PM interval not verified');
    assert(msg['type'] === 'regen_limit', 'type must be regen_limit');
    assert(msg['requestId'] === REQ_ID, 'requestId must match');
    assert(msg['draft'] === 'Draft text', 'draft must match');
    assert(msg['auditFlag'] === 'PM interval not verified', 'auditFlag must match');
    const options = msg['options'] as string[];
    assert(options.includes('try_again'), 'must include try_again');
    assert(options.includes('use_as_is'), 'must include use_as_is');
    assert(options.includes('drop'), 'must include drop');
    assert(options.includes('send_feedback'), 'must include send_feedback');
  });

  // ── sendApprovalRequest ───────────────────────────────────
  test('sendApprovalRequest: calls wsSend with correct message', () => {
    let captured: Record<string, unknown> | null = null;
    const mockSend: WsSend = (payload) => { captured = payload; };
    sendApprovalRequest(REQ_ID, 'Draft content', mockSend);
    assert(captured !== null, 'wsSend must be called');
    assert(captured!['type'] === 'approval_required', 'type must be approval_required');
    assert(captured!['requestId'] === REQ_ID, 'requestId must match');
  });

  test('sendApprovalRequest: throws ApprovalGateError with cause=send_error on failure', () => {
    const failSend: WsSend = () => { throw new Error('WebSocket closed'); };
    let threw = false;
    try {
      sendApprovalRequest(REQ_ID, 'content', failSend);
    } catch (err) {
      const e = err as ApprovalGateError;
      assert(e.name === 'ApprovalGateError', 'must be ApprovalGateError');
      assert(e.cause === 'send_error', 'cause must be send_error');
      threw = true;
    }
    assert(threw, 'must throw on send failure');
  });

  // ── sendRegenLimitMessage ─────────────────────────────────
  test('sendRegenLimitMessage: calls wsSend with correct message', () => {
    let captured: Record<string, unknown> | null = null;
    const mockSend: WsSend = (payload) => { captured = payload; };
    sendRegenLimitMessage(REQ_ID, 'Draft', 'Audit flag text', mockSend);
    assert(captured !== null, 'wsSend must be called');
    assert(captured!['type'] === 'regen_limit', 'type must be regen_limit');
  });

  test('sendRegenLimitMessage: throws ApprovalGateError with cause=send_error on failure', () => {
    const failSend: WsSend = () => { throw new Error('WebSocket closed'); };
    let threw = false;
    try {
      sendRegenLimitMessage(REQ_ID, 'Draft', 'Flag', failSend);
    } catch (err) {
      const e = err as ApprovalGateError;
      assert(e.cause === 'send_error', 'cause must be send_error');
      threw = true;
    }
    assert(threw, 'must throw on send failure');
  });

  // ── waitForDecision ───────────────────────────────────────
  await test('waitForDecision: resolves on matching decision event', async () => {
    const emitter = new EventEmitter();
    setTimeout(() => {
      const event: InboundDecisionEvent = {
        type: 'approval_response', requestId: REQ_ID, decision: 'approve',
      };
      emitter.emit('decision', event);
    }, 10);
    const result = await waitForDecision(REQ_ID, emitter, 1_000);
    assert(result === 'approve', 'must resolve with approve decision');
  });

  await test('waitForDecision: ignores events with non-matching requestId', async () => {
    const emitter = new EventEmitter();
    setTimeout(() => {
      // Wrong requestId first
      emitter.emit('decision', {
        type: 'approval_response', requestId: 'req-999', decision: 'reject',
      });
      // Correct requestId second
      emitter.emit('decision', {
        type: 'approval_response', requestId: REQ_ID, decision: 'approve',
      });
    }, 10);
    const result = await waitForDecision(REQ_ID, emitter, 1_000);
    assert(result === 'approve', 'must resolve on matching requestId only');
  });

  await test('waitForDecision: times out and rejects with cause=timeout', async () => {
    const emitter = new EventEmitter();
    const err = await assertRejects(
      () => waitForDecision(REQ_ID, emitter, 30), // 30ms for test speed
      'ApprovalGateError',
      'must throw ApprovalGateError on timeout'
    );
    assert(err.cause === 'timeout', `cause must be timeout, got ${err.cause}`);
    assert(err.requestId === REQ_ID, 'must carry requestId');
  });

  await test('waitForDecision: removes listener after resolution (no memory leak)', async () => {
    const emitter = new EventEmitter();
    setTimeout(() => {
      emitter.emit('decision', {
        type: 'approval_response', requestId: REQ_ID, decision: 'approve',
      });
    }, 10);
    await waitForDecision(REQ_ID, emitter, 1_000);
    assert(emitter.listenerCount('decision') === 0, 'listener must be removed after resolution');
  });

  await test('waitForDecision: removes listener after timeout (no memory leak)', async () => {
    const emitter = new EventEmitter();
    try {
      await waitForDecision(REQ_ID, emitter, 20);
    } catch {
      // expected timeout
    }
    assert(emitter.listenerCount('decision') === 0, 'listener must be removed after timeout');
  });

  await test('waitForDecision: resolves with any valid decision type', async () => {
    const decisions: Array<InboundDecisionEvent['decision']> = [
      'reject', 'edit', 'try_again', 'use_as_is', 'drop', 'send_feedback',
    ];
    for (const decision of decisions) {
      const emitter = new EventEmitter();
      setTimeout(() => {
        emitter.emit('decision', { type: 'approval_response', requestId: REQ_ID, decision });
      }, 5);
      const result = await waitForDecision(REQ_ID, emitter, 500);
      assert(result === decision, `must resolve with ${decision}`);
    }
  });

  // ── submitFeedback ────────────────────────────────────────
  // Mock global fetch for these tests

  await test('submitFeedback: calls GitHub API with correct shape', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body as string);
      capturedHeaders = opts.headers as Record<string, string>;
      return { ok: true, status: 201, statusText: 'Created' };
    };
    (global as unknown as { fetch: unknown }).fetch = mockFetch;

    await submitFeedback(BASE_PAYLOAD, 'test-token');

    assert(capturedUrl.includes('leensee/onetrackmind'), 'must post to correct repo');
    assert(
      capturedHeaders['Authorization'] === 'Bearer test-token',
      'must include auth header'
    );
    const body = capturedBody as { labels: string[] };
    assert(body.labels.includes('audit-failure'), 'must include audit-failure label');
    assert(body.labels.includes('regen-limit-reached'), 'must include regen-limit-reached label');
  });

  await test('submitFeedback: calls fallback email fn on GitHub API non-2xx', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => ({
      ok: false, status: 422, statusText: 'Unprocessable Entity',
    });

    let fallbackCalled = false;
    let capturedPayload: FeedbackPayload | null = null;
    await submitFeedback(BASE_PAYLOAD, 'test-token', async (payload) => {
      fallbackCalled = true;
      capturedPayload = payload;
    });
    assert(fallbackCalled, 'fallback must be called on non-2xx response');
    assert(capturedPayload !== null, 'fallback must receive a FeedbackPayload');
    assert(
      JSON.stringify(capturedPayload) === JSON.stringify(BASE_PAYLOAD),
      'fallback must receive a FeedbackPayload matching the gate input by value'
    );
  });

  await test('submitFeedback: throws ApprovalGateError when both GitHub and email fail', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('network error');
    };

    const err = await assertRejects(
      () => submitFeedback(BASE_PAYLOAD, 'test-token', async () => {
        throw new Error('email also failed');
      }),
      'ApprovalGateError',
      'must throw when all channels fail'
    );
    assert(err.cause === 'feedback_error', `cause must be feedback_error, got ${err.cause}`);
  });

  await test('submitFeedback: succeeds without fallback when GitHub API succeeds', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true, status: 201, statusText: 'Created',
    });
    // Should not throw
    await submitFeedback(BASE_PAYLOAD, 'test-token');
    assert(true, 'must not throw on success');
  });

  // token: undefined — absent token paths

  await test('submitFeedback: calls fallback directly when token is undefined', async () => {
    // fetch must not be called — set it to throw so the test fails loudly if it is
    (global as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('fetch must not be called when token is undefined');
    };
    let fallbackCalled = false;
    let capturedPayload: FeedbackPayload | null = null;
    await submitFeedback(BASE_PAYLOAD, undefined, async (payload) => {
      fallbackCalled = true;
      capturedPayload = payload;
    });
    assert(fallbackCalled, 'fallback must be called when token is undefined');
    assert(
      capturedPayload === BASE_PAYLOAD,
      'fallback must receive the same FeedbackPayload reference on the no-token path'
    );
  });

  await test('submitFeedback: fallback receives a complete FeedbackPayload with all required fields', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('fetch must not be called when token is undefined');
    };
    let capturedPayload: FeedbackPayload | null = null;
    await submitFeedback(BASE_PAYLOAD, undefined, async (payload) => {
      capturedPayload = payload;
    });
    assert(capturedPayload !== null, 'fallback must be invoked');
    const p = capturedPayload as unknown as FeedbackPayload;
    assert(typeof p.sessionId === 'string' && p.sessionId.length > 0, 'sessionId required');
    assert(typeof p.timestamp === 'string' && p.timestamp.length > 0, 'timestamp required');
    assert(typeof p.eventType === 'string', 'eventType required');
    assert(typeof p.initialInput === 'string', 'initialInput required');
    assert(Array.isArray(p.attempts), 'attempts required (array)');
    assert(Array.isArray(p.manualRegens), 'manualRegens required (array)');
    assert(typeof p.userAction === 'string', 'userAction required');
    assert(
      p.sessionContextSnapshot !== null && typeof p.sessionContextSnapshot === 'object',
      'sessionContextSnapshot required'
    );
    assert(
      Array.isArray(p.sessionContextSnapshot.activeFlags),
      'sessionContextSnapshot.activeFlags required (array)'
    );
    assert(
      Array.isArray(p.sessionContextSnapshot.openItems),
      'sessionContextSnapshot.openItems required (array)'
    );
  });

  await test('submitFeedback: throws feedback_error when token is undefined and no fallback', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('fetch must not be called when token is undefined');
    };
    const err = await assertRejects(
      () => submitFeedback(BASE_PAYLOAD, undefined),
      'ApprovalGateError',
      'must throw ApprovalGateError when no token and no fallback'
    );
    assert(err.cause === 'feedback_error', `cause must be feedback_error, got ${err.cause}`);
    assert(err.requestId === SESSION_ID, 'must carry sessionId as requestId');
  });

  await test('submitFeedback: throws feedback_error when token is undefined and fallback also fails', async () => {
    (global as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error('fetch must not be called when token is undefined');
    };
    const err = await assertRejects(
      () => submitFeedback(BASE_PAYLOAD, undefined, async () => {
        throw new Error('email also failed');
      }),
      'ApprovalGateError',
      'must throw when token absent and fallback fails'
    );
    assert(err.cause === 'feedback_error', `cause must be feedback_error, got ${err.cause}`);
  });

  // ── runApprovalGate ───────────────────────────────────────
  await test('runApprovalGate: sends message and returns decision', async () => {
    const emitter = new EventEmitter();
    let sent = false;
    const mockSend: WsSend = () => { sent = true; };

    setTimeout(() => {
      emitter.emit('decision', {
        type: 'approval_response', requestId: REQ_ID, decision: 'approve',
      });
    }, 10);

    const result = await runApprovalGate(REQ_ID, 'Draft content', mockSend, emitter, 1_000);
    assert(sent, 'wsSend must be called');
    assert(result === 'approve', 'must return the decision');
  });

  await test('runApprovalGate: propagates send error', async () => {
    const emitter = new EventEmitter();
    const failSend: WsSend = () => { throw new Error('WebSocket closed'); };
    const err = await assertRejects(
      () => runApprovalGate(REQ_ID, 'content', failSend, emitter, 1_000),
      'ApprovalGateError',
      'must propagate send error'
    );
    assert(err.cause === 'send_error', 'cause must be send_error');
  });

  await test('runApprovalGate: propagates timeout', async () => {
    const emitter = new EventEmitter();
    const mockSend: WsSend = () => { /* no-op */ };
    const err = await assertRejects(
      () => runApprovalGate(REQ_ID, 'content', mockSend, emitter, 30),
      'ApprovalGateError',
      'must propagate timeout'
    );
    assert(err.cause === 'timeout', 'cause must be timeout');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
