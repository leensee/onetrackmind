// ============================================================
// OTM Observability — Injected Logger Seam
// Small DI'd surface for general observability logging, adopted
// by every new Phase 4+ module (Decisions Log 2026-07-09).
// Orthogonal to diagnosticLogger: that module is the domain-event
// sink (structured, severity-typed, retained rows to
// diagnostic_log); this seam carries ordinary field observability.
// A module may hold both.
//
// Default impl is console-backed — no new dependency. Console
// writes are the ONLY side effect and live solely inside
// createConsoleLogger (Standing Principles §03); the formatting
// helpers are pure and exported for isolated testing.
//
// Logging must never break the caller: formatting never throws
// (unserializable fields degrade to a marker) and sink failures
// are swallowed.
// ============================================================

// ── Interface ─────────────────────────────────────────────────

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// ── Pure Formatting ───────────────────────────────────────────
// Output style matches the existing console convention:
//   [Namespace] message key=value key=value

// Renders a single field value. Strings pass through with line
// breaks escaped — field values often carry attacker-controlled
// text (message bodies, subjects) and a raw newline would let one
// forge a convincing "[Namespace] ..." log line. Other primitives
// verbatim; everything else canonical JSON (which escapes its own
// newlines); JSON failures (circular refs) degrade to a marker.
// Never throws.
export function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  try {
    // stringify returns undefined for functions/symbols — degrade via String.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

export function formatLogLine(namespace: string, message: string, fields?: LogFields): string {
  const parts = [`[${namespace}] ${message}`];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${formatFieldValue(value)}`);
    }
  }
  return parts.join(' ');
}

// ── Default Implementations ───────────────────────────────────

// Narrow sink interface so tests capture output by injection —
// no console monkey-patching. Defaults to the global console.
export interface ConsoleSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createConsoleLogger(namespace: string, sink: ConsoleSink = console): Logger {
  const emit = (level: keyof ConsoleSink, message: string, fields?: LogFields): void => {
    try {
      sink[level](formatLogLine(namespace, message, fields));
    } catch {
      // Logging must never break the caller.
    }
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

// Silent logger — the default injection for tests and for callers
// that deliberately discard observability output.
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
