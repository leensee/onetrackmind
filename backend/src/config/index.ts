// ============================================================
// OTM Backend — Runtime Environment Config
// Imports loadEnv and runs it against process.env at startup.
// This module has intentional side effects: it validates all
// required env vars and fails fast if any are missing.
//
// Import `env` from here in all backend modules that need config.
// Tests import from `./env` (pure functions, no side effects).
// Startup status goes through the injected Logger seam
// (src/observability/logger.ts); the console-backed default is
// used at boot because nothing else exists yet to inject.
// ============================================================

import { loadEnv, OtmEnv, EnvConfigError } from './env';
import { Logger, createConsoleLogger } from '../observability/logger';

export type { OtmEnv };
export { EnvConfigError };

const defaultLogger: Logger = createConsoleLogger('Env');

// ── Startup Status Log ────────────────────────────────────────
// Key names only — values are never logged at any level.

function logStartupStatus(result: Readonly<OtmEnv>, logger: Logger = defaultLogger): void {
  const optional: Array<{ label: string; present: boolean }> = [
    { label: 'TWILIO_ACCOUNT_SID',    present: result.twilioAccountSid    !== undefined },
    { label: 'TWILIO_AUTH_TOKEN',     present: result.twilioAuthToken     !== undefined },
    { label: 'TWILIO_FROM_NUMBER',    present: result.twilioFromNumber    !== undefined },
    { label: 'GITHUB_FEEDBACK_TOKEN', present: result.githubFeedbackToken !== undefined },
  ];

  const present = optional.filter(v =>  v.present).map(v => v.label);
  const absent  = optional.filter(v => !v.present).map(v => v.label);

  logger.info('Required vars loaded', {
    required: 'FCM_PAYLOAD_KEY, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
  });
  if (present.length > 0) {
    logger.info('Optional vars present', { present: present.join(', ') });
  }
  if (absent.length > 0) {
    logger.warn('Optional vars absent (expected for current phase)', { absent: absent.join(', ') });
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
