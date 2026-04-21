// ============================================================
// OTM — Formatters Tests
// CJS module. Run via: npm run test:formatters
// Covers the shared formatters module (OT-9 + PA-8/MA-5/PF-15
// Pattern 7 fold-ins from Phase 3 audit 2026-04-16).
// ============================================================

import {
  formatActiveFlag,
  formatOpenItem,
  formatMachineRef,
  formatActiveFlags,
  formatOpenItems,
  formatConsistContext,
  formatDraftForApproval,
  SMS_MARKDOWN_PATTERNS,
} from '../src/orchestration/formatters';
import { buildAuditPrompt } from '../src/orchestration/modelAudit';
import {
  ActiveFlag,
  OpenItem,
  MachineRef,
  ConsistContext,
  TodoDraft,
  SmsDraft,
  EmailDraft,
  PoDocument,
  ModelAuditInput,
  ProcessedEvent,
  ContextualData,
} from '../src/orchestration/types';

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

  function assertEqual(actual: string, expected: string, label: string): void {
    if (actual !== expected) {
      throw new Error(
        `${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
      );
    }
  }

  console.log('\nformatters Tests\n');

  // ── Fixtures ────────────────────────────────────────────────
  const safetyFlag: ActiveFlag = {
    flagId:       'f-1',
    type:         'safety',
    content:      'Hydraulic line leaking on pos 13',
    raisedAt:     '2026-04-16T00:00:00Z',
    acknowledged: false,
  };
  const pushFlag: ActiveFlag = {
    flagId:       'f-2',
    type:         'push',
    content:      'New memo from Nathan',
    raisedAt:     '2026-04-16T00:00:00Z',
    acknowledged: false,
  };
  const pullFlag:  ActiveFlag = { ...safetyFlag, flagId: 'f-3', type: 'pull',  content: 'Brake cert update' };
  const auditFlag: ActiveFlag = { ...safetyFlag, flagId: 'f-4', type: 'audit', content: 'Log this interaction' };

  const partsItem: OpenItem = {
    itemId:   'i-1',
    category: 'parts',
    content:  'Need K7 filter',
    priority: 1,
    isPush:   false,
  };
  const pushComplianceItem: OpenItem = {
    itemId:   'i-2',
    category: 'compliance',
    content:  'Brake cert due 3/15',
    priority: 2,
    isPush:   true,
  };

  const machineWithSerial:    MachineRef = { position: 13, name: 'Harsco Jackson 6700 Tamper', serialNumber: '153640' };
  const machineWithoutSerial: MachineRef = { position: 1,  name: 'Nordco CX Spiker #1' };

  const consistCtx: ConsistContext = {
    consistId:        'HGPT01',
    relevantMachines: [machineWithSerial, machineWithoutSerial],
  };

  // ── 1. formatActiveFlag ─────────────────────────────────────
  test('formatActiveFlag: safety type uppercased and bracketed', () => {
    assertEqual(
      formatActiveFlag(safetyFlag),
      '[SAFETY] Hydraulic line leaking on pos 13',
      'safety flag mismatch',
    );
  });
  test('formatActiveFlag: push type uppercased', () => {
    assertEqual(formatActiveFlag(pushFlag), '[PUSH] New memo from Nathan', 'push flag mismatch');
  });
  test('formatActiveFlag: pull type uppercased', () => {
    assertEqual(formatActiveFlag(pullFlag), '[PULL] Brake cert update', 'pull flag mismatch');
  });
  test('formatActiveFlag: audit type uppercased', () => {
    assertEqual(formatActiveFlag(auditFlag), '[AUDIT] Log this interaction', 'audit flag mismatch');
  });
  test('formatActiveFlag: empty content still renders type prefix', () => {
    const flag: ActiveFlag = { ...safetyFlag, content: '' };
    assertEqual(formatActiveFlag(flag), '[SAFETY] ', 'empty content missing');
  });
  test('formatActiveFlag: unicode content preserved', () => {
    const flag: ActiveFlag = { ...safetyFlag, content: 'sägeblatt bröken' };
    assertEqual(formatActiveFlag(flag), '[SAFETY] sägeblatt bröken', 'unicode mismatch');
  });

  // ── 2. formatOpenItem ───────────────────────────────────────
  test('formatOpenItem: non-push renders category only', () => {
    assertEqual(formatOpenItem(partsItem), '[parts] Need K7 filter', 'non-push mismatch');
  });
  test('formatOpenItem: push item inserts [PUSH] marker', () => {
    assertEqual(
      formatOpenItem(pushComplianceItem),
      '[compliance [PUSH]] Brake cert due 3/15',
      'push marker missing',
    );
  });
  test('formatOpenItem: category stays lowercase', () => {
    const safetyItem: OpenItem = { ...partsItem, category: 'safety', content: 'LOTO check' };
    assertEqual(formatOpenItem(safetyItem), '[safety] LOTO check', 'lowercase preserved');
  });
  test('formatOpenItem: bracket-containing content is not escaped', () => {
    const item: OpenItem = { ...partsItem, content: 'Order [HF6553] filter' };
    assertEqual(formatOpenItem(item), '[parts] Order [HF6553] filter', 'content brackets preserved');
  });

  // ── 3. formatMachineRef ─────────────────────────────────────
  test('formatMachineRef: with serial uses em-dash separator', () => {
    assertEqual(
      formatMachineRef(machineWithSerial),
      'Pos 13: Harsco Jackson 6700 Tamper — SN: 153640',
      'serial format mismatch',
    );
  });
  test('formatMachineRef: without serial omits SN clause entirely', () => {
    assertEqual(formatMachineRef(machineWithoutSerial), 'Pos 1: Nordco CX Spiker #1', 'no-serial mismatch');
  });
  test('formatMachineRef: position 0 rendered as "Pos 0"', () => {
    const m: MachineRef = { position: 0, name: 'Unknown', serialNumber: 'X' };
    assertEqual(formatMachineRef(m), 'Pos 0: Unknown — SN: X', 'position 0 mismatch');
  });

  // ── 4. formatActiveFlags (list) ─────────────────────────────
  test('formatActiveFlags: empty array returns empty string', () => {
    assertEqual(formatActiveFlags([]), '', 'empty should be empty string');
  });
  test('formatActiveFlags: default indent is two spaces', () => {
    assertEqual(formatActiveFlags([safetyFlag]), '  [SAFETY] Hydraulic line leaking on pos 13', 'default indent');
  });
  test('formatActiveFlags: custom indent respected', () => {
    assertEqual(formatActiveFlags([safetyFlag], '> '), '> [SAFETY] Hydraulic line leaking on pos 13', 'custom indent');
  });
  test('formatActiveFlags: order preserved; newline-joined', () => {
    assertEqual(
      formatActiveFlags([safetyFlag, pushFlag]),
      '  [SAFETY] Hydraulic line leaking on pos 13\n  [PUSH] New memo from Nathan',
      'order or join mismatch',
    );
  });

  // ── 5. formatOpenItems (list) ───────────────────────────────
  test('formatOpenItems: empty returns empty string', () => {
    assertEqual(formatOpenItems([]), '', 'empty open items');
  });
  test('formatOpenItems: push marker survives list join', () => {
    assertEqual(
      formatOpenItems([partsItem, pushComplianceItem]),
      '  [parts] Need K7 filter\n  [compliance [PUSH]] Brake cert due 3/15',
      'open items list mismatch',
    );
  });

  // ── 6. formatConsistContext ─────────────────────────────────
  test('formatConsistContext: null returns empty string', () => {
    assertEqual(formatConsistContext(null), '', 'null ctx');
  });
  test('formatConsistContext: empty relevantMachines returns empty string', () => {
    assertEqual(formatConsistContext({ consistId: 'X', relevantMachines: [] }), '', 'empty machines');
  });
  test('formatConsistContext: two machines joined with newline', () => {
    assertEqual(
      formatConsistContext(consistCtx),
      '  Pos 13: Harsco Jackson 6700 Tamper — SN: 153640\n  Pos 1: Nordco CX Spiker #1',
      'consist list mismatch',
    );
  });
  test('formatConsistContext: custom indent applied per line', () => {
    assertEqual(
      formatConsistContext(consistCtx, '    '),
      '    Pos 13: Harsco Jackson 6700 Tamper — SN: 153640\n    Pos 1: Nordco CX Spiker #1',
      'custom indent mismatch',
    );
  });

  // ── 7. formatDraftForApproval — TodoDraft ───────────────────
  const todoWithId: TodoDraft = {
    userId:          'user-001',
    sessionId:       'session-001',
    requestId:       'req-001',
    description:     'Order hydraulic filter for pos 13',
    category:        'parts_inventory',
    timeSensitivity: 'standard',
    dueDate:         '2026-04-30',
    equipmentId:     'EQ-6700-01',
    linkedContactId: 'contact-42',
    metadataJson:    null,
  };
  const todoWithNotes: TodoDraft = {
    ...todoWithId,
    equipmentId:       null,
    equipmentNote:     'Unknown tamper',
    linkedContactId:   null,
    linkedContactNote: 'Ask Nathan tomorrow',
  };

  test('formatDraftForApproval: TodoDraft with ids renders without JSON braces', () => {
    const out = formatDraftForApproval(todoWithId);
    assert(!out.includes('{'), 'output should not contain JSON braces');
    assert(out.includes('Create to-do:'), 'must identify draft type');
    assert(out.includes('Order hydraulic filter for pos 13'), 'description missing');
    assert(out.includes('Category: parts_inventory'), 'category missing');
    assert(out.includes('Time sensitivity: standard'), 'time sensitivity missing');
    assert(out.includes('Due: 2026-04-30'), 'due date missing');
    assert(out.includes('Equipment: EQ-6700-01'), 'equipment id missing');
    assert(out.includes('Linked contact: contact-42'), 'contact id missing');
  });
  test('formatDraftForApproval: TodoDraft falls back to notes when ids null', () => {
    const out = formatDraftForApproval(todoWithNotes);
    assert(out.includes('Equipment: Unknown tamper'), 'equipment note fallback');
    assert(out.includes('Linked contact: Ask Nathan tomorrow'), 'contact note fallback');
  });
  test('formatDraftForApproval: TodoDraft omits absent optional fields', () => {
    const { dueDate: _drop, ...rest } = todoWithId;
    const minimal: TodoDraft = {
      ...rest,
      equipmentId:     null,
      linkedContactId: null,
    };
    const out = formatDraftForApproval(minimal);
    assert(!out.includes('Due:'), 'due should be absent');
    assert(!out.includes('Equipment:'), 'equipment should be absent');
    assert(!out.includes('Linked contact:'), 'contact should be absent');
  });

  // ── 8. formatDraftForApproval — SmsDraft ────────────────────
  const smsDraft: SmsDraft = {
    channel:    'sms',
    recipients: ['+15555550101', '+15555550202'],
    body:       'Tamper down, need K7 filter by Friday.',
    toneLevel:  5,
  };
  test('formatDraftForApproval: SmsDraft headers recipients and body', () => {
    const out = formatDraftForApproval(smsDraft);
    assert(out.startsWith('Send SMS to: +15555550101, +15555550202'), 'sms header mismatch');
    assert(out.includes('Tone level: 5'), 'tone level missing');
    assert(out.includes('Tamper down, need K7 filter by Friday.'), 'body missing');
    assert(!out.includes('Subject:'), 'sms must not have subject');
    assert(!out.includes('Reply-to:'), 'sms must not have reply-to');
  });

  // ── 9. formatDraftForApproval — EmailDraft ──────────────────
  const emailDraft: EmailDraft = {
    channel:    'email',
    recipients: ['nathan@example.com'],
    subject:    'PM interval for 6700',
    body:       'Per the manual, PM interval is 250 hours.',
    toneLevel:  7,
    replyTo:    'kurt@example.com',
  };
  test('formatDraftForApproval: EmailDraft includes subject and replyTo', () => {
    const out = formatDraftForApproval(emailDraft);
    assert(out.includes('Send email to: nathan@example.com'), 'email header missing');
    assert(out.includes('Subject: PM interval for 6700'), 'subject missing');
    assert(out.includes('Reply-to: kurt@example.com'), 'reply-to missing');
    assert(out.includes('Tone level: 7'), 'tone level missing');
    assert(out.includes('Per the manual, PM interval is 250 hours.'), 'body missing');
  });
  test('formatDraftForApproval: EmailDraft without replyTo omits that line', () => {
    const { replyTo: _drop, ...rest } = emailDraft;
    const out = formatDraftForApproval(rest as EmailDraft);
    assert(!out.includes('Reply-to:'), 'reply-to must be absent when undefined');
  });

  // ── 10. formatDraftForApproval — PoDocument ─────────────────
  const poDoc: PoDocument = {
    poNumber:           'PO-20260416-0001',
    vendorName:         'Jackson Equipment Supply',
    issuedDate:         '2026-04-16',
    equipmentLabel:     'Pos 13 — Harsco Jackson 6700 Tamper',
    lineItemsFormatted: ['Filter HF6553  x1  $12.50  =  $12.50'],
    subtotalFormatted:  '$12.50',
    notes:              'Rush shipping requested',
    status:             'draft',
  };
  test('formatDraftForApproval: PoDocument uses pre-formatted strings', () => {
    const out = formatDraftForApproval(poDoc);
    assert(out.includes('Purchase order PO-20260416-0001'), 'po number missing');
    assert(out.includes('Vendor: Jackson Equipment Supply'), 'vendor missing');
    assert(out.includes('Issued: 2026-04-16'), 'issued date missing');
    assert(out.includes('Equipment: Pos 13 — Harsco Jackson 6700 Tamper'), 'equipment label missing');
    assert(out.includes('Filter HF6553  x1  $12.50  =  $12.50'), 'line item missing');
    assert(out.includes('Subtotal: $12.50'), 'subtotal missing');
    assert(out.includes('Notes: Rush shipping requested'), 'notes missing');
  });
  test('formatDraftForApproval: PoDocument without notes omits notes line', () => {
    const out = formatDraftForApproval({ ...poDoc, notes: null });
    assert(!out.includes('Notes:'), 'notes must be absent when null');
  });
  test('formatDraftForApproval: PoDocument without equipment omits equipment line', () => {
    const out = formatDraftForApproval({ ...poDoc, equipmentLabel: null });
    assert(!out.includes('Equipment:'), 'equipment must be absent when null');
  });

  // ── 11. SMS_MARKDOWN_PATTERNS ───────────────────────────────
  const detects = (text: string): boolean =>
    SMS_MARKDOWN_PATTERNS.some(p => p.test(text));

  test('SMS_MARKDOWN_PATTERNS: detects # heading', () => {
    assert(detects('# Heading'), 'heading not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects bold **', () => {
    assert(detects('this is **bold**'), 'bold not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects italic *', () => {
    assert(detects('this is *italic* text'), 'italic not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects list dash', () => {
    assert(detects('- item one'), 'list dash not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects list star', () => {
    assert(detects('* item one'), 'list star not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects code backtick', () => {
    assert(detects('run `npm test`'), 'backtick not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: detects table row', () => {
    assert(detects('|col|col|'), 'table row not detected');
  });
  test('SMS_MARKDOWN_PATTERNS: plain text does not match', () => {
    assert(!detects('Tamper down, need K7 filter by Friday.'), 'false positive on plain text');
  });
  test('SMS_MARKDOWN_PATTERNS: patterns are not g-flagged (stateless .test)', () => {
    // Regression guard — g-flagged module-scope regex drifts lastIndex.
    for (const p of SMS_MARKDOWN_PATTERNS) {
      assert(!p.flags.includes('g'), `pattern ${p} must not carry g flag`);
    }
  });
  test('SMS_MARKDOWN_PATTERNS: repeated detection yields stable results', () => {
    // Stateful g-flagged regexes would flip-flop on repeated .test() calls.
    const text = '# Heading';
    const first  = detects(text);
    const second = detects(text);
    const third  = detects(text);
    assert(first && second && third, 'detection must be stable across calls');
  });

  // ── 12. Anti-drift invariant ────────────────────────────────
  // Given matching ConsistContext, the rendered machine block
  // from the shared formatter must appear verbatim inside
  // buildAuditPrompt — the previous hand-rolled format differed
  // from promptAssembler. Shared module guarantees parity.
  test('anti-drift: formatConsistContext output appears in buildAuditPrompt', () => {
    const event: ProcessedEvent = {
      eventType:  'user_message',
      rawContent: 'Tamper status?',
      metadata:   { sessionId: 's1', userId: 'u1', channel: 'app' },
      timestamp:  '2026-04-16T00:00:00Z',
    };
    const ctxData: ContextualData = {
      activeFlags:    [safetyFlag],
      openItems:      [partsItem],
      consistContext: consistCtx,
    };
    const auditInput: ModelAuditInput = {
      responseText:   'Pos 13 Harsco Jackson 6700 Tamper is down.',
      event,
      contextualData: ctxData,
      preflightFlags: [],
      sessionId:      's1',
      requestId:      'r1',
    };
    const prompt = buildAuditPrompt(auditInput);
    const machineBlock = formatConsistContext(consistCtx);
    const openItemsBlock = formatOpenItems([partsItem]);
    const safetyBlock = formatActiveFlags([safetyFlag]);
    assert(prompt.includes(machineBlock), 'machine block must appear verbatim in audit prompt');
    assert(prompt.includes(openItemsBlock), 'open items block must appear verbatim in audit prompt');
    assert(prompt.includes(safetyBlock), 'safety block must appear verbatim in audit prompt');
  });

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
