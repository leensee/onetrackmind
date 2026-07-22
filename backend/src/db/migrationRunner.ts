// ============================================================
// OTM DB — Migration Runner (pure logic)
// Hand-rolled, forward-only migrations: migrations/NNN_name.sql
// applied in ascending version order; applied versions recorded
// in schema_migrations; re-runs skip applied files (no-op when
// nothing is pending); failures roll back the current migration
// and return a typed result.
//
// SQLite client is injected — never constructed here. This module
// has no import-time side effects (fs access happens inside
// functions at call time) — safe to import in tests. The
// side-effectful entrypoint is ./migrate.ts.
//
// Error handling (house rule): operational failures return typed
// results — never throw. Throws only on precondition violations
// (null client, blank dir) — those are caller bugs.
//
// Migration file conventions (enforced/assumed by the splitter):
//   - Filename NNN_name.sql (three digits, snake_case name).
//   - Statements separated by ';'. Only '--' line comments.
//     No /* */ block comments; no ';' inside comments needed.
//   - String literals '...' and quoted identifiers "..." may
//     contain ';' — the splitter tracks quote state.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { SqliteClient } from '../orchestration/types';

// ── Types ─────────────────────────────────────────────────────

export interface MigrationFile {
  version: number;   // from the NNN filename prefix
  name:    string;   // filename minus prefix and .sql
  sql:     string;   // full file contents
}

export type MigrationLoadResult =
  | { ok: true;  migrations: MigrationFile[] }
  | { ok: false;
      cause: 'dir_not_found' | 'invalid_filename' | 'duplicate_version' | 'read_error';
      detail: string };

export interface AppliedMigration {
  version: number;
  name:    string;
}

export type MigrationRunResult =
  | { ok: true;  applied: AppliedMigration[]; skippedCount: number }
  | { ok: false;
      cause: 'load_error' | 'tracker_error' | 'apply_error';
      detail: string;
      version?: number;
      migrationName?: string };

// ── Filename parsing ──────────────────────────────────────────

const MIGRATION_FILENAME = /^(\d{3})_([A-Za-z0-9_]+)\.sql$/;

export function parseMigrationFilename(
  filename: string
): { version: number; name: string } | undefined {
  const match = MIGRATION_FILENAME.exec(filename);
  if (!match) return undefined;
  const [, versionStr, name] = match;
  if (versionStr === undefined || name === undefined) {
    // Both groups are non-optional in MIGRATION_FILENAME; a match
    // without them is an invariant breach, not a parse miss.
    throw new Error(`parseMigrationFilename: regex matched '${filename}' without capture groups`);
  }
  return { version: parseInt(versionStr, 10), name };
}

// ── Statement splitting (pure) ────────────────────────────────
// Splits on ';' outside '...' strings, "..." identifiers, and
// '--' line comments. Doubled quotes ('' / "") flip state twice —
// correct for split purposes. Comment text stays attached to its
// statement (SQLite accepts embedded comments); segments with no
// content besides whitespace/comments are dropped.

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let hasContent = false;
  let mode: 'normal' | 'single' | 'double' | 'comment' = 'normal';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql.charAt(i);

    if (mode === 'comment') {
      current += ch;
      if (ch === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'single') {
      current += ch;
      hasContent = true;
      if (ch === "'") mode = 'normal';
      continue;
    }
    if (mode === 'double') {
      current += ch;
      hasContent = true;
      if (ch === '"') mode = 'normal';
      continue;
    }

    // mode === 'normal'
    if (ch === '-' && sql[i + 1] === '-') {
      mode = 'comment';
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (hasContent) statements.push(current.trim());
      current = '';
      hasContent = false;
      continue;
    }
    current += ch;
    if (ch === "'") { mode = 'single'; hasContent = true; continue; }
    if (ch === '"') { mode = 'double'; hasContent = true; continue; }
    if (!/\s/.test(ch)) hasContent = true;
  }

  if (hasContent) statements.push(current.trim());
  return statements;
}

// ── Directory loading ─────────────────────────────────────────
// Every *.sql file must match NNN_name.sql; other extensions are
// ignored (e.g. a README). Version gaps are allowed — ordering is
// what matters, not density. Duplicate versions are an error.

export function loadMigrationsFromDir(dir: string): MigrationLoadResult {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('loadMigrationsFromDir: dir must be a non-empty string');
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { ok: false, cause: 'dir_not_found', detail: `migrations directory not found: ${dir}` };
  }

  const parsed: { version: number; name: string; filename: string }[] = [];
  for (const filename of entries.sort()) {
    if (!filename.endsWith('.sql')) continue;
    const meta = parseMigrationFilename(filename);
    if (!meta) {
      return {
        ok: false,
        cause: 'invalid_filename',
        detail: `${filename} does not match NNN_name.sql`,
      };
    }
    parsed.push({ ...meta, filename });
  }

  const seen = new Map<number, string>();
  for (const p of parsed) {
    const existing = seen.get(p.version);
    if (existing !== undefined) {
      return {
        ok: false,
        cause: 'duplicate_version',
        detail: `version ${p.version} claimed by both ${existing} and ${p.filename}`,
      };
    }
    seen.set(p.version, p.filename);
  }

  const migrations: MigrationFile[] = [];
  for (const p of parsed.sort((a, b) => a.version - b.version)) {
    try {
      const sql = fs.readFileSync(path.join(dir, p.filename), 'utf8');
      migrations.push({ version: p.version, name: p.name, sql });
    } catch (err) {
      return {
        ok: false,
        cause: 'read_error',
        detail: `failed to read ${p.filename}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true, migrations };
}

// ── Runner ────────────────────────────────────────────────────
// Each pending migration runs inside its own transaction: all
// statements + the schema_migrations record commit together, or
// the whole migration rolls back. Already-applied versions are
// skipped (matched by version number).

const TRACKER_DDL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'version INTEGER PRIMARY KEY NOT NULL, ' +
  'name TEXT NOT NULL, ' +
  'applied_at TEXT NOT NULL)';

export async function runMigrations(
  client: SqliteClient,
  dir: string
): Promise<MigrationRunResult> {
  if (!client || typeof client.run !== 'function' ||
      typeof client.get !== 'function' || typeof client.all !== 'function') {
    throw new Error('runMigrations: client must implement SqliteClient (run/get/all)');
  }

  const load = loadMigrationsFromDir(dir);
  if (!load.ok) {
    return { ok: false, cause: 'load_error', detail: `${load.cause}: ${load.detail}` };
  }

  let appliedVersions: Set<number>;
  try {
    await client.run(TRACKER_DDL, []);
    const rows = await client.all<{ version: number }>(
      'SELECT version FROM schema_migrations', []
    );
    appliedVersions = new Set(rows.map((r) => r.version));
  } catch (err) {
    return {
      ok: false,
      cause: 'tracker_error',
      detail: `schema_migrations bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const applied: AppliedMigration[] = [];
  let skippedCount = 0;

  for (const migration of load.migrations) {
    if (appliedVersions.has(migration.version)) {
      skippedCount++;
      continue;
    }

    const statements = splitSqlStatements(migration.sql);
    try {
      await client.run('BEGIN', []);
    } catch (err) {
      return failApply(migration, `BEGIN failed: ${messageOf(err)}`);
    }

    let statementIndex = 0;
    try {
      for (; statementIndex < statements.length; statementIndex++) {
        const statement = statements[statementIndex];
        if (statement === undefined) {
          // Unreachable under the loop bound; lands in the catch
          // below → rollback + typed failure, never a silent skip.
          throw new Error(`migration statement index ${statementIndex} out of bounds`);
        }
        await client.run(statement, []);
      }
      await client.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()]
      );
      await client.run('COMMIT', []);
    } catch (err) {
      try {
        await client.run('ROLLBACK', []);
      } catch {
        // Rollback failure is unreportable beyond the original error;
        // the returned apply_error already carries the root cause.
      }
      const stage = statementIndex < statements.length
        ? `statement ${statementIndex + 1}/${statements.length}`
        : 'version recording/commit';
      return failApply(migration, `${stage} failed: ${messageOf(err)}`);
    }

    applied.push({ version: migration.version, name: migration.name });
  }

  return { ok: true, applied, skippedCount };
}

function failApply(migration: MigrationFile, detail: string): MigrationRunResult {
  return {
    ok: false,
    cause: 'apply_error',
    version: migration.version,
    migrationName: migration.name,
    detail,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
