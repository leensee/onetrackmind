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

// ── Constants ─────────────────────────────────────────────────

export const MODEL_AUDIT_MODEL       = 'claude-sonnet-4-6';
export const MODEL_AUDIT_MAX_TOKENS  = 500;
export const MODEL_AUDIT_TEMPERATURE = 0;    // compliance check — deterministic
export const MODEL_AUDIT_TIMEOUT_MS  = 30_000;

// ── Audit System Prompt ───────────────────────────────────────
// Exported for transparency and testing.

export const MODEL_AUDIT_SYSTEM_PROMPT = `You are a compliance auditor for an AI assistant used in railroad maintenance field operations. Evaluate AI responses against strict operational and safety standards.

Respond ONLY with valid JSON. No markdown fences. No preamble. No explanation outside the JSON object.

Required schema:
{"result": "pass" | "flag" | "revise", "issue": null | string, "correction": null | string}

Definitions:
- pass: Response meets all criteria. Set issue and correction to null.
- flag: Response has a non-blocking issue that must be disclosed to the user. Set issue to what is wrong. Set correction to the specific accurate data point or framing fix.
- revise: Response must be rewritten. Set issue to what is wrong. Set correction to the specific fact, framing, or data point the rewrite must incorporate. Do NOT write the full revised response — correction is a targeted fix instruction only.

Evaluate against these criteria:
1. EVIDENCE: Every field-specific claim (part numbers, specs, costs, serial numbers, schedules, compliance figures, contact details) must trace to the event content or injected verified context. Training-data recall presented as specific operational fact is a revise.
2. SAFETY: If active safety flags are present in context, the response must address them. Safety language must be direct and unambiguous. Softened or absent safety content is a flag or revise depending on severity.
3. INFERENCE: Any estimate, inference, or uncertain claim must be explicitly labeled as such. Unlabeled inference presented as fact is a revise.
4. TONE: Response must match the correct register for the channel and recipient (direct peer vs. upward reporting vs. vendor). Significant mismatch is a flag.
5. APPROVAL GATE: If the response contains an outbound draft (email, SMS), a visible approval gate must be present. Absent gate is a revise.
6. NO FILLER: No padding, restatement of the question, or content not sourced from real verified data. Filler is a flag.`;

// ── Model Audit Error ─────────────────────────────────────────

export class ModelAuditError extends Error {
  public readonly sessionId: string;
  public readonly requestId: string;
  public readonly cause:     'timeout' | 'api_error' | 'invalid_json';

  constructor(
    message:   string,
    sessionId: string,
    requestId: string,
    cause:     'timeout' | 'api_error' | 'invalid_json'
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

  const activeSafetyFlags = contextualData.activeFlags
    .filter(f => f.type === 'safety' && !f.acknowledged)
    .map(f => `- ${f.content}`)
    .join('\n');

  const preflightSummary = preflightFlags.length === 0
    ? 'none'
    : preflightFlags.map(f => `- [${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`).join('\n');

  const consistSummary = contextualData.consistContext
    ? contextualData.consistContext.relevantMachines
        .map(m => `  Pos ${m.position}: ${m.name}${m.serialNumber ? ` (SN: ${m.serialNumber})` : ''}`)
        .join('\n')
    : 'none';

  const openItemsSummary = contextualData.openItems.length === 0
    ? 'none'
    : contextualData.openItems.map(i => `  [${i.category}] ${i.content}`).join('\n');

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
  input:     ModelAuditInput,
  client:    Anthropic,
  timeoutMs: number = MODEL_AUDIT_TIMEOUT_MS
): Promise<ModelAuditResult> {
  const { sessionId, requestId } = input;
  const startMs = Date.now();

  console.info(
    `[ModelAudit] start requestId=${requestId} sessionId=${sessionId} model=${MODEL_AUDIT_MODEL}`
  );

  const userPrompt = buildAuditPrompt(input);

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
      system:      MODEL_AUDIT_SYSTEM_PROMPT,
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
