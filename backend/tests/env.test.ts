// ============================================================
// Tests: env.ts — loadEnv()
// Tests the exported loadEnv() function with controlled env
// objects. Imports from src/config/env (pure functions, no side
// effects) — NOT from src/config/index (runtime IIFE, requires .env).
// ============================================================

import { loadEnv, EnvConfigError } from '../src/config/env';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function assertThrows(
  fn:      () => unknown,
  label:   string,
  checks?: (err: unknown) => void
): void {
  try {
    fn();
    console.error(`  ✗ ${label} — expected throw, got none`);
    failed++;
  } catch (err) {
    console.log(`  ✓ ${label}`);
    passed++;
    checks?.(err);
  }
}

// ── Helpers ───────────────────────────────────────────────────

const VALID_KEY = 'a'.repeat(64); // valid 64-char hex

function validBase(): Record<string, string> {
  return {
    FCM_PAYLOAD_KEY:           VALID_KEY,
    ANTHROPIC_API_KEY:         'sk-ant-test',
    SUPABASE_URL:              'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJtest',
  };
}

// ── Required vars — happy path ────────────────────────────────

console.log('\n[env] Required vars — happy path');
{
  const result = loadEnv(validBase());
  assert(result.fcmPayloadKey          === VALID_KEY,                   'fcmPayloadKey present');
  assert(result.anthropicApiKey        === 'sk-ant-test',               'anthropicApiKey present');
  assert(result.supabaseUrl            === 'https://test.supabase.co',  'supabaseUrl present');
  assert(result.supabaseServiceRoleKey === 'eyJtest',                   'supabaseServiceRoleKey present');
  assert(result.port                   === 3000,                        'port defaults to 3000');
  assert(result.twilioAccountSid       === undefined,                   'twilioAccountSid absent → undefined');
  assert(result.twilioAuthToken        === undefined,                   'twilioAuthToken absent → undefined');
  assert(result.twilioFromNumber       === undefined,                   'twilioFromNumber absent → undefined');
  assert(result.githubFeedbackToken    === undefined,                   'githubFeedbackToken absent → undefined');
}

// ── Optional vars — all present ───────────────────────────────

console.log('\n[env] Optional vars — all present');
{
  const result = loadEnv({
    ...validBase(),
    TWILIO_ACCOUNT_SID:    'ACtest',
    TWILIO_AUTH_TOKEN:     'twtest',
    TWILIO_FROM_NUMBER:    '+15550000000',
    GITHUB_FEEDBACK_TOKEN: 'github_pat_test',
    PORT:                  '8080',
  });
  assert(result.twilioAccountSid    === 'ACtest',          'twilioAccountSid present');
  assert(result.twilioAuthToken     === 'twtest',          'twilioAuthToken present');
  assert(result.twilioFromNumber    === '+15550000000',    'twilioFromNumber present');
  assert(result.githubFeedbackToken === 'github_pat_test', 'githubFeedbackToken present');
  assert(result.port                === 8080,              'PORT parsed to number');
}

// ── FCM_PAYLOAD_KEY validation ────────────────────────────────

console.log('\n[env] FCM_PAYLOAD_KEY validation');
{
  // Empty → throws
  assertThrows(
    () => loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: '' }),
    'empty FCM_PAYLOAD_KEY throws',
    err => assert(
      err instanceof EnvConfigError && err.variable === 'FCM_PAYLOAD_KEY',
      '  → EnvConfigError.variable = FCM_PAYLOAD_KEY'
    )
  );
  // Too short → throws
  assertThrows(
    () => loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: 'a'.repeat(63) }),
    '63-char key throws (one char short)'
  );
  // Non-hex character → throws
  assertThrows(
    () => loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: 'z'.repeat(64) }),
    'non-hex char (z) throws'
  );
  // Too long → throws
  assertThrows(
    () => loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: 'a'.repeat(65) }),
    '65-char key throws (one char over)'
  );
  // Valid 64-char lowercase hex → passes
  const result1 = loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: 'f'.repeat(64) });
  assert(result1.fcmPayloadKey === 'f'.repeat(64), '64-char lowercase hex passes');
  // Valid mixed-case hex → passes
  const mixed = 'aAbBcCdDeEfF0123456789aAbBcCdDeEfF0123456789aAbBcCdDeEfF01234567';
  const result2 = loadEnv({ ...validBase(), FCM_PAYLOAD_KEY: mixed });
  assert(result2.fcmPayloadKey === mixed, 'mixed-case hex passes');
}

// ── Required var missing ──────────────────────────────────────

console.log('\n[env] Required var missing');
{
  const required = [
    'FCM_PAYLOAD_KEY',
    'ANTHROPIC_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  for (const key of required) {
    const { [key]: _removed, ...rest } = validBase();
    assertThrows(
      () => loadEnv(rest),
      `missing ${key} throws EnvConfigError`,
      err => assert(
        err instanceof EnvConfigError && err.variable === key,
        `  → EnvConfigError.variable = ${key}`
      )
    );
  }
}

// ── Whitespace trimming ───────────────────────────────────────

console.log('\n[env] Whitespace trimming');
{
  const result = loadEnv({
    ...validBase(),
    FCM_PAYLOAD_KEY:   `  ${VALID_KEY}  `,
    ANTHROPIC_API_KEY: '  sk-ant-test  ',
    SUPABASE_URL:      '  https://test.supabase.co  ',
  });
  assert(result.fcmPayloadKey   === VALID_KEY,                  'FCM_PAYLOAD_KEY trimmed');
  assert(result.anthropicApiKey === 'sk-ant-test',              'ANTHROPIC_API_KEY trimmed');
  assert(result.supabaseUrl     === 'https://test.supabase.co', 'SUPABASE_URL trimmed');
}

// ── PORT edge cases ───────────────────────────────────────────

console.log('\n[env] PORT edge cases');
{
  assertThrows(
    () => loadEnv({ ...validBase(), PORT: 'notanumber' }),
    'non-numeric PORT throws'
  );
  assertThrows(
    () => loadEnv({ ...validBase(), PORT: '0' }),
    'PORT=0 throws (below valid range)'
  );
  assertThrows(
    () => loadEnv({ ...validBase(), PORT: '65536' }),
    'PORT=65536 throws (above valid range)'
  );
  const r1 = loadEnv({ ...validBase(), PORT: '1' });
  assert(r1.port === 1, 'PORT=1 (min valid) passes');
  const r2 = loadEnv({ ...validBase(), PORT: '65535' });
  assert(r2.port === 65535, 'PORT=65535 (max valid) passes');
  // Absent PORT → default 3000
  const { PORT: _p, ...noPort } = { ...validBase(), PORT: '9999' };
  const r3 = loadEnv(noPort);
  assert(r3.port === 3000, 'absent PORT defaults to 3000');
}

// ── Result is frozen ──────────────────────────────────────────

console.log('\n[env] Frozen result');
{
  const result = loadEnv(validBase());
  const before = result.fcmPayloadKey;
  try {
    (result as Record<string, unknown>)['fcmPayloadKey'] = 'mutated';
  } catch { /* strict mode throws — expected */ }
  assert(result.fcmPayloadKey === before, 'frozen — value unchanged after write attempt');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n[env] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
