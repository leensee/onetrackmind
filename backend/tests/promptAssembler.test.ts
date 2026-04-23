// ============================================================
// OTM — Prompt Assembler Tests
// CJS module. Run via: npm test
// ============================================================

import { assemblePrompt } from '../src/orchestration/promptAssembler';
import {
  AssemblerInput,
  EditionConfig,
  ContextualData,
  ProcessedEvent,
  Message,
} from '../src/orchestration/types';

// ── Test Fixtures ────────────────────────────────────────────

const baseEditionConfig: EditionConfig = {
  editionId: 'otm-v1-mechanic',
  systemPromptPath: 'src/config/system-prompt.v1.0',
  styleProfileTable: 'style_observations',
  contextFields: {
    includeActiveFlags: true,
    includeOpenItems: true,
    includeConsistContext: true,
  },
  productName: 'OneTrackMind',
  feedbackIssueTitleFormat: '[audit-failure] {sessionId}',
};

const baseEvent: ProcessedEvent = {
  eventType: 'user_message',
  rawContent: "What's the PM interval on the 6700?",
  metadata: {
    sessionId: 'test-session-001',
    userId: 'kurt-001',
    channel: 'app',
  },
  timestamp: new Date().toISOString(),
};

const emptyContext: ContextualData = {
  activeFlags: [],
  openItems: [],
  consistContext: null,
};

const baseInput: AssemblerInput = {
  editionConfig: baseEditionConfig,
  styleProfile: 'Direct, blunt tone. Humor when contextually appropriate.',
  conversationHistory: [],
  currentInput: baseEvent,
  contextualData: emptyContext,
};

// ── Test Runner ───────────────────────────────────────────────

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

  console.log('\nPrompt Assembler Tests\n');

  // ── 1. Basic assembly ─────────────────────────────────────
  await test('assembles system prompt and messages without error', async () => {
    const output = await assemblePrompt(baseInput);
    assert(typeof output.systemPrompt === 'string', 'systemPrompt must be a string');
    assert(output.systemPrompt.length > 0, 'systemPrompt must not be empty');
    assert(Array.isArray(output.messages), 'messages must be an array');
    assert(output.messages.length === 1, 'should have 1 message (current input only)');
    assert(output.messages[0] !== undefined && output.messages[0].role === 'user', 'last message role must be user');
    assert(
      output.messages[0] !== undefined && output.messages[0].content === baseEvent.rawContent,
      'last message content must match current input'
    );
  });

  // ── 2. Style profile injection ────────────────────────────
  await test('injects style profile block into system prompt', async () => {
    const output = await assemblePrompt(baseInput);
    assert(
      output.systemPrompt.includes('[STYLE PROFILE — injected at session open]'),
      'system prompt must contain style profile label'
    );
    assert(
      output.systemPrompt.includes(baseInput.styleProfile),
      'system prompt must contain style profile content'
    );
  });

  await test('omits style block when style profile is empty', async () => {
    const input: AssemblerInput = { ...baseInput, styleProfile: '' };
    const output = await assemblePrompt(input);
    assert(
      !output.systemPrompt.includes('[STYLE PROFILE — injected at session open]'),
      'style block must be omitted when style profile is empty'
    );
  });

  // ── 3. Context injection ──────────────────────────────────
  await test('injects active flags into context block', async () => {
    const input: AssemblerInput = {
      ...baseInput,
      contextualData: {
        ...emptyContext,
        activeFlags: [{
          flagId: 'flag-001',
          type: 'safety',
          content: 'Tamper hydraulic pressure low',
          raisedAt: new Date().toISOString(),
          acknowledged: false,
        }],
      },
    };
    const output = await assemblePrompt(input);
    assert(output.systemPrompt.includes('ACTIVE FLAGS:'), 'context block must include ACTIVE FLAGS section');
    assert(output.systemPrompt.includes('Tamper hydraulic pressure low'), 'context block must include flag content');
  });

  await test('injects consist context when provided', async () => {
    const input: AssemblerInput = {
      ...baseInput,
      contextualData: {
        ...emptyContext,
        consistContext: {
          consistId: 'HGPT01',
          relevantMachines: [
            { position: 13, name: 'Harsco Jackson 6700 Tamper', serialNumber: '153640' },
          ],
        },
      },
    };
    const output = await assemblePrompt(input);
    assert(output.systemPrompt.includes('CONSIST CONTEXT (HGPT01):'), 'context block must include consist header');
    assert(output.systemPrompt.includes('SN: 153640'), 'context block must include serial number');
  });

  await test('omits context block when context is empty', async () => {
    const output = await assemblePrompt(baseInput);
    assert(!output.systemPrompt.includes('[SESSION CONTEXT'), 'context block must be omitted when no context data');
  });

  // ── 4. Conversation history ───────────────────────────────
  await test('includes conversation history before current input', async () => {
    const history: Message[] = [
      { role: 'user', content: 'Hey, what machines are overdue for PM?', timestamp: '2026-04-10T08:00:00Z' },
      { role: 'assistant', content: 'Based on logged data: none overdue today.', timestamp: '2026-04-10T08:00:05Z' },
    ];
    const input: AssemblerInput = { ...baseInput, conversationHistory: history };
    const output = await assemblePrompt(input);
    assert(output.messages.length === 3, 'messages must include 2 history turns + current input');
    assert(output.messages[0] !== undefined && output.messages[0].content === history[0]!.content, 'first message must be first history turn');
    assert(output.messages[2] !== undefined && output.messages[2].content === baseEvent.rawContent, 'last message must be current input');
  });

  // ── 5. History trimming ───────────────────────────────────
  await test('trims oldest history turns when context window budget exceeded', async () => {
    const tightConfig: EditionConfig = {
      ...baseEditionConfig,
      contextWindowConfig: { totalTokens: 3_500, responseReserve: 500 },
    };
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'A'.repeat(200),
    }));
    const input: AssemblerInput = { ...baseInput, editionConfig: tightConfig, conversationHistory: longHistory };
    const output = await assemblePrompt(input);
    assert(output.historyTrimmed === true, 'historyTrimmed must be true when turns were dropped');
    assert(output.historyTurnsTrimmed > 0, 'historyTurnsTrimmed must be > 0');
    const lastMsg = output.messages[output.messages.length - 1];
    assert(lastMsg !== undefined && lastMsg.content === baseEvent.rawContent, 'current input must always be the last message');
  });

  // ── 6. Token estimates ────────────────────────────────────
  await test('returns a plausible token estimate', async () => {
    const output = await assemblePrompt(baseInput);
    assert(output.tokenEstimate > 0, 'tokenEstimate must be positive');
    assert(output.tokenEstimate < 200_000, 'tokenEstimate must be within context window');
    assert(
      output.contextWindowUsedPct > 0 && output.contextWindowUsedPct <= 100,
      'contextWindowUsedPct must be between 1 and 100'
    );
  });

  // ── 7. Current input never trimmed ────────────────────────
  await test('current input is always present as final message regardless of budget', async () => {
    const tightConfig: EditionConfig = {
      ...baseEditionConfig,
      contextWindowConfig: { totalTokens: 3_000, responseReserve: 500 },
    };
    const input: AssemblerInput = {
      ...baseInput,
      editionConfig: tightConfig,
      conversationHistory: Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: 'A'.repeat(200),
      })),
    };
    const output = await assemblePrompt(input);
    const last = output.messages[output.messages.length - 1];
    assert(last !== undefined && last.role === 'user', 'last message must be user role');
    assert(last !== undefined && last.content === baseEvent.rawContent, 'last message must always be current input');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
