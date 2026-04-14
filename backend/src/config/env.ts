// ============================================================
// OTM Backend — Environment Loader (pure)
// Pure functions and types for reading and validating env vars.
// Zero module-level side effects — safe to import in tests.
//
// The live runtime config (with startup validation IIFE) lives
// in config/index.ts. Backend modules import `env` from there.
// Tests import `loadEnv` and `EnvConfigError` from here.
// ============================================================

// ── Error Type ────────────────────────────────────────────────

export class EnvConfigError extends Error {
  public readonly variable: string;
  public readonly reason:   string;

  constructor(variable: string, reason: string) {
    super(`Environment configuration error: ${variable} — ${reason}`);
    this.name     = 'EnvConfigError';
    this.variable = variable;
    this.reason   = reason;
  }
}

// ── Env Shape ─────────────────────────────────────────────────

export interface OtmEnv {
  // FCM — required, validated 64-char hex (32 bytes for AES-256-GCM)
  fcmPayloadKey:          string;
  // Anthropic Claude API — required
  anthropicApiKey:        string;
  // Supabase — required; service role key is server-side only
  supabaseUrl:            string;
  supabaseServiceRoleKey: string;
  // Twilio SMS — optional until Phase 4
  twilioAccountSid:       string | undefined;
  twilioAuthToken:        string | undefined;
  twilioFromNumber:       string | undefined;
  // GitHub feedback reporter — optional (approval gate fallback)
  githubFeedbackToken:    string | undefined;
  // Server listen port — defaults to 3000
  port:                   number;
}

// ── Validation Helpers (module-private) ───────────────────────

// Same pattern as validateKeyHex() in outputRouter.ts.
// Not imported from there — config layer must not depend on orchestration.
const FCM_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

function requireString(rawEnv: NodeJS.ProcessEnv, key: string): string {
  const value = rawEnv[key];
  if (!value || value.trim() === '') {
    throw new EnvConfigError(key, 'required but not set');
  }
  return value.trim();
}

function optionalString(rawEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = rawEnv[key];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function requirePort(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv['PORT'];
  if (!raw || raw.trim() === '') return 3000;
  const parsed = parseInt(raw.trim(), 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new EnvConfigError('PORT', `invalid port value — must be 1–65535, got: ${raw.trim()}`);
  }
  return parsed;
}

// ── Loader — exported for isolated testing ────────────────────
// Accepts rawEnv as parameter so tests can pass a controlled object
// without touching process.env or triggering startup side effects.

export function loadEnv(rawEnv: NodeJS.ProcessEnv): Readonly<OtmEnv> {
  const fcmPayloadKey = requireString(rawEnv, 'FCM_PAYLOAD_KEY');
  if (!FCM_KEY_PATTERN.test(fcmPayloadKey)) {
    throw new EnvConfigError(
      'FCM_PAYLOAD_KEY',
      'must be a 64-character hex string (32 bytes for AES-256-GCM)'
    );
  }

  const anthropicApiKey        = requireString(rawEnv, 'ANTHROPIC_API_KEY');
  const supabaseUrl            = requireString(rawEnv, 'SUPABASE_URL');
  const supabaseServiceRoleKey = requireString(rawEnv, 'SUPABASE_SERVICE_ROLE_KEY');

  const twilioAccountSid    = optionalString(rawEnv, 'TWILIO_ACCOUNT_SID');
  const twilioAuthToken     = optionalString(rawEnv, 'TWILIO_AUTH_TOKEN');
  const twilioFromNumber    = optionalString(rawEnv, 'TWILIO_FROM_NUMBER');
  const githubFeedbackToken = optionalString(rawEnv, 'GITHUB_FEEDBACK_TOKEN');

  const port = requirePort(rawEnv);

  return Object.freeze({
    fcmPayloadKey,
    anthropicApiKey,
    supabaseUrl,
    supabaseServiceRoleKey,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    githubFeedbackToken,
    port,
  });
}
