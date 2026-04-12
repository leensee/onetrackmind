// ============================================================
// OTM Orchestration — Primary Claude Call
// Streams a response from the Claude API and accumulates the
// full text before returning. No partial output leaves this
// module — both audit layers run on the complete response.
// Anthropic client is injected — never constructed here.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { PrimaryCallInput, PrimaryCallOutput } from './types';

// ── Constants ─────────────────────────────────────────────────
// Named constants — single-line change points for Phase 8 tuning.

export const PRIMARY_CALL_MODEL       = 'claude-sonnet-4-6';
export const PRIMARY_CALL_MAX_TOKENS  = 4_000;
export const PRIMARY_CALL_TEMPERATURE = 0.7;  // Phase 8 gate: test 0.5–1.0 for field calibration
export const PRIMARY_CALL_TIMEOUT_MS  = 30_000;

// ── Stream Handle Interface ───────────────────────────────────
// Structural interface for the SDK stream object.
// Isolates this module from SDK internal type changes.

interface StreamHandle {
  on(event: 'text', cb: (text: string) => void): this;
  finalMessage(): Promise<{
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  }>;
  abort(): void;
}

// ── Primary Call Error ────────────────────────────────────────
// Domain-specific error. Always propagated — never swallowed.
// Carries session/request IDs and structured cause for orchestrator routing.

export class PrimaryCallError extends Error {
  public readonly sessionId: string;
  public readonly requestId: string;
  public readonly cause:     'timeout' | 'api_error' | 'empty_response';

  constructor(
    message:   string,
    sessionId: string,
    requestId: string,
    cause:     'timeout' | 'api_error' | 'empty_response'
  ) {
    super(message);
    this.name      = 'PrimaryCallError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = cause;
  }
}

// ── Error Message Sanitizer ──────────────────────────────────
// Strips patterns that could carry sensitive data from SDK error
// messages before they reach logs. Targets Bearer tokens, API key
// patterns, and multiline payloads. First line only, capped at 200
// characters. Pure function — exported for isolated unit testing.

export function sanitizeErrorMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  const stripped = firstLine
    .replace(/Bearer\s+[\w\-._~+/]+=*/gi, '[REDACTED_TOKEN]')
    .replace(/sk-[\w\-]{10,}/gi, '[REDACTED_KEY]')
    .replace(/authorization["']?\s*:\s*["']?[\w\s\-._~+/]+=*/gi, '[REDACTED_AUTH]');
  return stripped.slice(0, 200);
}

// ── Delta Accumulator ─────────────────────────────────────────
// Pure function — exported for isolated unit testing.
// Joins all text deltas from the stream into a single string.

export function accumulateDeltas(deltas: string[]): string {
  return deltas.join('');
}

// ── Primary Call ──────────────────────────────────────────────
// timeoutMs is injectable for testing — defaults to PRIMARY_CALL_TIMEOUT_MS.
// Production callers omit it.

export async function primaryCall(
  input:     PrimaryCallInput,
  client:    Anthropic,
  timeoutMs: number = PRIMARY_CALL_TIMEOUT_MS
): Promise<PrimaryCallOutput> {
  const { assemblerOutput, sessionId, requestId } = input;
  const startMs = Date.now();

  console.info(
    `[PrimaryCall] start requestId=${requestId} sessionId=${sessionId} ` +
    `model=${PRIMARY_CALL_MODEL} estimatedInputTokens=${assemblerOutput.tokenEstimate}`
  );

  // Stream handle declared outside try so the timeout closure can abort it
  let stream: StreamHandle | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      // Abort the in-flight stream on timeout
      if (stream !== null) stream.abort();
      reject(new PrimaryCallError(
        `Request timed out after ${timeoutMs}ms`,
        sessionId,
        requestId,
        'timeout'
      ));
    }, timeoutMs);
  });

  try {
    stream = client.messages.stream({
      model:       PRIMARY_CALL_MODEL,
      max_tokens:  PRIMARY_CALL_MAX_TOKENS,
      temperature: PRIMARY_CALL_TEMPERATURE,
      system:      assemblerOutput.systemPrompt,
      messages:    assemblerOutput.messages.map(m => ({
        role:    m.role,
        content: m.content,
      })),
    }) as unknown as StreamHandle;

    // Accumulate text deltas as they arrive
    const buffer: string[] = [];
    stream.on('text', (text: string) => {
      buffer.push(text);
    });

    // Race: stream completion vs timeout
    // If timeout wins: timeoutPromise rejects, we fall to catch
    // If stream wins: we have the final message with usage metadata
    const finalMessage = await Promise.race([
      stream.finalMessage(),
      timeoutPromise,
    ]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    const responseText = accumulateDeltas(buffer);

    if (!responseText.trim()) {
      throw new PrimaryCallError(
        'Model returned an empty response',
        sessionId,
        requestId,
        'empty_response'
      );
    }

    const durationMs = Date.now() - startMs;

    console.info(
      `[PrimaryCall] complete requestId=${requestId} sessionId=${sessionId} ` +
      `durationMs=${durationMs} inputTokens=${finalMessage.usage.input_tokens} ` +
      `outputTokens=${finalMessage.usage.output_tokens}`
    );

    return {
      responseText,
      inputTokens:  finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
      durationMs,
      model:        finalMessage.model,
    };

  } catch (err) {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    // Re-throw domain errors without wrapping
    if (err instanceof PrimaryCallError) throw err;

    const error = err as Error;
    console.error(
      `[PrimaryCall] error requestId=${requestId} sessionId=${sessionId} ` +
      `cause=api_error message=${sanitizeErrorMessage(error.message)}`
    );

    throw new PrimaryCallError(
      `API error: ${error.message}`,
      sessionId,
      requestId,
      'api_error'
    );
  }
}
