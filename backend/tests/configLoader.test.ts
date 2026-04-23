// ============================================================
// OTM — Config Loader Tests
// CJS module. Run via: ts-node backend/tests/configLoader.test.ts
// Generic module-export reader — no coupling to prompts specifically.
// ============================================================

import { loadStringExport } from '../src/orchestration/configLoader';

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void): void {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
      failed++;
    }
  }

  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  console.log('\nConfig Loader Tests\n');

  test('loadStringExport: loads SYSTEM_PROMPT from src/config/system-prompt.v1.0', () => {
    const value = loadStringExport('src/config/system-prompt.v1.0', 'SYSTEM_PROMPT');
    assert(typeof value === 'string', 'must return a string');
    assert(value.length > 0, 'string must not be empty');
  });

  test('loadStringExport: loads MODEL_AUDIT_PROMPT from src/config/model-audit-prompt', () => {
    const value = loadStringExport('src/config/model-audit-prompt', 'MODEL_AUDIT_PROMPT');
    assert(typeof value === 'string', 'must return a string');
    assert(value.length > 0, 'string must not be empty');
  });

  test('loadStringExport: missing module throws error naming the path', () => {
    let threw = false;
    let message = '';
    try {
      loadStringExport('src/config/does-not-exist', 'ANY_NAME');
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    assert(threw, 'must throw when module path does not resolve');
    assert(
      message.includes('src/config/does-not-exist'),
      `error message must name the path — got: ${message}`,
    );
  });

  test('loadStringExport: wrong export name throws error naming both path and export name', () => {
    let threw = false;
    let message = '';
    try {
      loadStringExport('src/config/system-prompt.v1.0', 'NOT_A_REAL_EXPORT');
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    assert(threw, 'must throw when export name is missing from the module');
    assert(
      message.includes('src/config/system-prompt.v1.0'),
      `error message must name the path — got: ${message}`,
    );
    assert(
      message.includes('NOT_A_REAL_EXPORT'),
      `error message must name the expected export — got: ${message}`,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
