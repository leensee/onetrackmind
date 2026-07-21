// ============================================================
// Bench receiver — impure half: config, preflight, Fastify
// wiring, corpus writes. Deterministic logic lives in pure.ts.
//
// §10 bench-exception ruling (2026-07-21), enforced structurally:
//  - no import path from backend/ (Logger is re-declared locally)
//  - binds one specific LAN interface, never all-interfaces
//  - refuses to start without a secret — no default, no fallback
//  - never logs request bodies (§5.4 applies unchanged)
//  - corpus dir must be outside cloud-sync roots, on an
//    encrypted volume (fdesetup check)
// ============================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';

import {
  corpusPathsFor,
  insideSyncRoot,
  secretMatches,
  validateSubmission,
} from './pure';

const execFileAsync = promisify(execFile);

// ── Logger seam (house pattern, re-declared — no backend import) ──

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function createConsoleLogger(): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const suffix = fields ? ` ${JSON.stringify(fields)}` : '';
    // eslint-disable-next-line no-console — the console default IS the seam's default impl
    console[level === 'error' ? 'error' : 'log'](
      `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`,
    );
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

// ── Config + preflight ────────────────────────────────────────

interface ReceiverConfig {
  secret: string;
  bindAddr: string;
  port: number;
  corpusDir: string;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Collects every preflight failure before refusing, so one run reports
 * everything wrong with the setup. */
async function preflight(env: NodeJS.ProcessEnv, logger: Logger): Promise<ReceiverConfig> {
  const failures: string[] = [];

  const secret = env.OTM_BENCH_SECRET ?? '';
  if (secret.length === 0) {
    failures.push('OTM_BENCH_SECRET is not set — there is no default and no fallback');
  }

  const bindAddr = env.OTM_BENCH_BIND_ADDR ?? '';
  if (bindAddr.length === 0) {
    failures.push('OTM_BENCH_BIND_ADDR is not set — all-interfaces binding is not supported; pass the Mac’s LAN IP');
  } else if (bindAddr === '0.0.0.0' || bindAddr === '::' || bindAddr === '*') {
    failures.push(`OTM_BENCH_BIND_ADDR=${bindAddr} binds all interfaces — refused`);
  }

  const port = Number(env.OTM_BENCH_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failures.push(`OTM_BENCH_PORT is not a valid port`);
  }

  const corpusDir = path.resolve(expandHome(env.OTM_BENCH_CORPUS_DIR ?? '~/otm-bench/corpus'));
  const syncRoot = insideSyncRoot(corpusDir, os.homedir());
  if (syncRoot) {
    failures.push(`corpus dir sits inside a cloud-sync tree (${syncRoot}) — §10 ruling forbids this`);
  }

  // Encrypted-volume check. FileVault is the normal case; a non-FileVault
  // encrypted volume needs the explicit override, which asserts encryption.
  try {
    const { stdout } = await execFileAsync('fdesetup', ['status']);
    if (!stdout.includes('FileVault is On')) {
      if (env.OTM_BENCH_ALLOW_UNVERIFIED_ENCRYPTION === '1') {
        logger.warn('FileVault is OFF; override set — operator asserts the corpus volume is otherwise encrypted');
      } else {
        failures.push('FileVault is not On (fdesetup status) — set OTM_BENCH_ALLOW_UNVERIFIED_ENCRYPTION=1 only if the corpus volume is otherwise encrypted');
      }
    }
  } catch (error) {
    if (env.OTM_BENCH_ALLOW_UNVERIFIED_ENCRYPTION === '1') {
      logger.warn('fdesetup unavailable; override set — operator asserts the corpus volume is encrypted');
    } else {
      failures.push(`could not verify volume encryption (fdesetup failed: ${(error as Error).message})`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) logger.error(`preflight: ${failure}`);
    throw new Error(`preflight failed (${failures.length} problem(s)) — refusing to start`);
  }
  return { secret, bindAddr, port, corpusDir };
}

// ── Server ────────────────────────────────────────────────────

export function buildServer(config: ReceiverConfig, logger: Logger) {
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });

  // Map framework-level errors (JSON parse, body too large) onto the
  // submission contract without leaking request contents.
  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const code = typeof err.code === 'string' ? err.code : undefined;
    if (statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        ok: false,
        reason: 'invalid_input',
        detail: code ?? 'malformed request',
        retryable: false,
      });
      return;
    }
    logger.error('unhandled server error', {
      code,
      message: typeof err.message === 'string' ? err.message : String(error),
    });
    reply.status(500).send({
      ok: false,
      reason: 'storage_error',
      detail: 'internal error',
      retryable: true,
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'otm-bench-receiver' }));

  app.post('/v1/captures', async (request, reply) => {
    const provided = request.headers['x-otm-bench-secret'];
    const providedValue = Array.isArray(provided) ? provided[0] : provided;
    if (!secretMatches(providedValue, config.secret)) {
      logger.warn('auth failed', { remote: request.ip });
      return reply.status(401).send({
        ok: false,
        reason: 'auth_failed',
        detail: 'invalid or missing bench secret',
        retryable: false,
      });
    }

    const validated = validateSubmission(request.body);
    if (!validated.ok) {
      logger.warn('invalid submission', { remote: request.ip, detail: validated.detail });
      return reply.status(400).send(validated);
    }

    const { entry, payload } = validated.value;
    const paths = corpusPathsFor(config.corpusDir, entry);
    const receivedAt = new Date().toISOString();

    try {
      // Idempotent on entry id: a re-submit after a lost confirm succeeds
      // with duplicate=true so the device queue never wedges.
      let duplicate = false;
      try {
        await fs.access(paths.jsonPath);
        duplicate = true;
      } catch {
        duplicate = false;
      }

      let bytesStored: number;
      if (duplicate) {
        bytesStored = await fs
          .stat(paths.dataPath)
          .then((s) => s.size)
          .catch(() => 0);
      } else {
        await fs.mkdir(paths.dir, { recursive: true });
        const data =
          payload.kind === 'audio'
            ? Buffer.from(payload.audioBase64, 'base64')
            : Buffer.from(payload.text, 'utf8');
        bytesStored = data.byteLength;
        await fs.writeFile(paths.dataPath, data);
        await fs.writeFile(
          paths.jsonPath,
          JSON.stringify({ received_at: receivedAt, entry }, null, 2),
        );
      }

      // Log identifiers and sizes only — never bodies (§5.4).
      logger.info('capture stored', {
        entryId: entry.id,
        sessionId: entry.session_id,
        armLabel: entry.arm_label,
        kind: entry.payload_kind,
        bytesStored,
        duplicate,
      });
      return reply.status(200).send({
        ok: true,
        value: { entryId: entry.id, bytesStored, duplicate, receivedAt },
      });
    } catch (error) {
      logger.error('corpus write failed', {
        entryId: entry.id,
        message: (error as Error).message,
      });
      return reply.status(500).send({
        ok: false,
        reason: 'storage_error',
        detail: 'corpus write failed',
        retryable: true,
      });
    }
  });

  return app;
}

async function main(): Promise<void> {
  const logger = createConsoleLogger();
  const config = await preflight(process.env, logger);
  await fs.mkdir(config.corpusDir, { recursive: true });
  const app = buildServer(config, logger);
  await app.listen({ host: config.bindAddr, port: config.port });
  logger.info('bench receiver up', {
    bind: `${config.bindAddr}:${config.port}`,
    corpusDir: config.corpusDir,
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Preflight failures land here; the per-problem lines are already logged.
    console.error((error as Error).message);
    process.exit(1);
  });
}
