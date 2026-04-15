// ============================================================
// OTM Tools — Spec Lookup
// General-purpose machine spec retrieval. Covers consist
// positions 1–14 and support equipment. EAV data model.
// DB client is injected — never constructed here.
// All queries parameterized — no string interpolation.
//
// Four result states, all requiring explicit caller action:
//   found        → entries + unknownKeys; both always surfaced to user
//   not_found    → unknown_machine (matched nothing) or ambiguous (multiple matches)
//   error        → db_error; returned, never thrown; orchestrator routes on it
// ============================================================

import {
  MachineIdentity,
  MachineRosterEntry,
  SpecEntry,
  SpecLookupInput,
  SpecLookupResult,
} from '../types';

// ── Narrow DB Interface ───────────────────────────────────────

export interface SpecLookupDbClient {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

// ── Raw DB Row Types ──────────────────────────────────────────
// Exported so tests can construct inputs without casts.

export interface RawRosterRow {
  machine_id:    string;
  position:      number | null;
  full_name:     string;
  machine_type:  'consist' | 'support';
  serial_number: string | null;
  common_names:  string;   // JSON text: string[]
}

export interface RawSpecRow {
  spec_key:     string;
  spec_value:   string | null;
  unit:         string | null;
  source:       string | null;
  confirmed_at: string | null;
  is_gap:       number;   // SQLite integer: 0 | 1
}

// ── Roster Row → MachineRosterEntry ──────────────────────────
// Pure mapping — exported for testing.

export function mapRosterRow(row: RawRosterRow): MachineRosterEntry {
  let commonNames: string[] = [];
  try {
    const parsed = JSON.parse(row.common_names);
    if (Array.isArray(parsed)) {
      commonNames = parsed.filter((n): n is string => typeof n === 'string');
    }
  } catch {
    // Malformed JSON — treat as no common names; log at call site
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
//   1. Position number — strip prefix ('pos ', 'position ', '#'), parse as int.
//   2. Serial number — exact case-insensitive match.
//   3. Full name — exact case-insensitive match.
//   4. Common name exact — equality against every element. Collect ALL.
//      1 → found. >1 → ambiguous. 0 → step 5.
//   5. Common name contains — query in name or name in query.
//      Only if step 4 found nothing. Same collect-all logic.
//
// 'ambiguous' is first-class — caller surfaces all candidates to
// the user for disambiguation, never guesses.

export type ResolutionResult =
  | { status: 'found';     machine: MachineRosterEntry }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: MachineRosterEntry[] };

export function resolveMachineIdentifier(
  query:  string,
  roster: MachineRosterEntry[]
): ResolutionResult {
  const q      = query.trim();
  const qLower = q.toLowerCase();

  // Step 1: Position number
  const posStripped = qLower
    .replace(/^position\s+/, '')
    .replace(/^pos\s+/, '')
    .replace(/^#/, '')
    .trim();
  if (/^\d+$/.test(posStripped)) {
    const posNum = parseInt(posStripped, 10);
    const match  = roster.find(m => m.position === posNum);
    if (match) return { status: 'found', machine: match };
  }

  // Step 2: Serial number (exact, case-insensitive)
  const bySerial = roster.find(
    m => m.serialNumber !== undefined && m.serialNumber.toLowerCase() === qLower
  );
  if (bySerial) return { status: 'found', machine: bySerial };

  // Step 3: Full name (exact, case-insensitive)
  const byFullName = roster.find(m => m.fullName.toLowerCase() === qLower);
  if (byFullName) return { status: 'found', machine: byFullName };

  // Step 4: Common name exact
  const exactMatches = roster.filter(m =>
    m.commonNames.some(cn => cn.toLowerCase() === qLower)
  );
  if (exactMatches.length === 1) return { status: 'found',     machine:    exactMatches[0]! };
  if (exactMatches.length  > 1)  return { status: 'ambiguous', candidates: exactMatches };

  // Step 5: Common name contains
  const containsMatches = roster.filter(m =>
    m.commonNames.some(cn => {
      const cnLower = cn.toLowerCase();
      return cnLower.includes(qLower) || qLower.includes(cnLower);
    })
  );
  if (containsMatches.length === 1) return { status: 'found',     machine:    containsMatches[0]! };
  if (containsMatches.length  > 1)  return { status: 'ambiguous', candidates: containsMatches };

  return { status: 'not_found' };
}

// ── Spec Row Mapping ──────────────────────────────────────────
// Pure function — exported for testing.

export function mapSpecRow(row: RawSpecRow): SpecEntry {
  return {
    key:         row.spec_key,
    value:       row.spec_value,
    unit:        row.unit         ?? undefined,
    source:      row.source       ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    isGap:       row.is_gap === 1,
  };
}

// ── Build Result ──────────────────────────────────────────────
// Pure function — no DB access. Exported for testing.
// Applies key filtering and computes unknownKeys.
// unknownKeys: requested keys with zero rows — distinct from isGap.
// Both unknownKeys and isGap entries must always reach the caller.

export function buildSpecLookupResult(
  machine:        MachineRosterEntry,
  rows:           RawSpecRow[],
  requestedKeys?: string[]
): Extract<SpecLookupResult, { status: 'found' }> {
  const identity: MachineIdentity = {
    machineId:   machine.machineId,
    position:    machine.position,
    fullName:    machine.fullName,
    machineType: machine.machineType,
  };

  if (!requestedKeys || requestedKeys.length === 0) {
    return { status: 'found', machine: identity, entries: rows.map(mapSpecRow), unknownKeys: [] };
  }

  const requestedLower = requestedKeys.map(k => k.toLowerCase());
  const matched        = rows.filter(r => requestedLower.includes(r.spec_key.toLowerCase()));
  const returnedKeys   = new Set(matched.map(r => r.spec_key.toLowerCase()));
  const unknownKeys    = requestedKeys.filter(k => !returnedKeys.has(k.toLowerCase()));

  return { status: 'found', machine: identity, entries: matched.map(mapSpecRow), unknownKeys };
}

// ── DB Queries ────────────────────────────────────────────────

export async function fetchRoster(db: SpecLookupDbClient): Promise<MachineRosterEntry[]> {
  const rows = await db.all<RawRosterRow>(
    `SELECT machine_id, position, full_name, machine_type, serial_number, common_names
     FROM fleet_master
     ORDER BY machine_type ASC, position ASC NULLS LAST`,
    []
  );
  return rows.map((row, idx) => {
    try {
      return mapRosterRow(row);
    } catch {
      console.warn(
        `[SpecLookup] skipping malformed roster row index=${idx} machine_id=${row.machine_id}`
      );
      return null;
    }
  }).filter((m): m is MachineRosterEntry => m !== null);
}

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
// Never throws on operational failures — all error states returned.
// Throws only on precondition violations (null client, etc.).

export async function specLookup(
  input: SpecLookupInput,
  db:    SpecLookupDbClient
): Promise<SpecLookupResult> {
  const { identifier, keys, sessionId, requestId } = input;

  let roster: MachineRosterEntry[];
  try {
    roster = await fetchRoster(db);
  } catch (err) {
    return {
      status:  'error',
      cause:   'db_error',
      message: `Roster fetch failed [sessionId=${sessionId} requestId=${requestId}]: ${(err as Error).message}`,
    };
  }

  const resolution = resolveMachineIdentifier(identifier, roster);

  if (resolution.status === 'not_found') {
    return { status: 'not_found', reason: 'unknown_machine' };
  }

  if (resolution.status === 'ambiguous') {
    return {
      status:     'not_found',
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
    return {
      status:  'error',
      cause:   'db_error',
      message: `Spec fetch failed [machineId=${machine.machineId} sessionId=${sessionId}]: ${(err as Error).message}`,
    };
  }

  return buildSpecLookupResult(machine, specRows, keys);
}
