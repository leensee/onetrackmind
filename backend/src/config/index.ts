// ============================================================
// OTM Backend — Runtime Environment Config
// Imports loadEnv and runs it against process.env at startup.
// This module has intentional side effects: it validates all
// required env vars and fails fast if any are missing.
//
// Import `env` from here in all backend modules that need config.
// Tests import from `./env` (pure functions, no side effects).
// ============================================================

import { loadEnv, OtmEnv, EnvConfigError } from './env';

export type { OtmEnv };
export { EnvConfigError };

// ── Startup Status Log ────────────────────────────────────────
// Key names only — values are never logged at any level.

function logStartupStatus(result: Readonly<OtmEnv>): void {
  const optional: Array<{ label: string; present: boolean }> = [
    { label: 'TWILIO_ACCOUNT_SID',    present: result.twilioAccountSid    !== undefined },
    { label: 'TWILIO_AUTH_TOKEN',     present: result.twilioAuthToken     !== undefined },
    { label: 'TWILIO_FROM_NUMBER',    present: result.twilioFromNumber    !== undefined },
    { label: 'GITHUB_FEEDBACK_TOKEN', present: result.githubFeedbackToken !== undefined },
  ];

  const present = optional.filter(v =>  v.present).map(v => v.label);
  const absent  = optional.filter(v => !v.present).map(v => v.label);

  console.info(
    '[Env] Required vars loaded: FCM_PAYLOAD_KEY, ANTHROPIC_API_KEY, ' +
    'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'
  );
  if (present.length > 0) {
    console.info(`[Env] Optional vars present: ${present.join(', ')}`);
  }
  if (absent.length > 0) {
    console.warn(
      `[Env] Optional vars absent (expected for current phase): ${absent.join(', ')}`
    );
  }
}

// ── Live Config Export ────────────────────────────────────────
// IIFE runs at module load. EnvConfigError propagates to the
// server startup handler, which logs as fatal and exits.

export const env: Readonly<OtmEnv> = (() => {
  const result = loadEnv(process.env);
  logStartupStatus(result);
  return result;
})();
