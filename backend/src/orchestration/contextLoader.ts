// ============================================================
// OTM Orchestration — Context Loader
// Loads and pre-filters all context needed for a given event.
// Relevance judgment lives here — assembler receives only what
// is relevant to the current input.
// DB client is injected — never constructed here.
// ============================================================

import { SupabaseClient } from '@supabase/supabase-js';
import {
  ContextLoaderInput,
  ContextLoaderOutput,
  ContextualData,
  UserSettings,
  ActiveFlag,
  OpenItem,
  ConsistContext,
  MachineRef,
  ProcessedEvent,
  SessionState,
  EditionConfig,
} from './types';

// ── Default Settings ──────────────────────────────────────────
// Applied for any key absent from user_settings rows.
// First-session state — not an error condition.

export const DEFAULT_USER_SETTINGS: UserSettings = {
  digestThresholdHours:         8,
  pushRepeatIntervalHours:      2,
  budgetVariancePushThreshold:  500,
  budgetVariancePullThreshold:  200,
  defaultSessionOpenPreference: 'summary',
  wakeWordSensitivity:          0.5,
  ttsRate:                      1.0,
  voiceResponseMode:            'wake_word_only',
  shiftStartTime:               '06:00',
  timeZone:                     'America/Chicago',
  commsLogRetentionDays:        90,
  styleExclusions:              [],
  styleProfileVisible:          true,
};

// ── Context Loader Error ──────────────────────────────────────
// Domain-specific error. Always propagated — never swallowed.
// Carries userId and operation for orchestrator-level logging.

export class ContextLoaderError extends Error {
  public readonly userId: string;
  public readonly operation: string;

  constructor(message: string, userId: string, operation: string) {
    super(message);
    this.name = 'ContextLoaderError';
    this.userId = userId;
    this.operation = operation;
  }
}

// ── Style Profile Fetch ───────────────────────────────────────

export async function fetchStyleProfile(
  userId: string,
  db: SupabaseClient
): Promise<string> {
  const { data, error } = await db
    .from('style_observations')
    .select('summary')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new ContextLoaderError(
      `Supabase error: ${error.message}`,
      userId,
      'fetchStyleProfile'
    );
  }

  // No rows = first session. Empty string is valid — not an error.
  if (!data || data.length === 0) {
    console.info(`[ContextLoader] fetchStyleProfile userId=${userId} result=empty (first session)`);
    return '';
  }

  const row = data[0] as { summary: string };
  console.info(
    `[ContextLoader] fetchStyleProfile userId=${userId} resultLength=${row.summary.length}chars`
  );
  return row.summary;
}

// ── User Settings Fetch ───────────────────────────────────────
// Maps setting_key/setting_value rows into typed UserSettings.
// Applies DEFAULT_USER_SETTINGS for any missing keys.
// Corrupt values surface as ContextLoaderError rather than silently
// coercing to NaN / [] / out-of-union strings. Resolves
// 2026-04-16-CL-5..CL-8.

type SettingRow = { setting_key: string; setting_value: string };

// Discriminated coercion result — pure, never throws. Caller has
// the userId context needed to build a meaningful ContextLoaderError.
export type CoerceResult =
  | { ok: true;  value: UserSettings[keyof UserSettings] }
  | { ok: false;
      reason:
        | 'malformed_json'
        | 'wrong_shape'
        | 'non_finite_number'
        | 'invalid_union'
        | 'invalid_boolean';
      detail: string;
    };

// String-union keys on UserSettings. Any key present here must match
// one of the allowed values; any key absent is treated as a plain string.
const UNION_VALUES = {
  voiceResponseMode:            ['always', 'wake_word_only', 'never'],
  defaultSessionOpenPreference: ['summary', 'skip'],
} as const satisfies Partial<Record<keyof UserSettings, readonly string[]>>;

function isUserSettingsKey(k: string): k is keyof UserSettings {
  return Object.hasOwn(DEFAULT_USER_SETTINGS, k);
}

export function coerceSetting(key: keyof UserSettings, raw: string): CoerceResult {
  const numericKeys: Array<keyof UserSettings> = [
    'digestThresholdHours',
    'pushRepeatIntervalHours',
    'budgetVariancePushThreshold',
    'budgetVariancePullThreshold',
    'wakeWordSensitivity',
    'ttsRate',
    'commsLogRetentionDays',
  ];
  const booleanKeys: Array<keyof UserSettings> = ['styleProfileVisible'];
  const jsonArrayKeys: Array<keyof UserSettings> = ['styleExclusions'];

  if (numericKeys.includes(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { ok: false, reason: 'non_finite_number', detail: `raw=${JSON.stringify(raw)}` };
    }
    return { ok: true, value: n };
  }

  if (booleanKeys.includes(key)) {
    if (raw === 'true')  return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, reason: 'invalid_boolean', detail: `raw=${JSON.stringify(raw)}` };
  }

  if (jsonArrayKeys.includes(key)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: 'malformed_json', detail: (err as Error).message };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'wrong_shape', detail: `expected array, got ${typeof parsed}` };
    }
    if (!parsed.every(v => typeof v === 'string')) {
      return { ok: false, reason: 'wrong_shape', detail: 'array contained non-string element' };
    }
    return { ok: true, value: parsed as string[] };
  }

  const allowed: readonly string[] | undefined =
    (UNION_VALUES as Partial<Record<keyof UserSettings, readonly string[]>>)[key];
  if (allowed && !allowed.includes(raw)) {
    return {
      ok: false,
      reason: 'invalid_union',
      detail: `value=${JSON.stringify(raw)} not in [${allowed.join(', ')}]`,
    };
  }

  // Plain string key — pass through
  return { ok: true, value: raw };
}

export async function fetchUserSettings(
  userId: string,
  editionId: string,
  db: SupabaseClient
): Promise<UserSettings> {
  const { data, error } = await db
    .from('user_settings')
    .select('setting_key, setting_value')
    .eq('user_id', userId)
    .eq('edition_id', editionId);

  if (error) {
    throw new ContextLoaderError(
      `Supabase error: ${error.message}`,
      userId,
      'fetchUserSettings'
    );
  }

  const rows: SettingRow[] = (data ?? []) as SettingRow[];
  console.info(
    `[ContextLoader] fetchUserSettings userId=${userId} editionId=${editionId} rows=${rows.length}`
  );

  // Start from defaults; overlay any persisted values.
  // Cast through unknown to satisfy exactOptionalPropertyTypes — the
  // index write is safe because key is constrained to keyof UserSettings.
  const settings: UserSettings = { ...DEFAULT_USER_SETTINGS };
  const settingsMap = settings as unknown as Record<string, unknown>;

  for (const row of rows) {
    // Unknown keys warn-and-continue — treated as forward-compat drift,
    // same pattern as schemaVersion mismatch in sessionPersistence.
    if (!isUserSettingsKey(row.setting_key)) {
      console.warn(
        `[ContextLoader] unknown user_settings key=${row.setting_key} userId=${userId} — skipping`
      );
      continue;
    }
    const result = coerceSetting(row.setting_key, row.setting_value);
    if (!result.ok) {
      throw new ContextLoaderError(
        `Corrupt user_settings row key=${row.setting_key} reason=${result.reason} ${result.detail}`,
        userId,
        'fetchUserSettings'
      );
    }
    settingsMap[row.setting_key] = result.value;
  }

  return settings;
}

// ── Machine Reference Detection ───────────────────────────────
// Pure helper. Checks whether the event rawContent references
// a specific machine by name, position, or serial number.

function machineIsReferenced(machine: MachineRef, content: string): boolean {
  const lower = content.toLowerCase();

  if (lower.includes(machine.name.toLowerCase())) return true;

  const pos = machine.position;
  if (
    lower.includes(`pos ${pos}`) ||
    lower.includes(`position ${pos}`) ||
    lower.includes(`#${pos}`)
  ) return true;

  if (machine.serialNumber && lower.includes(machine.serialNumber.toLowerCase())) return true;

  return false;
}

// ── Context Filter ────────────────────────────────────────────
// Pure synchronous function — no DB access.
// Relevance judgment for session context given the current event.

export function filterContextForEvent(
  event: ProcessedEvent,
  sessionState: SessionState,
  _editionConfig: EditionConfig   // reserved for future edition-specific filter tuning
): ContextualData {
  const { eventType, rawContent } = event;
  const { activeFlags, openItems, consistContext } = sessionState;

  // system_trigger and session_lifecycle: full unacknowledged flags + all open items
  if (eventType === 'system_trigger' || eventType === 'session_lifecycle') {
    return {
      activeFlags: activeFlags.filter(f => !f.acknowledged),
      openItems:   [...openItems],
      consistContext: null,
    };
  }

  // inbound_sms and inbound_email: safety flags only, no consist context
  if (eventType === 'inbound_sms' || eventType === 'inbound_email') {
    return {
      activeFlags: activeFlags.filter(f => f.type === 'safety'),
      openItems:   [],
      consistContext: null,
    };
  }

  // user_message: check for machine references
  if (eventType === 'user_message') {
    if (!consistContext || consistContext.relevantMachines.length === 0) {
      return {
        activeFlags: activeFlags.filter(f => f.type === 'safety'),
        openItems:   [],
        consistContext: null,
      };
    }

    const referencedMachines = consistContext.relevantMachines.filter(m =>
      machineIsReferenced(m, rawContent)
    );

    if (referencedMachines.length === 0) {
      return {
        activeFlags: activeFlags.filter(f => f.type === 'safety'),
        openItems:   [],
        consistContext: null,
      };
    }

    // Machine(s) referenced — include linked items and all safety flags
    const filteredItems: OpenItem[] = openItems.filter(item => {
      if (item.category === 'machine') {
        return referencedMachines.some(m =>
          item.content.toLowerCase().includes(m.name.toLowerCase()) ||
          item.content.includes(`pos ${m.position}`) ||
          item.content.includes(`#${m.position}`)
        );
      }
      return false;
    });

    // Safety flags always included; additionally include non-safety flags
    // that reference the matched machines
    const safetyFlags: ActiveFlag[] = activeFlags.filter(f => f.type === 'safety');
    const machineFlags: ActiveFlag[] = activeFlags.filter(f =>
      f.type !== 'safety' &&
      referencedMachines.some(m =>
        f.content.toLowerCase().includes(m.name.toLowerCase()) ||
        f.content.includes(`pos ${m.position}`)
      )
    );

    // Deduplicate by flagId
    const seenFlagIds = new Set<string>();
    const dedupedFlags: ActiveFlag[] = [...safetyFlags, ...machineFlags].filter(f => {
      if (seenFlagIds.has(f.flagId)) return false;
      seenFlagIds.add(f.flagId);
      return true;
    });

    const filteredConsist: ConsistContext = {
      consistId:        consistContext.consistId,
      relevantMachines: referencedMachines,
    };

    return {
      activeFlags:    dedupedFlags,
      openItems:      filteredItems,
      consistContext: filteredConsist,
    };
  }

  // Fallback — unknown event type: safety flags only, no consist context
  console.warn(
    `[ContextLoader] filterContextForEvent: unhandled eventType='${eventType}' — returning safety flags only.`
  );
  return {
    activeFlags: activeFlags.filter(f => f.type === 'safety'),
    openItems:   [],
    consistContext: null,
  };
}

// ── Main Entry Point ──────────────────────────────────────────

export async function loadContext(
  input: ContextLoaderInput,
  db: SupabaseClient
): Promise<ContextLoaderOutput> {
  const { event, sessionState, editionConfig } = input;
  const { userId, editionId } = sessionState;

  const startMs = Date.now();

  // Style profile and settings have no dependency on each other — fetch in parallel
  const [styleProfile, userSettings] = await Promise.all([
    fetchStyleProfile(userId, db),
    fetchUserSettings(userId, editionId, db),
  ]);

  // Relevance filtering is synchronous — no DB dependency
  const contextualData = filterContextForEvent(event, sessionState, editionConfig);

  const durationMs = Date.now() - startMs;
  console.info(
    `[ContextLoader] loadContext sessionId=${sessionState.sessionId} ` +
    `userId=${userId} editionId=${editionId} durationMs=${durationMs}`
  );

  return {
    styleProfile,
    userSettings,
    contextualData,
  };
}
