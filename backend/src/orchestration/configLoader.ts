// ============================================================
// OTM Orchestration — Config Loader
// Generic module-export reader. Reads a named string export
// from a config module at a given path. Deterministic; does
// not mutate caller state. Callers supply both the path and
// the export name — this helper has no knowledge of what the
// string represents (prompt, template, copy, anything).
// ============================================================

import path from 'path';

// Two levels up from src/orchestration/ → backend/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export function loadStringExport(configPath: string, exportName: string): string {
  let mod: unknown;
  try {
    const resolvedPath = path.resolve(PROJECT_ROOT, configPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(resolvedPath);
  } catch (err) {
    throw new Error(
      `Failed to load config module at '${configPath}': ${(err as Error).message}`
    );
  }

  if (typeof mod !== 'object' || mod === null) {
    throw new Error(
      `Config module at '${configPath}' did not export an object.`
    );
  }

  const value = (mod as Record<string, unknown>)[exportName];
  if (typeof value !== 'string') {
    throw new Error(
      `Config module at '${configPath}' must export a string '${exportName}'.`
    );
  }

  return value;
}
