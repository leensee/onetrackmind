// ============================================================
// OTM DB — Concrete SqliteClient over node:sqlite (built-in)
// Implements the structural SqliteClient interface from
// orchestration/types.ts — the rest of the backend stays
// library-agnostic and keeps injecting the interface.
//
// No module-level side effects — the database opens only when
// createSqliteClient() is called. PRAGMA foreign_keys = ON is
// set per connection here (SQLite defaults it OFF).
//
// DatabaseSync is synchronous; the async methods wrap it so a
// synchronous SQLite error surfaces as a rejected promise —
// callers catch and convert to typed results (house pattern).
// All queries parameterized — no string interpolation.
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import { SqliteClient } from '../orchestration/types';

// Values node:sqlite accepts as anonymous bind parameters.
// Local alias — @types/node has renamed this type across majors.
type BindValue = null | number | bigint | string | Uint8Array;

export interface ManagedSqliteClient extends SqliteClient {
  /** Closes the underlying connection. Further calls reject. */
  close(): void;
}

// Throws only on precondition violation (blank path — a bug in
// the caller, not an operational condition). SQLite errors from
// run/get/all propagate as promise rejections.
export function createSqliteClient(dbPath: string): ManagedSqliteClient {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new Error('createSqliteClient: dbPath must be a non-empty string');
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  return {
    async run(sql: string, params: unknown[]): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as-cast audit debt (otm#85): node:sqlite driver boundary, untyped rows/params
      db.prepare(sql).run(...(params as BindValue[]));
    },

    async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as-cast audit debt (otm#85): node:sqlite driver boundary, untyped rows/params
      const row = db.prepare(sql).get(...(params as BindValue[]));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as-cast audit debt (otm#85): node:sqlite driver boundary, untyped rows/params
      return row === undefined ? undefined : (row as T);
    },

    async all<T>(sql: string, params: unknown[]): Promise<T[]> {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as-cast audit debt (otm#85): node:sqlite driver boundary, untyped rows/params
      return db.prepare(sql).all(...(params as BindValue[])) as T[];
    },

    close(): void {
      db.close();
    },
  };
}
