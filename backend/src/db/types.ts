// ============================================================
// OTM DB — Layer-neutral contracts
// The structural SQLite client interface and the diagnostic
// severity vocabulary. Both are consumed above and below the
// Orchestration layer (comms, db, orchestration tools), so they
// live here in a leaf module with no imports of its own: nothing
// below Orchestration has to reach up into orchestration/types.ts
// for them any more, and the lint zones no longer carry an
// exception for it (otm#86).
//
// orchestration/types.ts re-exports both so orchestration-side
// consumers may keep importing from './types'.
// ============================================================

// ── SQLite Client — shared structural interface ───────────────
// Structural — not tied to a specific library. db/sqliteClient.ts
// is the node:sqlite implementation; tests and the comms layer
// inject stubs or the real client interchangeably.

export interface SqliteClient {
  run(sql: string, params: unknown[]): Promise<void>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

// ── Diagnostic severity vocabulary ────────────────────────────
// Three levels — determined by the tool generating the event,
// never set by the orchestrator directly. The const is the single
// source of truth; the type is derived from it so validators that
// iterate the list cannot drift from the type.

export const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];
