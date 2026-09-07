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

function isBindValue(value: unknown): value is BindValue {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  );
}

// Checks every parameter at the driver boundary. node:sqlite would
// reject an unsupported value itself, but with a driver-internal
// message; naming the offending index here keeps the failure
// diagnosable. Throws TypeError — a caller bug, not an operational
// condition — which the async wrappers surface as a rejected promise
// like any other SQLite error.
function toBindValues(params: unknown[]): BindValue[] {
  return params.map((value, index) => {
    if (isBindValue(value)) return value;
    throw new TypeError(
      `SQLite bind parameter ${index} has unsupported type ${value === undefined ? 'undefined' : typeof value}`
    );
  });
}

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
      db.prepare(sql).run(...toBindValues(params));
    },

    async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
      const row = db.prepare(sql).get(...toBindValues(params));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- sanctioned narrow waist: SqliteClient.get<T> is the driver boundary; T is the caller's declared row shape and cannot be validated generically here (callers own row typing per the interface contract)
      return row === undefined ? undefined : (row as T);
    },

    async all<T>(sql: string, params: unknown[]): Promise<T[]> {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- sanctioned narrow waist: SqliteClient.all<T> is the driver boundary; T is the caller's declared row shape and cannot be validated generically here (callers own row typing per the interface contract)
      return db.prepare(sql).all(...toBindValues(params)) as T[];
    },

    close(): void {
      db.close();
    },
  };
}
