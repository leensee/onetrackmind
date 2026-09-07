// ============================================================
// OTM DB — Migration entrypoint (side-effectful)
// Invoked via `npm run migrate` (or programmatically by importing
// runMigrations from ./migrationRunner — that module is pure).
// Opens the SQLite DB at BACKEND_SQLITE_PATH (dev default
// data/backend.sqlite3, gitignored), applies pending migrations
// from backend/migrations/, reports the outcome through the
// Logger seam, exits non-zero on failure. NOT wired into server
// boot — that is deliverable 4.2, scheduled inside Phase 12
// (Communications Provider Integration).
// Logs paths and migration names only — never row data.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createSqliteClient } from './sqliteClient';
import { runMigrations } from './migrationRunner';
import { Logger, createConsoleLogger } from '../observability/logger';

const DEFAULT_DB_PATH = 'data/backend.sqlite3';

// Resolves to backend/migrations from both src/db (tsx) and
// dist/db (compiled) — two levels up from this module's dir.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

// CLI entrypoint: the console-backed default IS the user interface here.
const log: Logger = createConsoleLogger('migrate');

async function main(): Promise<number> {
  const rawPath = process.env['BACKEND_SQLITE_PATH'];
  const dbPath = rawPath && rawPath.trim() !== '' ? rawPath.trim() : DEFAULT_DB_PATH;

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const client = createSqliteClient(dbPath);
  try {
    const result = await runMigrations(client, MIGRATIONS_DIR);
    if (!result.ok) {
      // Only name the migration when the failure happened inside one.
      const fields: Record<string, unknown> = { cause: result.cause, detail: result.detail };
      if (result.version !== undefined) {
        fields['migration'] = `${result.version}_${result.migrationName}`;
      }
      log.error('FAILED', fields);
      return 1;
    }
    log.info('complete', {
      applied: result.applied.length,
      skipped: result.skippedCount,
      db:      dbPath,
    });
    for (const m of result.applied) {
      log.info('applied', { migration: `${String(m.version).padStart(3, '0')}_${m.name}` });
    }
    return 0;
  } finally {
    client.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    log.error('unexpected failure', {
      detail: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
