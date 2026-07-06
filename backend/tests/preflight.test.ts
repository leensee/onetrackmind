// ============================================================
// OTM — Pre-Flight Audit Tests
// CJS module. Run via: npm run test:preflight
// Pure function — no mocks required.
// ============================================================

import { runPreflight } from '../src/orchestration/preflight';
import {
  PreflightInput,
  ProcessedEvent,
  ContextualData,
  ActiveFlag,
} from '../src/orchestration/types';

// ── Fixtures ──────────────────────────────────────────────────

const BASE_EVENT: ProcessedEvent = {
  eventType:  'user_message',
  rawContent: "What's the status on pos 13?",
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

const ACKNOWLEDGED_FLAG: ActiveFlag = {
  flagId:       'flag-002',
  type:         'safety',
  content:      'Brake adjustment required on pos 7',
  raisedAt:     new Date().toISOString(),
  acknowledged: true,
};

const EMPTY_CONTEXT: ContextualData = {
  activeFlags:    [],
  openItems:      [],
  consistContext: null,
};

const CONTEXT_WITH_SAFETY: ContextualData = {
  activeFlags:    [SAFETY_FLAG],
  openItems:      [],
  consistContext: null,
};

const CONTEXT_WITH_NUMERIC_SERIAL: ContextualData = {
  activeFlags: [],
  openItems:   [],
  consistContext: {
    consistId:        'HGPT01',
    relevantMachines: [
      { position: 13, name: 'Harsco Jackson 6700 Tamper', serialNumber: '153640' },
    ],
  },
};

const CONTEXT_WITH_ALPHA_SERIAL: ContextualData = {
  activeFlags: [],
  openItems:   [],
  consistContext: {
    consistId:        'HGPT01',
    relevantMachines: [
      { position: 13, name: 'Harsco Jackson 6700 Tamper', serialNumber: 'SN153640' },
    ],
  },
};

function makeInput(overrides: Partial<PreflightInput>): PreflightInput {
  return {
    responseText:     '',
    event:            BASE_EVENT,
    contextualData:   EMPTY_CONTEXT,
    postApproval:     false,
    actionWasInvoked: false,
    gateWasInvoked:   false,
    ...overrides,
  };
}

// ── Test Runner ───────────────────────────────────────────────

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

  function assertFlag(
    input: PreflightInput,
    rule: string,
    severity: 'hold' | 'flag' | 'warn'
  ): void {
    const result = runPreflight(input);
    const flag = result.flags.find(f => f.rule === rule);
    assert(flag !== undefined, `Expected flag '${rule}' but it was not raised`);
    assert(
      flag!.severity === severity,
      `Expected severity '${severity}' for '${rule}', got '${flag!.severity}'`
    );
  }

  function assertNoFlag(input: PreflightInput, rule: string): void {
    const result = runPreflight(input);
    const flag = result.flags.find(f => f.rule === rule);
    assert(flag === undefined, `Expected no flag '${rule}' but it was raised: ${flag?.detail}`);
  }

  console.log('\nPre-Flight Audit Tests\n');

  // ── Rule 1: Autonomous Action Detected ────────────────────
  test("Rule 1: flags 'i've sent' as hold", () => {
    assertFlag(
      makeInput({ responseText: "Done. I've sent the shift update to Blaine." }),
      'AUTONOMOUS_ACTION_DETECTED', 'hold'
    );
  });

  test("Rule 1: flags 'message sent' as hold", () => {
    assertFlag(
      makeInput({ responseText: 'Message sent to Blaine.' }),
      'AUTONOMOUS_ACTION_DETECTED', 'hold'
    );
  });

  test('Rule 1: future tense "I can send" does not flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'I can send this to Blaine when you approve.' }),
      'AUTONOMOUS_ACTION_DETECTED'
    );
  });

  test('Rule 1: postApproval=true suppresses rule', () => {
    assertNoFlag(
      makeInput({ responseText: "I've sent the shift update to Blaine.", postApproval: true }),
      'AUTONOMOUS_ACTION_DETECTED'
    );
  });

  test('Rule 1 (PF-6): actionWasInvoked=true suppresses rule even with past-tense pattern', () => {
    assertNoFlag(
      makeInput({ responseText: "I've sent the shift update to Blaine.", actionWasInvoked: true }),
      'AUTONOMOUS_ACTION_DETECTED'
    );
  });

  test('Rule 1 (PF-6): actionWasInvoked=false + past-tense pattern fires as defense-in-depth', () => {
    assertFlag(
      makeInput({ responseText: "I've sent the shift update to Blaine.", actionWasInvoked: false }),
      'AUTONOMOUS_ACTION_DETECTED', 'hold'
    );
  });

  test('Rule 1 (PF-6): gateWasInvoked=true has no effect on Rule 1 (signal isolation)', () => {
    assertFlag(
      makeInput({ responseText: "I've sent the shift update to Blaine.", gateWasInvoked: true }),
      'AUTONOMOUS_ACTION_DETECTED', 'hold'
    );
  });

  // ── Rule 2: Outbound Draft Without Gate ───────────────────
  test('Rule 2: outbound draft without gate marker flags as hold', () => {
    assertFlag(
      makeInput({ responseText: "To: Blaine\nSubject: Shift Update\n\nHey Blaine, here is today's summary." }),
      'OUTBOUND_DRAFT_WITHOUT_GATE', 'hold'
    );
  });

  test('Rule 2: outbound draft WITH gate marker does not flag', () => {
    assertNoFlag(
      makeInput({ responseText: "To: Blaine\nSubject: Shift Update\n\nHey Blaine, today's summary.\n\nReady to send — confirm?" }),
      'OUTBOUND_DRAFT_WITHOUT_GATE'
    );
  });

  test('Rule 2: postApproval=true suppresses rule', () => {
    assertNoFlag(
      makeInput({ responseText: "To: Blaine\nSubject: Shift Update\n\nSent.", postApproval: true }),
      'OUTBOUND_DRAFT_WITHOUT_GATE'
    );
  });

  test('Rule 2: normal response without outbound indicators does not flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'PM interval for the 6700 is 250 hours per the service manual.' }),
      'OUTBOUND_DRAFT_WITHOUT_GATE'
    );
  });

  test('Rule 2 (PF-7): gateWasInvoked=true suppresses rule even without gate marker text', () => {
    assertNoFlag(
      makeInput({
        responseText:   "To: Blaine\nSubject: Shift Update\n\nHey Blaine, here is today's summary.",
        gateWasInvoked: true,
      }),
      'OUTBOUND_DRAFT_WITHOUT_GATE'
    );
  });

  test('Rule 2 (PF-7): gateWasInvoked=false + outbound draft without marker fires as defense-in-depth', () => {
    assertFlag(
      makeInput({
        responseText:   "To: Blaine\nSubject: Shift Update\n\nHey Blaine, here is today's summary.",
        gateWasInvoked: false,
      }),
      'OUTBOUND_DRAFT_WITHOUT_GATE', 'hold'
    );
  });

  test('Rule 2 (PF-7): actionWasInvoked=true has no effect on Rule 2 (signal isolation)', () => {
    assertFlag(
      makeInput({
        responseText:     "To: Blaine\nSubject: Shift Update\n\nHey Blaine, here is today's summary.",
        actionWasInvoked: true,
      }),
      'OUTBOUND_DRAFT_WITHOUT_GATE', 'hold'
    );
  });

  // ── Rule 3: Safety Flag Not Surfaced ──────────────────────
  test('Rule 3: active safety flag with no terms in response flags', () => {
    assertFlag(
      makeInput({ responseText: 'PM interval for the 6700 is 250 hours.', contextualData: CONTEXT_WITH_SAFETY }),
      'SAFETY_FLAG_NOT_SURFACED', 'flag'
    );
  });

  test('Rule 3: safety flag term present in response clears rule', () => {
    assertNoFlag(
      makeInput({ responseText: 'Hydraulic pressure is still an issue — that leak needs addressing first.', contextualData: CONTEXT_WITH_SAFETY }),
      'SAFETY_FLAG_NOT_SURFACED'
    );
  });

  test('Rule 3: acknowledged flag is not checked', () => {
    assertNoFlag(
      makeInput({ responseText: 'Everything looks good.', contextualData: { ...EMPTY_CONTEXT, activeFlags: [ACKNOWLEDGED_FLAG] } }),
      'SAFETY_FLAG_NOT_SURFACED'
    );
  });

  test('Rule 3: no active safety flags produces no flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'No active issues.' }),
      'SAFETY_FLAG_NOT_SURFACED'
    );
  });

  // ── Rule 4: Unverified Serial Number ──────────────────────
  test('Rule 4A: unverified 6-digit numeric serial flags', () => {
    assertFlag(
      makeInput({ responseText: 'The filter for unit 999888 needs replacing.' }),
      'UNVERIFIED_SERIAL_NUMBER', 'flag'
    );
  });

  test('Rule 4A: numeric serial in consist context clears rule', () => {
    assertNoFlag(
      makeInput({ responseText: 'Check the hydraulics on serial 153640.', contextualData: CONTEXT_WITH_NUMERIC_SERIAL }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4A: numeric serial in event raw content clears rule', () => {
    assertNoFlag(
      makeInput({ event: { ...BASE_EVENT, rawContent: 'Status on unit 153640?' }, responseText: 'Unit 153640 is showing a hydraulic fault.' }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4A: phone context exclusion — number in phone context does not flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'Call Blaine at ext 55012 if anything changes.' }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4B: unverified alphanumeric serial flags', () => {
    assertFlag(
      makeInput({ responseText: 'Unit SN99999 needs the filter replaced.' }),
      'UNVERIFIED_SERIAL_NUMBER', 'flag'
    );
  });

  test('Rule 4B: alphanumeric serial in consist context clears rule (exact match)', () => {
    assertNoFlag(
      makeInput({ responseText: 'Check hydraulics on SN153640.', contextualData: CONTEXT_WITH_ALPHA_SERIAL }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4B: verified numeric serial clears alphanumeric variant in response (bidirectional)', () => {
    assertNoFlag(
      makeInput({ responseText: 'Hydraulics on SN153640 need attention.', contextualData: CONTEXT_WITH_NUMERIC_SERIAL }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4B: verified alphanumeric serial clears numeric variant in response (bidirectional)', () => {
    assertNoFlag(
      makeInput({ responseText: 'Serial 153640 has a hydraulic fault.', contextualData: CONTEXT_WITH_ALPHA_SERIAL }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4B: machine model references with 4 digits do not flag (below min)', () => {
    assertNoFlag(
      makeInput({ responseText: 'The H6700 tamper is the main concern.' }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  test('Rule 4: no serial-like sequences in response produces no flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'PM interval is two hundred fifty hours.' }),
      'UNVERIFIED_SERIAL_NUMBER'
    );
  });

  // ── Rule 5: Unverified Cost Figure ────────────────────────
  // Fixture must not contain estimation markers — 'about', 'roughly', etc. clear the rule.
  test('Rule 5: unverified dollar amount with no estimation language flags', () => {
    assertFlag(
      makeInput({ responseText: 'The filter kit is $1,200 from the supplier.' }),
      'UNVERIFIED_COST_FIGURE', 'flag'
    );
  });

  test('Rule 5: estimation language "estimated" clears rule', () => {
    assertNoFlag(
      makeInput({ responseText: 'That filter kit is estimated at $1,200 depending on the supplier.' }),
      'UNVERIFIED_COST_FIGURE'
    );
  });

  test('Rule 5: estimation language "about" clears rule', () => {
    assertNoFlag(
      makeInput({ responseText: 'Parts run about $500 depending on the vendor.' }),
      'UNVERIFIED_COST_FIGURE'
    );
  });

  test('Rule 5: tilde prefix clears rule', () => {
    assertNoFlag(
      makeInput({ responseText: 'Parts should run ~$500 based on past orders.' }),
      'UNVERIFIED_COST_FIGURE'
    );
  });

  test('Rule 5: cost figure in event content clears rule', () => {
    assertNoFlag(
      makeInput({
        event:        { ...BASE_EVENT, rawContent: 'Got a quote for $1,200 on the filters.' },
        responseText: 'Logged the $1,200 quote for the filter kit.',
      }),
      'UNVERIFIED_COST_FIGURE'
    );
  });

  test('Rule 5: no cost figures in response produces no flag', () => {
    assertNoFlag(
      makeInput({ responseText: 'PM is overdue on the 6700 — recommend doing it today.' }),
      'UNVERIFIED_COST_FIGURE'
    );
  });

  // ── Rule 6: SMS Format Violation ──────────────────────────
  test('Rule 6: markdown in SMS channel produces warn', () => {
    const smsEvent: ProcessedEvent = { ...BASE_EVENT, metadata: { ...BASE_EVENT.metadata, channel: 'sms' } };
    assertFlag(
      makeInput({ responseText: '**PM Status**\n- 6700: overdue\n- 3300: ok', event: smsEvent }),
      'SMS_FORMAT_VIOLATION', 'warn'
    );
  });

  test('Rule 6: markdown in app channel does not flag', () => {
    assertNoFlag(
      makeInput({ responseText: '**PM Status**\n- 6700: overdue\n- 3300: ok' }),
      'SMS_FORMAT_VIOLATION'
    );
  });

  // ── Pass determination ────────────────────────────────────
  test('Pass: no flags → pass=true', () => {
    const result = runPreflight(makeInput({ responseText: 'PM interval is 250 hours.' }));
    assert(result.pass === true, 'no flags must yield pass=true');
    assert(result.flags.length === 0, 'flags array must be empty');
  });

  test('Pass: warn only → pass=true', () => {
    const smsEvent: ProcessedEvent = { ...BASE_EVENT, metadata: { ...BASE_EVENT.metadata, channel: 'sms' } };
    const result = runPreflight(makeInput({ responseText: '**Bold text** in SMS', event: smsEvent }));
    assert(result.pass === true, 'warn-only flags must yield pass=true');
    assert(result.flags.every(f => f.severity === 'warn'), 'all flags must be warn');
  });

  test('Pass: flag severity → pass=false', () => {
    const result = runPreflight(makeInput({ responseText: 'PM interval is 250 hours.', contextualData: CONTEXT_WITH_SAFETY }));
    assert(result.pass === false, 'flag severity must yield pass=false');
  });

  test('Pass: hold severity → pass=false', () => {
    const result = runPreflight(makeInput({ responseText: "I've sent the update to Blaine." }));
    assert(result.pass === false, 'hold severity must yield pass=false');
  });

  test('Pass: postApproval=true suppresses both Rule 1 and Rule 2', () => {
    const result = runPreflight(makeInput({
      responseText: "To: Blaine\nSubject: Update\n\nI've sent the shift update.",
      postApproval: true,
    }));
    assert(!result.flags.some(f => f.rule === 'AUTONOMOUS_ACTION_DETECTED'), 'Rule 1 must not fire when postApproval=true');
    assert(!result.flags.some(f => f.rule === 'OUTBOUND_DRAFT_WITHOUT_GATE'), 'Rule 2 must not fire when postApproval=true');
  });

  test('Pass (PF-6/PF-7): both signals true suppress Rule 1 + Rule 2, pass=true with no flags', () => {
    const result = runPreflight(makeInput({
      responseText:     "To: Blaine\nSubject: Update\n\nI've sent the shift update.",
      actionWasInvoked: true,
      gateWasInvoked:   true,
    }));
    assert(result.pass === true, 'both signals true must yield pass=true');
    assert(result.flags.length === 0, 'both signals true must yield empty flags array');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
