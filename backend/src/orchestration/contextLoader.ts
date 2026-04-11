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

type SettingRow = { setting_key: string; setting_value: string };

function coerceSetting(key: keyof UserSettings, raw: string): UserSettings[keyof UserSettings] {
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

  if (numericKeys.includes(key)) return Number(raw);
  if (booleanKeys.includes(key)) return raw === 'true';
  if (jsonArrayKeys.includes(key)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  // String and union-string keys returned as-is
  return raw;
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
    const key = row.setting_key as keyof UserSettings;
    if (key in DEFAULT_USER_SETTINGS) {
      settingsMap[key] = coerceSetting(key, row.setting_value);
    }
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
