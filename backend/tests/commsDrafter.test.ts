// ============================================================
// OTM — Comms Drafter Tests
// CJS module. Run via: npm run test:comms
// Pure functions only — no stubs needed.
// ============================================================

import {
  validateToneLevel, validateRecipients,
  validateCommsDraftInput, buildCommsDraft,
  TONE_LEVEL_MIN, TONE_LEVEL_MAX,
  TONE_ANCHOR_NEUTRAL, TONE_ANCHOR_PEER, TONE_ANCHOR_FORMAL,
} from '../src/orchestration/tools/commsDrafter';
import {
  CommsDraftInput, SmsDraftInput, EmailDraftInput,
} from '../src/orchestration/types';

function makeSmsInput(o: Partial<SmsDraftInput> = {}): SmsDraftInput {
  return {
    channel: 'sms', recipients: ['+15550001111'],
    body: 'Shift complete. All machines secured.',
    toneLevel: TONE_ANCHOR_PEER, sessionId: 's1', requestId: 'r1', ...o,
  };
}
function makeEmailInput(o: Partial<EmailDraftInput> = {}): EmailDraftInput {
  return {
    channel: 'email', recipients: ['contact@example.com'],
    subject: 'Daily shift update', body: 'See attached summary.',
    toneLevel: TONE_ANCHOR_FORMAL, sessionId: 's1', requestId: 'r1', ...o,
  };
}

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  // ── validateToneLevel ──────────────────────────────────────

  console.log('\n[commsDrafter] validateToneLevel');

  await test('valid values 0–10 all pass', () => {
    for (let i = TONE_LEVEL_MIN; i <= TONE_LEVEL_MAX; i++) {
      assert(validateToneLevel(i) === null, `${i} should pass`);
    }
  });
  await test('reference anchors are valid', () => {
    assert(validateToneLevel(TONE_ANCHOR_NEUTRAL) === null, 'neutral=0');
    assert(validateToneLevel(TONE_ANCHOR_PEER)    === null, 'peer=5');
    assert(validateToneLevel(TONE_ANCHOR_FORMAL)  === null, 'formal=10');
  });
  await test('below range → error', () => {
    const r = validateToneLevel(-1);
    assert(r !== null && r.includes('toneLevel'), 'error');
  });
  await test('above range → error', () => {
    const r = validateToneLevel(11);
    assert(r !== null && r.includes('toneLevel'), 'error');
  });
  await test('float → error', () => {
    const r = validateToneLevel(5.5);
    assert(r !== null && r.includes('integer'), 'integer error');
  });
  await test('NaN → error', () => {
    assert(validateToneLevel(NaN) !== null, 'NaN error');
  });

  // ── validateRecipients ─────────────────────────────────────

  console.log('\n[commsDrafter] validateRecipients');

  await test('valid recipients array → null', () => {
    assert(validateRecipients(['+15550001111', '+15550002222']) === null, 'null');
  });
  await test('empty array → error', () => {
    assert(validateRecipients([]) !== null, 'error');
  });
  await test('array with empty string → error', () => {
    const r = validateRecipients(['+15550001111', '']);
    assert(r !== null && r.includes('non-empty'), 'error');
  });
  await test('whitespace-only string → error', () => {
    assert(validateRecipients(['   ']) !== null, 'error');
  });

  // ── validateCommsDraftInput ────────────────────────────────

  console.log('\n[commsDrafter] validateCommsDraftInput');

  await test('valid SMS → null', () => {
    assert(validateCommsDraftInput(makeSmsInput()) === null, 'null');
  });
  await test('valid email → null', () => {
    assert(validateCommsDraftInput(makeEmailInput()) === null, 'null');
  });
  await test('invalid channel → error (verbatim guard string)', () => {
    const r = validateCommsDraftInput(makeSmsInput({ channel: 'push' as never }));
    assert(
      r === "channel must be 'sms' or 'email'; got: push",
      `expected verbatim channel-guard string; got: ${r}`,
    );
  });
  await test('empty body → error', () => {
    assert(validateCommsDraftInput(makeSmsInput({ body: '' })) !== null, 'error');
  });
  await test('email missing subject → error', () => {
    const r = validateCommsDraftInput(makeEmailInput({ subject: '' }));
    assert(r !== null && r.includes('subject'), 'subject error');
  });
  await test('subject ignored for SMS → valid', () => {
    assert(validateCommsDraftInput(makeSmsInput()) === null, 'null');
  });
  await test('out-of-range toneLevel → error', () => {
    assert(validateCommsDraftInput(makeSmsInput({ toneLevel: 11 })) !== null, 'error');
  });
  await test('empty replyTo → error', () => {
    const r = validateCommsDraftInput(makeEmailInput({ replyTo: '' }));
    assert(r !== null && r.includes('replyTo'), 'replyTo error');
  });
  await test('absent replyTo is valid', () => {
    assert(validateCommsDraftInput(makeEmailInput()) === null, 'null');
  });

  // ── validateCommsDraftInput — runtime shape guards ─────────

  console.log('\n[commsDrafter] validateCommsDraftInput — runtime shape guards');

  await test('null input → error', () => {
    const r = validateCommsDraftInput(null as unknown as CommsDraftInput);
    assert(r !== null && r.includes('non-null object'), 'non-null object error');
  });
  await test('non-object input (number) → error', () => {
    const r = validateCommsDraftInput(42 as unknown as CommsDraftInput);
    assert(r !== null && r.includes('non-null object'), 'non-null object error');
  });
  await test('non-string body (number) → error', () => {
    const r = validateCommsDraftInput(makeSmsInput({ body: 42 as unknown as string }));
    assert(r !== null && r.includes('body'), 'body error');
  });
  await test('non-string body (null) → error', () => {
    const r = validateCommsDraftInput(makeSmsInput({ body: null as unknown as string }));
    assert(r !== null && r.includes('body'), 'body error');
  });
  await test('non-string subject (number) → error for email', () => {
    const r = validateCommsDraftInput(makeEmailInput({ subject: 99 as unknown as string }));
    assert(r !== null && r.includes('subject'), 'subject error');
  });
  await test('non-string replyTo (number) → error for email', () => {
    const r = validateCommsDraftInput(makeEmailInput({ replyTo: 7 as unknown as string }));
    assert(r !== null && r.includes('replyTo'), 'replyTo error');
  });

  // ── buildCommsDraft ────────────────────────────────────────

  console.log('\n[commsDrafter] buildCommsDraft');

  await test('SMS draft: correct shape and toneLevel', () => {
    const r = buildCommsDraft(makeSmsInput({ toneLevel: 3 }));
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.draft.channel === 'sms', 'channel');
      assert(r.draft.toneLevel === 3, 'toneLevel');
      if (r.draft.channel === 'sms') {
        assert(r.draft.recipients[0] === '+15550001111', 'recipient');
      }
    }
  });
  await test('email draft: correct shape with replyTo', () => {
    const r = buildCommsDraft(makeEmailInput({ replyTo: 'me@example.com' }));
    assert(r.ok === true, 'ok');
    if (r.ok && r.draft.channel === 'email') {
      assert(r.draft.subject === 'Daily shift update', 'subject');
      assert(r.draft.replyTo === 'me@example.com', 'replyTo');
      assert(r.draft.toneLevel === TONE_ANCHOR_FORMAL, 'toneLevel');
    }
  });
  await test('email draft without replyTo: field absent', () => {
    const r = buildCommsDraft(makeEmailInput());
    assert(r.ok === true, 'ok');
    if (r.ok && r.draft.channel === 'email') {
      assert(r.draft.replyTo === undefined, 'replyTo absent');
    }
  });
  await test('body and recipients trimmed in draft', () => {
    const r = buildCommsDraft(makeSmsInput({
      body: '  Shift update  ', recipients: ['  +15550001111  '],
    }));
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.draft.body === 'Shift update', 'body trimmed');
      assert(r.draft.recipients[0] === '+15550001111', 'recipient trimmed');
    }
  });
  await test('validation failure → ok:false with error string', () => {
    const r = buildCommsDraft(makeSmsInput({ body: '' }));
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('body'), 'error message');
  });
  await test('toneLevel 0 (neutral) produces valid draft', () => {
    const r = buildCommsDraft(makeSmsInput({ toneLevel: 0 }));
    assert(r.ok === true && r.draft.toneLevel === 0, 'toneLevel 0 valid');
  });
  await test('toneLevel 10 (formal) produces valid draft', () => {
    const r = buildCommsDraft(makeSmsInput({ toneLevel: 10 }));
    assert(r.ok === true && r.draft.toneLevel === 10, 'toneLevel 10 valid');
  });

  // ── CommsDraftInput discriminated union — type narrowing ──

  console.log('\n[commsDrafter] CommsDraftInput discriminated union — type narrowing');

  await test('email variant exposes subject as string without assertion', () => {
    // If the union collapses back to a flat shape, `subject` would widen to
    // `string | undefined` and this line would require a `!` to compile.
    const email: EmailDraftInput = makeEmailInput();
    const len: number = email.subject.length;
    assert(len > 0, 'subject accessible as non-optional string under EmailDraftInput');
  });
  await test('sms variant has no subject field at compile time', () => {
    const input: CommsDraftInput = makeSmsInput();
    if (input.channel === 'sms') {
      // @ts-expect-error — SmsDraftInput has no `subject` field; if this line
      // ever stops erroring, the discriminated union has regressed to a flat shape.
      const shouldNotCompile: string = input.subject;
      assert(shouldNotCompile === undefined, 'runtime: sms fixture has no subject');
    }
  });

  // ── Summary ───────────────────────────────────────────────

  console.log(`\n[commsDrafter] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
