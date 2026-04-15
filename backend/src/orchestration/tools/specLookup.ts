// ============================================================
// OTM Tools — Spec Lookup
// General-purpose machine spec retrieval. Covers consist
// positions 1–14 and support equipment. EAV data model.
// DB client is injected — never constructed here.
// All queries parameterized — no string interpolation.
//
// Three result states, all requiring explicit caller action:
//   unknown_machine → identifier matched nothing
//   ambiguous       → multiple machines matched; surface all to user
//   found           → entries + unknownKeys; both always surfaced
// ============================================================

import {
  MachineIdentity,
  MachineRosterEntry,
  SpecEntry,
  SpecLookupInput,
  SpecLookupResult,
} from '../types';

// ── Narrow DB Interface ───────────────────────────────────────
// Only exposes what this module needs — easier to stub in tests.

export interface SpecLookupDbClient {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

// ── Error ─────────────────────────────────────────────────────

export class SpecLookupError extends Error {
  public readonly sessionId:  string;
  public readonly requestId:  string;
  public readonly cause:      'db_error';

  constructor(message: string, sessionId: string, requestId: string) {
    super(message);
    this.name      = 'SpecLookupError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = 'db_error';
  }
}

// ── Raw DB Row Types ──────────────────────────────────────────
// Exported so tests can construct inputs for pure functions
// without casts.

export interface RawRosterRow {
  machine_id:   string;
  position:     number | null;
  full_name:    string;
  machine_type: 'consist' | 'support';
  serial_number: string | null;
  common_names: string;   // JSON text: string[]
}

export interface RawSpecRow {
  spec_key:     string;
  spec_value:   string | null;
  unit:         string | null;
  source:       string | null;
  confirmed_at: string | null;
  is_gap:       number;   // SQLite integer: 0 | 1
}

// ── Roster Row → MachineRosterEntry ───────────────────────────
// Pure mapping — exported for testing.

export function mapRosterRow(row: RawRosterRow): MachineRosterEntry {
  let commonNames: string[] = [];
  try {
    const parsed = JSON.parse(row.common_names);
    if (Array.isArray(parsed)) {
      commonNames = parsed.filter((n): n is string => typeof n === 'string');
    }
  } catch {
    // Malformed JSON in DB — treat as no common names; log at call site
  }

  return {
    machineId:    row.machine_id,
    position:     row.position,
    fullName:     row.full_name,
    machineType:  row.machine_type,
    serialNumber: row.serial_number ?? undefined,
    commonNames,
  };
}

// ── Identifier Resolution ─────────────────────────────────────
// Pure function — no DB access. Exported for isolated testing.
//
// Resolution order (short-circuits on unambiguous match):
//   1. Position number — strip prefix ('pos ', 'position ', '#'),
//      parse as integer, match on position field.
//      Position is inherently unique — always unambiguous.
//   2. Serial number — exact case-insensitive match.
//      Serials are unique — always unambiguous.
//   3. Full name — exact case-insensitive match.
//      Names are unique — always unambiguous.
//   4. Common name exact — case-insensitive equality against
//      every element of every machine's commonNames[].
//      Collects ALL matches. 1 → found. >1 → ambiguous. 0 → step 5.
//   5. Common name contains — normalized query contained in a
//      common name, or common name contained in query.
//      Only runs if step 4 produced zero matches.
//      Same collect-all logic: 1 → found. >1 → ambiguous. 0 → not_found.
//
// 'ambiguous' is a first-class result — the caller surfaces all
// candidates to the user for disambiguation, never guesses.

export type ResolutionResult =
  | { status: 'found';     machine: MachineRosterEntry }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: MachineRosterEntry[] };

export function resolveMachineIdentifier(
  query:   string,
  roster:  MachineRosterEntry[]
): ResolutionResult {
  const q = query.trim();
  const qLower = q.toLowerCase();

  // Step 1: Position number
  const posStripped = qLower
    .replace(/^position\s+/, '')
    .replace(/^pos\s+/, '')
    .replace(/^#/, '')
    .trim();
  if (/^\d+$/.test(posStripped)) {
    const posNum = parseInt(posStripped, 10);
    const match = roster.find(m => m.position === posNum);
    if (match) return { status: 'found', machine: match };
    // Integer that doesn't match any position — fall through
  }

  // Step 2: Serial number (exact, case-insensitive)
  const bySerial = roster.find(
    m => m.serialNumber !== undefined &&
         m.serialNumber.toLowerCase() === qLower
  );
  if (bySerial) return { status: 'found', machine: bySerial };

  // Step 3: Full name (exact, case-insensitive)
  const byFullName = roster.find(m => m.fullName.toLowerCase() === qLower);
  if (byFullName) return { status: 'found', machine: byFullName };

  // Step 4: Common name exact (case-insensitive equality)
  const exactMatches = roster.filter(m =>
    m.commonNames.some(cn => cn.toLowerCase() === qLower)
  );
  if (exactMatches.length === 1) return { status: 'found', machine: exactMatches[0]! };
  if (exactMatches.length > 1)  return { status: 'ambiguous', candidates: exactMatches };

  // Step 5: Common name contains (only if step 4 found nothing)
  const containsMatches = roster.filter(m =>
    m.commonNames.some(cn => {
      const cnLower = cn.toLowerCase();
      return cnLower.includes(qLower) || qLower.includes(cnLower);
    })
  );
  if (containsMatches.length === 1) return { status: 'found', machine: containsMatches[0]! };
  if (containsMatches.length > 1)  return { status: 'ambiguous', candidates: containsMatches };

  return { status: 'not_found' };
}

// ── Spec Row Mapping ──────────────────────────────────────────
// Pure function — exported for testing.

export function mapSpecRow(row: RawSpecRow): SpecEntry {
  return {
    key:         row.spec_key,
    value:       row.spec_value,
    unit:        row.unit        ?? undefined,
    source:      row.source      ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    isGap:       row.is_gap === 1,
  };
}

// ── Build Result ──────────────────────────────────────────────
// Pure function — no DB access. Exported for testing.
// Applies key filtering and computes unknownKeys.
// unknownKeys: requested keys with zero matching rows in the DB —
// distinct from isGap (key exists, value unconfirmed).
// Both unknownKeys and isGap entries must always reach the caller.

export function buildSpecLookupResult(
  machine:       MachineRosterEntry,
  rows:          RawSpecRow[],
  requestedKeys?: string[]
): Extract<SpecLookupResult, { found: true }> {
  const identity: MachineIdentity = {
    machineId:   machine.machineId,
    position:    machine.position,
    fullName:    machine.fullName,
    machineType: machine.machineType,
  };

  if (!requestedKeys || requestedKeys.length === 0) {
    // No key filter — return all entries
    return {
      found:       true,
      machine:     identity,
      entries:     rows.map(mapSpecRow),
      unknownKeys: [],
    };
  }

  // Filter entries to requested keys only
  const requestedLower = requestedKeys.map(k => k.toLowerCase());
  const matched = rows.filter(r =>
    requestedLower.includes(r.spec_key.toLowerCase())
  );

  // unknownKeys: requested keys with zero rows in the DB at all
  const returnedKeys = new Set(matched.map(r => r.spec_key.toLowerCase()));
  const unknownKeys  = requestedKeys.filter(
    k => !returnedKeys.has(k.toLowerCase())
  );

  return {
    found:       true,
    machine:     identity,
    entries:     matched.map(mapSpecRow),
    unknownKeys,
  };
}

// ── DB Queries ────────────────────────────────────────────────

// Fetches full roster — consist positions AND support equipment.
// machine_type column in fleet_master distinguishes them.
// common_names stored as JSON text array.

export async function fetchRoster(
  db: SpecLookupDbClient
): Promise<MachineRosterEntry[]> {
  const rows = await db.all<RawRosterRow>(
    `SELECT machine_id, position, full_name, machine_type,
            serial_number, common_names
     FROM fleet_master
     ORDER BY machine_type ASC, position ASC NULLS LAST`,
    []
  );

  return rows.map((row, idx) => {
    try {
      return mapRosterRow(row);
    } catch {
      // Log parse failures per row; non-fatal — skip malformed rows
      console.warn(
        `[SpecLookup] skipping malformed roster row index=${idx} ` +
        `machine_id=${row.machine_id}`
      );
      return null;
    }
  }).filter((m): m is MachineRosterEntry => m !== null);
}

// Fetches all spec rows for a given machine_id.
// Key filtering is applied in the pure buildSpecLookupResult —
// keeping filter logic out of the DB layer keeps it testable.

export async function fetchSpecRows(
  machineId: string,
  db:        SpecLookupDbClient
): Promise<RawSpecRow[]> {
  return db.all<RawSpecRow>(
    `SELECT spec_key, spec_value, unit, source, confirmed_at, is_gap
     FROM machine_specs
     WHERE machine_id = ?
     ORDER BY spec_key ASC`,
    [machineId]
  );
}

// ── Main Entry ────────────────────────────────────────────────

export async function specLookup(
  input: SpecLookupInput,
  db:    SpecLookupDbClient
): Promise<SpecLookupResult> {
  const { identifier, keys, sessionId, requestId } = input;

  let roster: MachineRosterEntry[];
  try {
    roster = await fetchRoster(db);
  } catch (err) {
    throw new SpecLookupError(
      `Roster fetch failed: ${(err as Error).message}`,
      sessionId, requestId
    );
  }

  const resolution = resolveMachineIdentifier(identifier, roster);

  if (resolution.status === 'not_found') {
    return { found: false, reason: 'unknown_machine' };
  }

  if (resolution.status === 'ambiguous') {
    return {
      found:      false,
      reason:     'ambiguous',
      candidates: resolution.candidates.map(m => ({
        machineId:   m.machineId,
        position:    m.position,
        fullName:    m.fullName,
        machineType: m.machineType,
      })),
    };
  }

  const machine = resolution.machine;

  let specRows: RawSpecRow[];
  try {
    specRows = await fetchSpecRows(machine.machineId, db);
  } catch (err) {
    throw new SpecLookupError(
      `Spec fetch failed for machineId=${machine.machineId}: ${(err as Error).message}`,
      sessionId, requestId
    );
  }

  return buildSpecLookupResult(machine, specRows, keys);
}
