// ============================================================
// OTM — Context Loader Tests
// CJS module. Run via: npm run test:context
// DB-dependent tests use typed partial mock (Option A).
// Pure function tests require no mock.
// ============================================================

import { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchStyleProfile,
  fetchUserSettings,
  filterContextForEvent,
  loadContext,
  DEFAULT_USER_SETTINGS,
  ContextLoaderError,
} from '../src/orchestration/contextLoader';
import {
  ProcessedEvent,
  SessionState,
  EditionConfig,
  ActiveFlag,
  OpenItem,
  ContextLoaderInput,
} from '../src/orchestration/types';

// ── Mock Supabase Client ──────────────────────────────────────
// Option A: typed partial mock satisfying the from().select().eq()
// .order().limit() chain used in fetchStyleProfile and
// the from().select().eq().eq() chain used in fetchUserSettings.

type MockQueryResult<T> = { data: T | null; error: { message: string } | null };

function makeChain<T>(result: MockQueryResult<T>) {
  const chain = {
    select: () => chain,
    eq:     () => chain,
    order:  () => chain,
    limit:  () => Promise.resolve(result),
    then:   (resolve: (r: MockQueryResult<T>) => void) => {
      resolve(result);
      return Promise.resolve(result);
    },
  };
  return chain;
}

function makeMockDb(overrides: {
  styleProfile?: MockQueryResult<Array<{ summary: string }>>;
  userSettings?: MockQueryResult<Array<{ setting_key: string; setting_value: string }>>;
}): SupabaseClient {
  const mock = {
    from: (table: string) => {
      if (table === 'style_observations') {
        return makeChain(overrides.styleProfile ?? { data: [], error: null });
      }
      if (table === 'user_settings') {
        return makeChain(overrides.userSettings ?? { data: [], error: null });
      }
      return makeChain({ data: [], error: null });
    },
  };
  return mock as unknown as SupabaseClient;
}

// ── Fixtures ──────────────────────────────────────────────────

const BASE_EVENT: ProcessedEvent = {
  eventType:  'user_message',
  rawContent: "What's going on with pos 13?",
  metadata:   { sessionId: 'session-001', userId: 'user-001', channel: 'app' },
  timestamp:  new Date().toISOString(),
};

const SAFETY_FLAG: ActiveFlag = {
  flagId:       'flag-safety-001',
  type:         'safety',
  content:      'Hydraulic line visibly leaking on pos 13',
  raisedAt:     new Date().toISOString(),
  acknowledged: false,
};

const PUSH_FLAG: ActiveFlag = {
  flagId:       'flag-push-001',
  type:         'push',
  content:      'PM overdue on pos 13 Harsco Jackson 6700 Tamper',
  raisedAt:     new Date().toISOString(),
  acknowledged: false,
};

const ACKNOWLEDGED_FLAG: ActiveFlag = {
  flagId:       'flag-ack-001',
  type:         'safety',
  content:      'Resolved — brake adjustment complete',
  raisedAt:     new Date().toISOString(),
  acknowledged: true,
};

const MACHINE_ITEM: OpenItem = {
  itemId:   'item-001',
  category: 'machine',
  content:  'Filter change due — pos 13 Harsco Jackson 6700 Tamper',
  priority: 2,
  isPush:   false,
};

const PARTS_ITEM: OpenItem = {
  itemId:   'item-002',
  category: 'parts',
  content:  'Hydraulic filters low — reorder needed',
  priority: 1,
  isPush:   false,
};

const BASE_STATE: SessionState = {
  sessionId:           'session-001',
  userId:              'user-001',
  editionId:           'otm-v1-mechanic',
  openedAt:            new Date().toISOString(),
  lastInteractionAt:   new Date().toISOString(),
  conversationHistory: [],
  activeFlags:         [SAFETY_FLAG, PUSH_FLAG, ACKNOWLEDGED_FLAG],
  openItems:           [MACHINE_ITEM, PARTS_ITEM],
  consistContext: {
    consistId: 'HGPT01',
    relevantMachines: [
      { position: 13, name: 'Harsco Jackson 6700 Tamper', serialNumber: '153640' },
      { position: 7,  name: 'Harsco Jackson 3300 Jr. Tamper', serialNumber: '153557' },
    ],
  },
  isFromLogReplay: false,
};

const BASE_EDITION_CONFIG: EditionConfig = {
  editionId:          'otm-v1-mechanic',
  systemPromptPath:   'src/config/system-prompt.v1.0',
  styleProfileTable:  'style_observations',
  contextFields: {
    includeActiveFlags:    true,
    includeOpenItems:      true,
    includeConsistContext: true,
  },
  productName:              'OneTrackMind',
  feedbackIssueTitleFormat: '[audit-failure] {sessionId}',
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

  function assertThrowsAsync(
    fn: () => Promise<unknown>,
    expectedName: string,
    message: string
  ): Promise<void> {
    return fn().then(
      () => { throw new Error(`Expected ${expectedName} but nothing was thrown`); },
      (err: Error) => {
        if (err.name !== expectedName) {
          throw new Error(`${message} — got '${err.name}' instead of '${expectedName}'`);
        }
      }
    );
  }

  console.log('\nContext Loader Tests\n');

  // ── 1. fetchStyleProfile — row exists ─────────────────────
  await test('fetchStyleProfile returns summary when row exists', async () => {
    const db = makeMockDb({
      styleProfile: { data: [{ summary: 'Direct, blunt. Humor contextually.' }], error: null },
    });
    const result = await fetchStyleProfile('user-001', db);
    assert(result === 'Direct, blunt. Humor contextually.', 'must return the summary string');
  });

  // ── 2. fetchStyleProfile — no rows ────────────────────────
  await test('fetchStyleProfile returns empty string when no rows (first session)', async () => {
    const db = makeMockDb({ styleProfile: { data: [], error: null } });
    const result = await fetchStyleProfile('user-001', db);
    assert(result === '', 'empty result must return empty string — not an error');
  });

  // ── 3. fetchStyleProfile — DB error ───────────────────────
  await test('fetchStyleProfile throws ContextLoaderError on DB error', async () => {
    const db = makeMockDb({
      styleProfile: { data: null, error: { message: 'connection timeout' } },
    });
    await assertThrowsAsync(
      () => fetchStyleProfile('user-001', db),
      'ContextLoaderError',
      'must throw ContextLoaderError on DB failure'
    );
  });

  // ── 4. fetchUserSettings — all rows present ────────────────
  await test('fetchUserSettings returns typed settings from rows', async () => {
    const db = makeMockDb({
      userSettings: {
        data: [
          { setting_key: 'digestThresholdHours',   setting_value: '12' },
          { setting_key: 'styleProfileVisible',     setting_value: 'false' },
          { setting_key: 'styleExclusions',         setting_value: '["family","health"]' },
          { setting_key: 'voiceResponseMode',       setting_value: 'always' },
          { setting_key: 'timeZone',                setting_value: 'America/Denver' },
        ],
        error: null,
      },
    });
    const result = await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
    assert(result.digestThresholdHours === 12, 'numeric key must be coerced to number');
    assert(result.styleProfileVisible === false, 'boolean key must be coerced to boolean');
    assert(
      Array.isArray(result.styleExclusions) && result.styleExclusions.length === 2,
      'array key must be parsed from JSON'
    );
    assert(result.voiceResponseMode === 'always', 'string union key returned as-is');
    assert(result.timeZone === 'America/Denver', 'string key returned as-is');
  });

  // ── 5. fetchUserSettings — partial rows, defaults applied ──
  await test('fetchUserSettings applies defaults for missing keys', async () => {
    const db = makeMockDb({
      userSettings: {
        data: [{ setting_key: 'digestThresholdHours', setting_value: '10' }],
        error: null,
      },
    });
    const result = await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
    assert(result.digestThresholdHours === 10, 'present key must use persisted value');
    assert(
      result.pushRepeatIntervalHours === DEFAULT_USER_SETTINGS.pushRepeatIntervalHours,
      'missing key must use default'
    );
    assert(
      result.defaultSessionOpenPreference === DEFAULT_USER_SETTINGS.defaultSessionOpenPreference,
      'missing key must use default'
    );
  });

  // ── 6. fetchUserSettings — no rows, all defaults ──────────
  await test('fetchUserSettings returns all defaults when no rows exist', async () => {
    const db = makeMockDb({ userSettings: { data: [], error: null } });
    const result = await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
    assert(
      JSON.stringify(result) === JSON.stringify(DEFAULT_USER_SETTINGS),
      'all settings must equal defaults when no rows'
    );
  });

  // ── 7. fetchUserSettings — DB error ───────────────────────
  await test('fetchUserSettings throws ContextLoaderError on DB error', async () => {
    const db = makeMockDb({
      userSettings: { data: null, error: { message: 'RLS policy violation' } },
    });
    await assertThrowsAsync(
      () => fetchUserSettings('user-001', 'otm-v1-mechanic', db),
      'ContextLoaderError',
      'must throw ContextLoaderError on DB failure'
    );
  });

  // ── 7a. coerceSetting corruption paths (CL-5/6/7/8 + D3/D4) ─

  async function assertCorruptRow(
    key:    string,
    value:  string,
    reason: string,
    label:  string
  ): Promise<void> {
    const db = makeMockDb({
      userSettings: { data: [{ setting_key: key, setting_value: value }], error: null },
    });
    try {
      await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
      throw new Error(`${label} — expected ContextLoaderError but nothing was thrown`);
    } catch (err) {
      const e = err as Error & { userId?: string };
      if (e.name !== 'ContextLoaderError') {
        throw new Error(`${label} — got '${e.name}' instead of 'ContextLoaderError'`);
      }
      if (!e.message.includes(reason)) {
        throw new Error(`${label} — message must include reason=${reason}, got: ${e.message}`);
      }
      if (!e.message.includes(key)) {
        throw new Error(`${label} — message must include key=${key}, got: ${e.message}`);
      }
      if (e.userId !== 'user-001') {
        throw new Error(`${label} — userId on error must be 'user-001', got: ${e.userId}`);
      }
    }
  }

  await test('fetchUserSettings throws on malformed JSON for array key (CL-5)', async () => {
    await assertCorruptRow('styleExclusions', '{not json', 'malformed_json', 'CL-5');
  });

  await test('fetchUserSettings throws on non-array JSON for array key (CL-6)', async () => {
    await assertCorruptRow('styleExclusions', '"just-a-string"', 'wrong_shape', 'CL-6 string');
    await assertCorruptRow('styleExclusions', '{"a":1}', 'wrong_shape', 'CL-6 object');
  });

  await test('fetchUserSettings throws on array with non-string element (CL-6 extended)', async () => {
    await assertCorruptRow('styleExclusions', '[1,2,3]', 'wrong_shape', 'CL-6 non-strings');
  });

  await test('fetchUserSettings throws on non-finite numeric (CL-7)', async () => {
    await assertCorruptRow('digestThresholdHours', 'abc', 'non_finite_number', 'CL-7');
  });

  await test('fetchUserSettings throws on out-of-union voiceResponseMode (CL-8)', async () => {
    await assertCorruptRow('voiceResponseMode', 'sometimes', 'invalid_union', 'CL-8 voice');
  });

  await test('fetchUserSettings throws on out-of-union defaultSessionOpenPreference (CL-8)', async () => {
    await assertCorruptRow('defaultSessionOpenPreference', 'overview', 'invalid_union', 'CL-8 session');
  });

  await test('fetchUserSettings throws on non-literal boolean (D3)', async () => {
    await assertCorruptRow('styleProfileVisible', 'TRUE',  'invalid_boolean', 'D3 uppercase');
    await assertCorruptRow('styleProfileVisible', '1',     'invalid_boolean', 'D3 numeric-string');
    await assertCorruptRow('styleProfileVisible', 'yes',   'invalid_boolean', 'D3 yes');
  });

  await test('fetchUserSettings accepts literal "false" boolean (D3)', async () => {
    const db = makeMockDb({
      userSettings: {
        data: [{ setting_key: 'styleProfileVisible', setting_value: 'false' }],
        error: null,
      },
    });
    const result = await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
    assert(result.styleProfileVisible === false, 'literal "false" must coerce to false');
  });

  await test('fetchUserSettings warns and skips unknown setting keys (D4)', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const db = makeMockDb({
        userSettings: {
          data: [
            { setting_key: 'unknownFutureKey', setting_value: 'whatever' },
            { setting_key: 'digestThresholdHours', setting_value: '7' },
          ],
          error: null,
        },
      });
      const result = await fetchUserSettings('user-001', 'otm-v1-mechanic', db);
      assert(result.digestThresholdHours === 7, 'known key must still be applied');
      assert(
        warnings.some(w => w.includes('unknownFutureKey')),
        'must warn about unknown key'
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  // ── 8. loadContext — parallel fetch, assembled output ──────
  await test('loadContext returns assembled ContextLoaderOutput', async () => {
    const db = makeMockDb({
      styleProfile: { data: [{ summary: 'Blunt tone.' }], error: null },
      userSettings: { data: [], error: null },
    });
    const input: ContextLoaderInput = {
      event:         BASE_EVENT,
      sessionState:  BASE_STATE,
      editionConfig: BASE_EDITION_CONFIG,
    };
    const result = await loadContext(input, db);
    assert(result.styleProfile === 'Blunt tone.', 'styleProfile must be returned');
    assert(
      JSON.stringify(result.userSettings) === JSON.stringify(DEFAULT_USER_SETTINGS),
      'userSettings must be returned with defaults'
    );
    assert(typeof result.contextualData === 'object', 'contextualData must be present');
  });

  // ── 9. filterContextForEvent — system_trigger ─────────────
  await test('system_trigger returns all unacknowledged flags and all open items', () => {
    const event: ProcessedEvent = { ...BASE_EVENT, eventType: 'system_trigger' };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext === null, 'consistContext must be null for system_trigger');
    assert(result.activeFlags.length === 2, 'must include 2 unacknowledged flags');
    assert(
      result.activeFlags.every(f => !f.acknowledged),
      'acknowledged flags must be excluded'
    );
    assert(result.openItems.length === 2, 'all open items must be included');
  });

  // ── 10. filterContextForEvent — inbound_sms ───────────────
  await test('inbound_sms returns safety flags only, null consist context', () => {
    const event: ProcessedEvent = { ...BASE_EVENT, eventType: 'inbound_sms' };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext === null, 'consistContext must be null for inbound_sms');
    assert(
      result.activeFlags.every(f => f.type === 'safety'),
      'only safety flags must be included'
    );
    assert(result.openItems.length === 0, 'no open items for inbound_sms');
  });

  // ── 11. filterContextForEvent — user_message, full machine name
  // Simple includes() matching on full name — partial/token matching is Phase 8.
  await test('user_message with full machine name returns matching consist context', () => {
    const event: ProcessedEvent = {
      ...BASE_EVENT,
      rawContent: 'Harsco Jackson 6700 Tamper is leaking hydraulic fluid',
    };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext !== null, 'consistContext must be set when machine referenced');
    assert(
      result.consistContext!.relevantMachines.length === 1,
      'only the referenced machine must be included'
    );
    assert(
      result.consistContext!.relevantMachines[0]!.position === 13,
      'pos 13 must be the matched machine'
    );
  });

  // ── 12. filterContextForEvent — user_message, position ref ─
  await test('user_message with "pos 13" matches by position number', () => {
    const event: ProcessedEvent = {
      ...BASE_EVENT,
      rawContent: 'pos 13 is throwing a fault code',
    };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext !== null, 'consistContext must be set');
    assert(
      result.consistContext!.relevantMachines.some(m => m.position === 13),
      'pos 13 must be matched'
    );
  });

  // ── 13. filterContextForEvent — user_message, serial ref ───
  await test('user_message with serial number matches machine', () => {
    const event: ProcessedEvent = {
      ...BASE_EVENT,
      rawContent: 'serial 153640 needs a filter change',
    };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext !== null, 'consistContext must be set');
    assert(
      result.consistContext!.relevantMachines.some(m => m.serialNumber === '153640'),
      'machine with serial 153640 must be matched'
    );
  });

  // ── 14. filterContextForEvent — user_message, no machine ──
  await test('user_message with no machine reference returns safety flags only', () => {
    const event: ProcessedEvent = {
      ...BASE_EVENT,
      rawContent: 'What time does the shift start today?',
    };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(result.consistContext === null, 'consistContext must be null when no machine referenced');
    assert(
      result.activeFlags.every(f => f.type === 'safety'),
      'only safety flags must be returned'
    );
    assert(result.openItems.length === 0, 'no open items when no machine referenced');
  });

  // ── 15. filterContextForEvent — acknowledged flags excluded ─
  await test('system_trigger excludes acknowledged flags', () => {
    const event: ProcessedEvent = { ...BASE_EVENT, eventType: 'system_trigger' };
    const result = filterContextForEvent(event, BASE_STATE, BASE_EDITION_CONFIG);
    assert(
      !result.activeFlags.some(f => f.flagId === ACKNOWLEDGED_FLAG.flagId),
      'acknowledged flag must not appear in system_trigger output'
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
