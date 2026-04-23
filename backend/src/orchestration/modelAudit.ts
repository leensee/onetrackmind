// ============================================================
// OTM Orchestration — Model Audit (Layer 2)
// Second Sonnet 4.6 call. Evaluates the primary response for
// reasoning quality, inference accuracy, safety completeness,
// tone, and evidence sourcing. Returns structured JSON the
// orchestrator branches on deterministically.
// Non-streaming — response is small JSON (max 500 tokens).
// Anthropic client is injected — never constructed here.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  ModelAuditInput,
  ModelAuditResult,
  AuditResult,
  ProcessedEvent,
  ContextualData,
  PreflightResult,
} from './types';
import { sanitizeErrorMessage } from './primaryCall';
import {
  formatActiveFlags,
  formatOpenItems,
  formatConsistContext,
} from './formatters';
import { loadStringExport } from './configLoader';

// ── Constants ─────────────────────────────────────────────────

export const MODEL_AUDIT_MODEL       = 'claude-sonnet-4-6';
export const MODEL_AUDIT_MAX_TOKENS  = 500;
export const MODEL_AUDIT_TEMPERATURE = 0;    // compliance check — deterministic
export const MODEL_AUDIT_TIMEOUT_MS  = 30_000;

// ── Model Audit Error ─────────────────────────────────────────

export class ModelAuditError extends Error {
  public readonly sessionId: string;
  public readonly requestId: string;
  public readonly cause:     'timeout' | 'api_error' | 'invalid_json' | 'config_error';

  constructor(
    message:   string,
    sessionId: string,
    requestId: string,
    cause:     'timeout' | 'api_error' | 'invalid_json' | 'config_error'
  ) {
    super(message);
    this.name      = 'ModelAuditError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = cause;
  }
}

// ── Audit Threshold ───────────────────────────────────────────
// Returns true (run audit) unless ALL three skip conditions hold.
// Conservative — defaults to running audit on any ambiguity.
//
// Skip conditions (all must be true to skip):
//   Condition 3 — event is a direct user message (not inbound comms)
//   Condition 4 — pre-flight passed (no hold or flag severity issues)
//   Condition 5 — no active unacknowledged safety flags in context
//
// Conditions 1 and 2 from the original threshold (single verified
// source, direct retrieval) are not evaluable without inspecting
// response content — omitted by design. Conservative default applies.

export function shouldRunModelAudit(
  event:          ProcessedEvent,
  contextualData: ContextualData,
  preflightResult: PreflightResult
): boolean {
  const condition3 = event.eventType === 'user_message';
  const condition4 = preflightResult.pass;
  const condition5 = !contextualData.activeFlags.some(
    f => f.type === 'safety' && !f.acknowledged
  );
  // All three must hold to skip
  return !(condition3 && condition4 && condition5);
}

// ── Audit Prompt Builder ──────────────────────────────────────
// Pure function — exported for testing.
// Produces the user-turn content for the audit API call.

export function buildAuditPrompt(input: ModelAuditInput): string {
  const { responseText, event, contextualData, preflightFlags } = input;

  const channel = event.metadata.channel ?? 'unknown';

  // Safety-only filter is audit-prompt business logic, not shared formatting.
  const unackSafetyFlags = contextualData.activeFlags.filter(
    f => f.type === 'safety' && !f.acknowledged,
  );
  const activeSafetyFlags = formatActiveFlags(unackSafetyFlags);

  const preflightSummary = preflightFlags.length === 0
    ? 'none'
    : preflightFlags.map(f => `- [${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`).join('\n');

  const consistSummary = formatConsistContext(contextualData.consistContext) || 'none';
  const openItemsSummary = formatOpenItems(contextualData.openItems) || 'none';

  return [
    `EVENT TYPE: ${event.eventType}`,
    `CHANNEL: ${channel}`,
    '',
    `ACTIVE SAFETY FLAGS:`,
    activeSafetyFlags || 'none',
    '',
    `PRE-FLIGHT FINDINGS:`,
    preflightSummary,
    '',
    `VERIFIED CONTEXT (what the assistant had access to):`,
    `Consist machines:\n${consistSummary}`,
    `Open items:\n${openItemsSummary}`,
    `Event content: ${event.rawContent}`,
    '',
    `RESPONSE TO AUDIT:`,
    responseText,
  ].join('\n');
}

// ── Audit Response Parser ─────────────────────────────────────
// Pure function — exported for testing.
// Strips markdown fences defensively, parses JSON, validates schema.
// Throws plain Error on failure — caller wraps into ModelAuditError.

export function parseAuditResponse(raw: string): ModelAuditResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Invalid JSON in audit response: "${cleaned.substring(0, 120)}"`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Audit response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const validResults: AuditResult[] = ['pass', 'flag', 'revise'];

  if (!validResults.includes(obj['result'] as AuditResult)) {
    throw new Error(
      `Audit response "result" must be pass|flag|revise, got: "${String(obj['result'])}"`
    );
  }

  const result = obj['result'] as AuditResult;

  // Enforce that non-pass results carry actionable issue and correction fields.
  // A revise or flag with no correction leaves the orchestrator with nothing to act on.
  if (result !== 'pass') {
    if (typeof obj['issue'] !== 'string' || obj['issue'].length === 0) {
      throw new Error(
        `Audit result "${result}" must include a non-empty "issue" field`
      );
    }
    if (typeof obj['correction'] !== 'string' || obj['correction'].length === 0) {
      throw new Error(
        `Audit result "${result}" must include a non-empty "correction" field`
      );
    }
  }

  const auditResult: ModelAuditResult = { result };

  if (typeof obj['issue'] === 'string' && obj['issue'].length > 0) {
    auditResult.issue = obj['issue'];
  }
  if (typeof obj['correction'] === 'string' && obj['correction'].length > 0) {
    auditResult.correction = obj['correction'];
  }

  return auditResult;
}

// ── Main Model Audit ──────────────────────────────────────────
// timeoutMs is injectable for testing — defaults to MODEL_AUDIT_TIMEOUT_MS.

export async function runModelAudit(
  input:                ModelAuditInput,
  client:               Anthropic,
  modelAuditPromptPath: string,
  timeoutMs:            number = MODEL_AUDIT_TIMEOUT_MS
): Promise<ModelAuditResult> {
  const { sessionId, requestId } = input;
  const startMs = Date.now();

  console.info(
    `[ModelAudit] start requestId=${requestId} sessionId=${sessionId} model=${MODEL_AUDIT_MODEL}`
  );

  const userPrompt  = buildAuditPrompt(input);

  let auditPrompt: string;
  try {
    auditPrompt = loadStringExport(modelAuditPromptPath, 'MODEL_AUDIT_PROMPT');
  } catch (configErr) {
    const error = configErr as Error;
    console.error(
      `[ModelAudit] error requestId=${requestId} sessionId=${sessionId} ` +
      `cause=config_error message=${sanitizeErrorMessage(error.message)}`
    );
    throw new ModelAuditError(
      `Config error: ${error.message}`,
      sessionId,
      requestId,
      'config_error'
    );
  }

  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ModelAuditError(
        `Model audit timed out after ${timeoutMs}ms`,
        sessionId,
        requestId,
        'timeout'
      ));
    }, timeoutMs);
  });

  try {
    const apiCallPromise = client.messages.create({
      model:       MODEL_AUDIT_MODEL,
      max_tokens:  MODEL_AUDIT_MAX_TOKENS,
      temperature: MODEL_AUDIT_TEMPERATURE,
      system:      auditPrompt,
      messages:    [{ role: 'user', content: userPrompt }],
    });

    const response = await Promise.race([apiCallPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    // Extract text content from response
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new ModelAuditError(
        'Audit response contained no text block',
        sessionId,
        requestId,
        'invalid_json'
      );
    }

    let auditResult: ModelAuditResult;
    try {
      auditResult = parseAuditResponse(textBlock.text);
    } catch (parseErr) {
      throw new ModelAuditError(
        (parseErr as Error).message,
        sessionId,
        requestId,
        'invalid_json'
      );
    }

    const durationMs = Date.now() - startMs;
    console.info(
      `[ModelAudit] complete requestId=${requestId} sessionId=${sessionId} ` +
      `result=${auditResult.result} durationMs=${durationMs}`
    );

    return auditResult;

  } catch (err) {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (err instanceof ModelAuditError) throw err;

    const error = err as Error;
    console.error(
      `[ModelAudit] error requestId=${requestId} sessionId=${sessionId} ` +
      `cause=api_error message=${sanitizeErrorMessage(error.message)}`
    );

    throw new ModelAuditError(
      `API error: ${error.message}`,
      sessionId,
      requestId,
      'api_error'
    );
  }
}
