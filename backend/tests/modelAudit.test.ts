// ============================================================
// OTM — Model Audit Tests
// CJS module. Run via: npm run test:audit
// Pure function tests require no mocks.
// Error path tests use minimal mock client.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  shouldRunModelAudit,
  buildAuditPrompt,
  parseAuditResponse,
  runModelAudit,
  ModelAuditError,
  MODEL_AUDIT_MODEL,
} from '../src/orchestration/modelAudit';
import {
  ProcessedEvent,
  ContextualData,
  PreflightResult,
  ModelAuditInput,
  ActiveFlag,
} from '../src/orchestration/types';
import { MODEL_AUDIT_PROMPT } from '../src/config/model-audit-prompt';
import { loadStringExport } from '../src/orchestration/configLoader';

// Path used by every runModelAudit call site. Relative to backend/ (PROJECT_ROOT).
const MODEL_AUDIT_PROMPT_PATH = 'src/config/model-audit-prompt';

// ── Fixtures ──────────────────────────────────────────────────

const BASE_EVENT: ProcessedEvent = {
  eventType:  'user_message',
  rawContent: "What's the PM interval on the 6700?",
  metadata:   { sessionId: 'session-001', userId: 'user-001', channel: 'app' },
  timestamp:  new Date().toISOString(),
};

const SAFETY_FLAG: ActiveFlag = {
  flagId:       'flag-001',
  type:         'safety',
  content:      'Hydraulic line visibly leaking on pos 13',
  raisedAt:     new Date().toISOString(),
  acknowledged: false,
};

const ACKNOWLEDGED_SAFETY_FLAG: ActiveFlag = {
  ...SAFETY_FLAG,
  flagId:       'flag-002',
  acknowledged: true,
};

const EMPTY_CONTEXT: ContextualData = {
  activeFlags:    [],
  openItems:      [],
  consistContext: null,
};

const CONTEXT_WITH_SAFETY: ContextualData = {
  ...EMPTY_CONTEXT,
  activeFlags: [SAFETY_FLAG],
};

const CLEAN_PREFLIGHT: PreflightResult = { pass: true, flags: [] };

const FAILED_PREFLIGHT: PreflightResult = {
  pass:  false,
  flags: [{ rule: 'SAFETY_FLAG_NOT_SURFACED', detail: 'test', severity: 'flag' }],
};

const BASE_AUDIT_INPUT: ModelAuditInput = {
  responseText:   'PM interval for the 6700 tamper is 250 hours per the service manual.',
  event:          BASE_EVENT,
  contextualData: EMPTY_CONTEXT,
  preflightFlags: [],
  sessionId:      'session-001',
  requestId:      'req-001',
};

// ── Mock Client Builder ───────────────────────────────────────

interface MockCreateOptions {
  responseText?:  string;
  rejectWith?:    Error;
  neverResolve?:  boolean;
}

function makeMockClient(options: MockCreateOptions): Anthropic {
  const mock = {
    messages: {
      create: (): Promise<unknown> => {
        if (options.neverResolve) return new Promise(() => { /* intentionally hangs */ });
        if (options.rejectWith)   return Promise.reject(options.rejectWith);
        return Promise.resolve({
          content: [{ type: 'text', text: options.responseText ?? '{"result":"pass","issue":null,"correction":null}' }],
          usage:   { input_tokens: 200, output_tokens: 30 },
          model:   MODEL_AUDIT_MODEL,
        });
      },
    },
  };
  return mock as unknown as Anthropic;
}

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
    fn: () => Promise<unknown>,
    expectedName: string,
    label: string
  ): Promise<ModelAuditError> {
    try {
      await fn();
      throw new Error(`Expected ${expectedName} but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(`${label} — got '${(err as Error).name}' instead of '${expectedName}'`);
      }
      return err as ModelAuditError;
    }
  }

  console.log('\nModel Audit Tests\n');

  // ── shouldRunModelAudit ───────────────────────────────────

  test('shouldRunModelAudit: user_message + clean preflight + no safety flags → skip (false)', () => {
    const result = shouldRunModelAudit(BASE_EVENT, EMPTY_CONTEXT, CLEAN_PREFLIGHT);
    assert(result === false, 'all skip conditions met — must return false');
  });

  test('shouldRunModelAudit: user_message + clean preflight + active safety flag → run (true)', () => {
    const result = shouldRunModelAudit(BASE_EVENT, CONTEXT_WITH_SAFETY, CLEAN_PREFLIGHT);
    assert(result === true, 'active safety flag — must run audit');
  });

  test('shouldRunModelAudit: user_message + clean preflight + acknowledged safety flag only → skip (false)', () => {
    const ctx: ContextualData = { ...EMPTY_CONTEXT, activeFlags: [ACKNOWLEDGED_SAFETY_FLAG] };
    const result = shouldRunModelAudit(BASE_EVENT, ctx, CLEAN_PREFLIGHT);
    assert(result === false, 'only acknowledged flags — must skip');
  });

  test('shouldRunModelAudit: user_message + failed preflight + no safety flags → run (true)', () => {
    const result = shouldRunModelAudit(BASE_EVENT, EMPTY_CONTEXT, FAILED_PREFLIGHT);
    assert(result === true, 'failed preflight — must run audit');
  });

  test('shouldRunModelAudit: inbound_sms event → run (true)', () => {
    const smsEvent: ProcessedEvent = { ...BASE_EVENT, eventType: 'inbound_sms' };
    const result = shouldRunModelAudit(smsEvent, EMPTY_CONTEXT, CLEAN_PREFLIGHT);
    assert(result === true, 'inbound_sms — condition 3 fails — must run audit');
  });

  test('shouldRunModelAudit: inbound_email event → run (true)', () => {
    const emailEvent: ProcessedEvent = { ...BASE_EVENT, eventType: 'inbound_email' };
    const result = shouldRunModelAudit(emailEvent, EMPTY_CONTEXT, CLEAN_PREFLIGHT);
    assert(result === true, 'inbound_email — condition 3 fails — must run audit');
  });

  test('shouldRunModelAudit: system_trigger event → run (true)', () => {
    const triggerEvent: ProcessedEvent = { ...BASE_EVENT, eventType: 'system_trigger' };
    const result = shouldRunModelAudit(triggerEvent, EMPTY_CONTEXT, CLEAN_PREFLIGHT);
    assert(result === true, 'system_trigger — condition 3 fails — must run audit');
  });

  // ── parseAuditResponse ────────────────────────────────────

  test('parseAuditResponse: parses pass result correctly', () => {
    const result = parseAuditResponse('{"result":"pass","issue":null,"correction":null}');
    assert(result.result === 'pass', 'result must be pass');
    assert(result.issue === undefined, 'issue must be undefined for null');
    assert(result.correction === undefined, 'correction must be undefined for null');
  });

  test('parseAuditResponse: parses flag result with issue and correction', () => {
    const raw = '{"result":"flag","issue":"Safety flag not addressed","correction":"Mention the hydraulic leak at pos 13"}';
    const result = parseAuditResponse(raw);
    assert(result.result === 'flag', 'result must be flag');
    assert(result.issue === 'Safety flag not addressed', 'issue must be present');
    assert(result.correction === 'Mention the hydraulic leak at pos 13', 'correction must be present');
  });

  test('parseAuditResponse: parses revise result correctly', () => {
    const raw = '{"result":"revise","issue":"PM interval fabricated","correction":"PM interval is unknown — data not in verified sources"}';
    const result = parseAuditResponse(raw);
    assert(result.result === 'revise', 'result must be revise');
    assert(typeof result.issue === 'string', 'issue must be string');
    assert(typeof result.correction === 'string', 'correction must be string');
  });

  test('parseAuditResponse: strips markdown fences defensively', () => {
    const raw = '```json\n{"result":"pass","issue":null,"correction":null}\n```';
    const result = parseAuditResponse(raw);
    assert(result.result === 'pass', 'must parse correctly after stripping fences');
  });

  test('parseAuditResponse: throws on invalid JSON', () => {
    let threw = false;
    try {
      parseAuditResponse('not valid json at all');
    } catch {
      threw = true;
    }
    assert(threw, 'must throw on invalid JSON');
  });

  test('parseAuditResponse: throws on missing or invalid result field', () => {
    let threw = false;
    try {
      parseAuditResponse('{"result":"unknown","issue":null,"correction":null}');
    } catch {
      threw = true;
    }
    assert(threw, 'must throw when result is not pass|flag|revise');
  });

  // ── buildAuditPrompt ──────────────────────────────────────

  test('buildAuditPrompt: includes event type and channel', () => {
    const prompt = buildAuditPrompt(BASE_AUDIT_INPUT);
    assert(prompt.includes('EVENT TYPE: user_message'), 'must include event type');
    assert(prompt.includes('CHANNEL: app'), 'must include channel');
  });

  test('buildAuditPrompt: includes response text', () => {
    const prompt = buildAuditPrompt(BASE_AUDIT_INPUT);
    assert(prompt.includes(BASE_AUDIT_INPUT.responseText), 'must include response text');
  });

  test('buildAuditPrompt: includes active safety flag content', () => {
    const inputWithSafety: ModelAuditInput = {
      ...BASE_AUDIT_INPUT,
      contextualData: CONTEXT_WITH_SAFETY,
    };
    const prompt = buildAuditPrompt(inputWithSafety);
    assert(prompt.includes('Hydraulic line visibly leaking'), 'must include safety flag content');
  });

  test('buildAuditPrompt: includes pre-flight findings', () => {
    const inputWithFlags: ModelAuditInput = {
      ...BASE_AUDIT_INPUT,
      preflightFlags: [{ rule: 'SMS_FORMAT_VIOLATION', detail: 'markdown in SMS', severity: 'warn' }],
    };
    const prompt = buildAuditPrompt(inputWithFlags);
    assert(prompt.includes('SMS_FORMAT_VIOLATION'), 'must include pre-flight rule');
    assert(prompt.includes('WARN'), 'must include severity');
  });

  test('buildAuditPrompt: shows "none" when no safety flags', () => {
    const prompt = buildAuditPrompt(BASE_AUDIT_INPUT);
    assert(prompt.includes('ACTIVE SAFETY FLAGS:'), 'must include safety flags section');
    assert(prompt.includes('none'), 'must show none when no flags');
  });

  // ── runModelAudit error paths ─────────────────────────────

  await test('runModelAudit: timeout throws ModelAuditError with cause=timeout', async () => {
    const client = makeMockClient({ neverResolve: true });
    const err = await assertRejects(
      () => runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH, 50),
      'ModelAuditError',
      'must throw ModelAuditError on timeout'
    );
    assert(err.cause === 'timeout', `cause must be timeout, got ${err.cause}`);
    assert(err.sessionId === 'session-001', 'must carry sessionId');
    assert(err.requestId === 'req-001', 'must carry requestId');
  });

  await test('runModelAudit: API error throws ModelAuditError with cause=api_error', async () => {
    const client = makeMockClient({ rejectWith: new Error('rate_limit_exceeded') });
    const err = await assertRejects(
      () => runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH),
      'ModelAuditError',
      'must throw ModelAuditError on API error'
    );
    assert(err.cause === 'api_error', `cause must be api_error, got ${err.cause}`);
    assert(err.message.includes('rate_limit_exceeded'), 'must include original error message');
  });

  await test('runModelAudit: invalid JSON response throws ModelAuditError with cause=invalid_json', async () => {
    const client = makeMockClient({ responseText: 'this is not json' });
    const err = await assertRejects(
      () => runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH),
      'ModelAuditError',
      'must throw ModelAuditError on invalid JSON'
    );
    assert(err.cause === 'invalid_json', `cause must be invalid_json, got ${err.cause}`);
  });

  await test('runModelAudit: returns pass result on valid pass response', async () => {
    const client = makeMockClient({ responseText: '{"result":"pass","issue":null,"correction":null}' });
    const result = await runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH);
    assert(result.result === 'pass', 'result must be pass');
    assert(result.issue === undefined, 'issue must be undefined');
  });

  await test('runModelAudit: returns flag result with issue and correction', async () => {
    const client = makeMockClient({
      responseText: '{"result":"flag","issue":"Tone too formal for peer channel","correction":"Use direct peer register — remove corporate phrasing"}',
    });
    const result = await runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH);
    assert(result.result === 'flag', 'result must be flag');
    assert(typeof result.issue === 'string', 'issue must be string');
    assert(typeof result.correction === 'string', 'correction must be string');
  });

  await test('runModelAudit: returns revise result with issue and correction', async () => {
    const client = makeMockClient({
      responseText: '{"result":"revise","issue":"PM interval not in verified sources","correction":"PM interval for this unit is not in logged data — surface the data gap instead"}',
    });
    const result = await runModelAudit(BASE_AUDIT_INPUT, client, MODEL_AUDIT_PROMPT_PATH);
    assert(result.result === 'revise', 'result must be revise');
    assert(typeof result.issue === 'string', 'must have issue');
    assert(typeof result.correction === 'string', 'must have correction');
  });

  await test('runModelAudit: missing prompt file throws with path and export name in message', async () => {
    const client = makeMockClient({});
    let threw = false;
    let message = '';
    let cause: string | undefined;
    let isModelAuditError = false;
    try {
      await runModelAudit(BASE_AUDIT_INPUT, client, 'src/config/does-not-exist');
    } catch (err) {
      threw = true;
      message = (err as Error).message;
      isModelAuditError = err instanceof ModelAuditError;
      cause = isModelAuditError ? (err as ModelAuditError).cause : undefined;
    }
    assert(threw, 'must throw when prompt path does not resolve');
    assert(isModelAuditError, 'thrown error must be a ModelAuditError');
    assert(cause === 'config_error', `cause must be config_error — got: ${cause}`);
    assert(message.includes('src/config/does-not-exist'), 'error message must name the path');
    assert(message.includes('MODEL_AUDIT_PROMPT'), 'error message must name the export');
  });

  await test('runModelAudit: loader path + export name resolve to the same string as the module import (anti-drift)', () => {
    const viaLoader = loadStringExport(MODEL_AUDIT_PROMPT_PATH, 'MODEL_AUDIT_PROMPT');
    assert(
      viaLoader === MODEL_AUDIT_PROMPT,
      'loaded prompt must equal the directly-imported MODEL_AUDIT_PROMPT constant',
    );
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
