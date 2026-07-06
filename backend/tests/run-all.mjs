// Consolidated test runner.
//
// Discovers every `tests/*.test.ts` and runs each in its own ts-node process.
// Unlike the previous `&&` chain, this runs ALL files even when some fail, then
// prints an aggregate summary and exits non-zero if any file failed — so one
// early failure no longer hides the rest. New test files are picked up
// automatically; there is no per-test script list to keep in sync.
//
// Each test file remains a standalone process with its own harness
// (test()/assert(), process.exit(1) on failure), unchanged.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testsDir, '..');

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('run-all: no *.test.ts files found in', testsDir);
  process.exit(1);
}

// Make the local ts-node binary resolvable even when invoked directly as
// `node tests/run-all.mjs` (npm already prepends node_modules/.bin under scripts).
const binDir = join(projectRoot, 'node_modules', '.bin');
const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };

const failed = [];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const res = spawnSync(
    'ts-node',
    ['--project', 'tsconfig.test.json', join('tests', file)],
    { cwd: projectRoot, env, stdio: 'inherit' },
  );
  if (res.error) {
    failed.push(file);
    console.error(`run-all: failed to launch ${file}: ${res.error.message}`);
  } else if (res.status !== 0) {
    failed.push(file);
  }
}

const total = files.length;
console.log('\n──────────────────────────────────────────');
console.log(`run-all: ${total - failed.length}/${total} test files passed`);
if (failed.length > 0) {
  console.log(`run-all: FAILED — ${failed.join(', ')}`);
  process.exit(1);
}
console.log('run-all: all test files passed');
