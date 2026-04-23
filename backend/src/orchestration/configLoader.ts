// ============================================================
// OTM Orchestration — Config Loader
// Generic module-export reader. Reads a named string export
// from a config module at a given path. Deterministic; does
// not mutate caller state. Callers supply both the path and
// the export name — this helper has no knowledge of what the
// string represents (prompt, template, copy, anything).
// ============================================================

import fs from 'fs';
import path from 'path';

// Two levels up from src/orchestration/ → backend/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DIST_PREFIX = `dist${path.sep}`;
const SRC_PREFIX = `src${path.sep}`;
const IS_RUNNING_FROM_DIST = path.relative(PROJECT_ROOT, __dirname).startsWith(DIST_PREFIX);

function getCandidateModulePaths(configPath: string): string[] {
  const resolvedPath = path.resolve(PROJECT_ROOT, configPath);
  const candidates = [resolvedPath];

  if (IS_RUNNING_FROM_DIST) {
    const normalizedConfigPath = configPath.split(/[\\/]+/).join(path.sep);

    if (normalizedConfigPath === 'src' || normalizedConfigPath.startsWith(SRC_PREFIX)) {
      const distRelativePath =
        normalizedConfigPath === 'src'
          ? 'dist'
          : `dist${path.sep}${normalizedConfigPath.slice(SRC_PREFIX.length)}`;

      let distResolvedPath = path.resolve(PROJECT_ROOT, distRelativePath);
      if (path.extname(distResolvedPath) === '.ts') {
        distResolvedPath = distResolvedPath.slice(0, -3) + '.js';
      }

      if (distResolvedPath !== resolvedPath && fs.existsSync(distResolvedPath)) {
        candidates.push(distResolvedPath);
      }
    }
  }

  return candidates;
}

function requireConfigModule(configPath: string): unknown {
  const candidatePaths = getCandidateModulePaths(configPath);
  let lastError: Error | undefined;

  for (const candidatePath of candidatePaths) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(candidatePath);
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw new Error(
    `Failed to load config module at '${configPath}': ${lastError?.message ?? 'Unknown error'}`
  );
}

export function loadStringExport(configPath: string, exportName: string): string {
  const mod = requireConfigModule(configPath);
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
