// ============================================================
// OTM DB — Migration entrypoint (side-effectful)
// Invoked via `npm run migrate` (or programmatically by importing
// runMigrations from ./migrationRunner — that module is pure).
// Opens the SQLite DB at BACKEND_SQLITE_PATH (dev default
// data/backend.sqlite3, gitignored), applies pending migrations
// from backend/migrations/, prints the outcome, exits non-zero
// on failure. NOT wired into server boot — that is Phase 4.2.
// Logs paths and migration names only — never row data.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { createSqliteClient } from './sqliteClient';
import { runMigrations } from './migrationRunner';

const DEFAULT_DB_PATH = 'data/backend.sqlite3';

// Resolves to backend/migrations from both src/db (tsx) and
// dist/db (compiled) — two levels up from this module's dir.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

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
      const where = result.version !== undefined
        ? ` in ${result.version}_${result.migrationName}`
        : '';
      console.error(`migrate: FAILED (${result.cause}${where}) — ${result.detail}`);
      return 1;
    }
    console.log(
      `migrate: ${result.applied.length} applied, ${result.skippedCount} skipped (db: ${dbPath})`
    );
    for (const m of result.applied) {
      console.log(`  applied ${String(m.version).padStart(3, '0')}_${m.name}`);
    }
    return 0;
  } finally {
    client.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`migrate: unexpected failure — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
