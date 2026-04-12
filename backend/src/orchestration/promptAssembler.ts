// ============================================================
// OTM Orchestration — Prompt Assembler
// CJS module (commonjs) — no import.meta.url, no .js extensions.
// Edition-agnostic. All edition-specific behavior injected
// via AssemblerInput. No OTM v1 assumptions hardcoded here.
// ============================================================

import path from 'path';
import {
  AssemblerInput,
  AssemblerOutput,
  Message,
  ContextWindowConfig,
} from './types';
import { estimateTokens, estimateMessagesTokens } from './tokenUtils';

// __dirname is available natively in CJS — no computation required.
// Two levels up from src/orchestration/ → backend/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_TOTAL_TOKENS       = 200_000;
const DEFAULT_RESPONSE_RESERVE   = 4_000;
const DEFAULT_DYNAMIC_INJECT_CAP = 350;  // style profile + session context

// ── Style Profile Injection Block ────────────────────────────
// Injected as a labeled block so the model treats it as a
// distinct injection layer, separate from behavioral directives.

function buildStyleBlock(styleProfile: string): string {
  if (!styleProfile.trim()) return '';
  return `\n\n---\n\n[STYLE PROFILE — injected at session open]\n${styleProfile.trim()}`;
}

// ── Session Context Injection Block ──────────────────────────
// Context has already been pre-filtered by the context loader.
// Assembler does not make relevance judgments — it assembles.

function buildContextBlock(input: AssemblerInput): string {
  const { contextualData } = input;
  const lines: string[] = [];

  if (contextualData.activeFlags.length > 0) {
    lines.push('ACTIVE FLAGS:');
    for (const flag of contextualData.activeFlags) {
      lines.push(`  [${flag.type.toUpperCase()}] ${flag.content}`);
    }
  }

  if (contextualData.openItems.length > 0) {
    lines.push('OPEN ITEMS:');
    for (const item of contextualData.openItems) {
      const pushLabel = item.isPush ? ' [PUSH]' : '';
      lines.push(`  [${item.category}${pushLabel}] ${item.content}`);
    }
  }

  if (contextualData.consistContext) {
    const { consistId, relevantMachines } = contextualData.consistContext;
    lines.push(`CONSIST CONTEXT (${consistId}):`);
    for (const machine of relevantMachines) {
      const serial = machine.serialNumber ? ` — SN: ${machine.serialNumber}` : '';
      lines.push(`  Pos ${machine.position}: ${machine.name}${serial}`);
    }
  }

  if (lines.length === 0) return '';
  return `\n\n---\n\n[SESSION CONTEXT — pre-filtered for current input]\n${lines.join('\n')}`;
}

// ── History Trimmer ──────────────────────────────────────────
// Drops oldest turns first. Always surfaces trim count — never silent.
// Current input is never passed here — never at risk of trim.

interface TrimResult {
  trimmedHistory: Message[];
  turnsTrimmed: number;
}

function trimHistory(history: Message[], budgetTokens: number): TrimResult {
  if (history.length === 0) return { trimmedHistory: [], turnsTrimmed: 0 };

  const working = [...history];
  let turnsTrimmed = 0;

  while (working.length > 0 && estimateMessagesTokens(working) > budgetTokens) {
    working.shift();
    turnsTrimmed++;
  }

  return { trimmedHistory: working, turnsTrimmed };
}

// ── System Prompt Loader ─────────────────────────────────────
// Synchronous in CJS. configPath is relative to PROJECT_ROOT.
// ts-node resolves .ts at dev time; Node resolves compiled .js at runtime.
// Do not pass a file extension — resolution is handled automatically.

function loadSystemPrompt(configPath: string): string {
  try {
    const resolvedPath = path.resolve(PROJECT_ROOT, configPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(resolvedPath) as unknown;

    if (
      typeof mod !== 'object' ||
      mod === null ||
      typeof (mod as Record<string, unknown>)['SYSTEM_PROMPT'] !== 'string'
    ) {
      throw new Error(
        `System prompt module at '${configPath}' must export a SYSTEM_PROMPT string.`
      );
    }

    return (mod as { SYSTEM_PROMPT: string }).SYSTEM_PROMPT;
  } catch (err) {
    throw new Error(
      `Failed to load system prompt from '${configPath}': ${(err as Error).message}`
    );
  }
}

// ── Main Assembler ───────────────────────────────────────────

export async function assemblePrompt(input: AssemblerInput): Promise<AssemblerOutput> {
  const { editionConfig, styleProfile, conversationHistory, currentInput, contextualData } = input;

  // ── 1. Resolve token budget ────────────────────────────────
  const windowCfg: ContextWindowConfig = editionConfig.contextWindowConfig ?? {};
  const totalTokens     = windowCfg.totalTokens        ?? DEFAULT_TOTAL_TOKENS;
  const responseReserve = windowCfg.responseReserve    ?? DEFAULT_RESPONSE_RESERVE;
  const dynamicCap      = windowCfg.dynamicInjectionCap ?? DEFAULT_DYNAMIC_INJECT_CAP;

  // ── 2. Load static system prompt ──────────────────────────
  const staticPrompt = loadSystemPrompt(editionConfig.systemPromptPath);
  const staticTokens = estimateTokens(staticPrompt);

  // ── 3. Build dynamic injection blocks ─────────────────────
  const styleBlock       = buildStyleBlock(styleProfile);
  const contextBlock     = buildContextBlock({ ...input, contextualData });
  const dynamicInjection = styleBlock + contextBlock;
  const dynamicTokens    = estimateTokens(dynamicInjection);

  // Unconditional metric — surfaces context loader drift over time.
  console.info(
    `[PromptAssembler] Dynamic injection: ${dynamicTokens} tokens (cap: ${dynamicCap}).`
  );

  // Warn if dynamic injection exceeds soft cap — non-fatal.
  // Surfaces for context loader tuning.
  if (dynamicTokens > dynamicCap) {
    console.warn(
      `[PromptAssembler] Dynamic injection ${dynamicTokens} tokens exceeds ` +
      `soft cap ${dynamicCap}. Consider tightening context loader filtering.`
    );
  }

  // ── 4. Assemble full system prompt ────────────────────────
  const fullSystemPrompt = staticPrompt + dynamicInjection;

  // ── 5. Resolve history budget and trim if needed ──────────
  const currentInputTokens = estimateTokens(currentInput.rawContent) + 4;
  const historyBudget =
    totalTokens - responseReserve - staticTokens - dynamicTokens - currentInputTokens;

  const { trimmedHistory, turnsTrimmed } = trimHistory(conversationHistory, historyBudget);

  if (turnsTrimmed > 0) {
    // Orchestrator uses historyTrimmed + historyTurnsTrimmed to write session log entry.
    // Assembler surfaces the signal — logging is the orchestrator's responsibility.
    console.warn(
      `[PromptAssembler] Trimmed ${turnsTrimmed} conversation turn(s) to fit context window.`
    );
  }

  // ── 6. Build messages array ───────────────────────────────
  // Anthropic API format: history turns + current input as final user message.
  const messages: Message[] = [
    ...trimmedHistory,
    {
      role: 'user',
      content: currentInput.rawContent,
      timestamp: currentInput.timestamp,
    },
  ];

  // ── 7. Compute token estimate and window usage ────────────
  const totalUsed = staticTokens + dynamicTokens + estimateMessagesTokens(messages);
  const contextWindowUsedPct = Math.round((totalUsed / totalTokens) * 100);

  return {
    systemPrompt:        fullSystemPrompt,
    messages,
    tokenEstimate:       totalUsed,
    contextWindowUsedPct,
    historyTrimmed:      turnsTrimmed > 0,
    historyTurnsTrimmed: turnsTrimmed,
  };
}
