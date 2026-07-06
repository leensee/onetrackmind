// ============================================================
// OTM Orchestration — Deterministic Pre-Flight Audit
// Layer 1 of the dual-layer audit system.
// Pure, synchronous, no DB access, no external calls.
// Checks response text against contextual data and event.
// Conservative by design — flags only on clear evidence.
// Ambiguous cases pass through to the model audit (Layer 2).
// ============================================================

import { PreflightInput, PreflightResult, PreflightFlag } from './types';
import { SMS_MARKDOWN_PATTERNS } from './formatters';

// ── Rule 1: Autonomous Action Detected ───────────────────────
// Severity: hold
// Skipped when postApproval === true OR actionWasInvoked === true.
// Defense-in-depth text heuristic: only runs when the orchestrator
// state signal says no action actually fired this turn. Catches
// past-tense action language that would indicate a hallucinated
// claim of action. Ground truth lives in actionWasInvoked.

const AUTONOMOUS_PATTERNS: string[] = [
  "i've sent",
  "i've ordered",
  "i've created",
  "i've submitted",
  "i've placed",
  "i've filed",
  "order placed",
  "message sent",
  "email sent",
  "submitted to",
];

function checkAutonomousAction(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  const lower = input.responseText.toLowerCase();
  const matched = AUTONOMOUS_PATTERNS.find(p => lower.includes(p));
  if (matched) {
    flags.push({
      rule:     'AUTONOMOUS_ACTION_DETECTED',
      detail:   `Response contains language suggesting autonomous action: "${matched}"`,
      severity: 'hold',
    });
  }
}

// ── Rule 2: Outbound Draft Without Gate ───────────────────────
// Severity: hold
// Skipped when postApproval === true OR gateWasInvoked === true.
// Defense-in-depth text heuristic: only runs when the orchestrator
// state signal says no approval gate fired this turn. Ground truth
// lives in gateWasInvoked.

const OUTBOUND_INDICATORS: RegExp[] = [
  /^to:/im,
  /^subject:/im,
  /^dear /im,
];

const GATE_MARKERS: string[] = [
  'approve',
  'send this',
  'ready to send',
  'confirm',
  'shall i send',
  'want me to send',
  'should i send',
  'ok to send',
];

function checkOutboundDraftWithoutGate(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  const hasOutboundIndicator = OUTBOUND_INDICATORS.some(p =>
    p.test(input.responseText)
  );
  if (!hasOutboundIndicator) return;

  const lower = input.responseText.toLowerCase();
  const hasGateMarker = GATE_MARKERS.some(m => lower.includes(m));

  if (!hasGateMarker) {
    flags.push({
      rule:     'OUTBOUND_DRAFT_WITHOUT_GATE',
      detail:   'Response contains an outbound draft without a visible approval gate',
      severity: 'hold',
    });
  }
}

// ── Rule 3: Safety Flag Not Surfaced ─────────────────────────
// Severity: flag
// Checks whether any significant term from an active,
// unacknowledged safety flag appears in the response.
// Fires on the first unmatched safety flag found.

function checkSafetyFlagNotSurfaced(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  const activeSafetyFlags = input.contextualData.activeFlags.filter(
    f => f.type === 'safety' && !f.acknowledged
  );

  if (activeSafetyFlags.length === 0) return;

  const lower = input.responseText.toLowerCase();

  for (const safetyFlag of activeSafetyFlags) {
    const significantTerms = safetyFlag.content
      .split(/\s+/)
      .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length >= 4);

    if (significantTerms.length === 0) continue;

    const anyTermPresent = significantTerms.some(term => lower.includes(term));

    if (!anyTermPresent) {
      flags.push({
        rule:     'SAFETY_FLAG_NOT_SURFACED',
        detail:   `Active safety flag not addressed in response: "${safetyFlag.content.substring(0, 60)}"`,
        severity: 'flag',
      });
      return;
    }
  }
}

// ── Rule 4: Unverified Serial Number ─────────────────────────
// Severity: flag
//
// Two serial patterns run in sequence:
//   Pattern A — purely numeric:        \b\d{5,8}\b
//   Pattern B — alphanumeric:          \b[A-Z]{1,4}\d{5,8}[A-Z]{0,2}\b
//
// Minimum 5 digits on both patterns prevents false positives
// on machine model references (H6700 = 4 digits, KTC1200 = 4 digits).
//
// Verified serial check is bidirectional substring:
//   verified.includes(candidate) OR candidate.includes(verified)
// This handles format mismatches in both directions, e.g. verified
// serial '153640' vs response text 'SN153640'.
//
// Phone context exclusion applies to Pattern A only.
// Pattern B (alphanumeric) will not match phone number formats.

const NUMERIC_SERIAL_PATTERN  = /\b\d{5,8}\b/g;
const ALPHA_SERIAL_PATTERN    = /\b[A-Z]{1,4}\d{5,8}[A-Z]{0,2}\b/g;

const PHONE_CONTEXT_MARKERS: string[] = [
  'ext', ' x ', 'phone', 'call', 'tel', 'fax',
  'mobile', 'cell', 'contact', 'reach',
];

function isPhoneContext(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - 12);
  const end   = Math.min(text.length, matchIndex + 15);
  const ctx   = text.substring(start, end).toLowerCase();
  return PHONE_CONTEXT_MARKERS.some(m => ctx.includes(m));
}

function serialIsVerified(
  candidate:      string,
  verifiedSerials: string[],
  eventContent:   string
): boolean {
  if (eventContent.includes(candidate)) return true;
  // Bidirectional substring: handles format mismatches in both directions
  return verifiedSerials.some(v =>
    v.includes(candidate) || candidate.includes(v)
  );
}

function checkUnverifiedSerial(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  const verifiedSerials: string[] = [];
  if (input.contextualData.consistContext) {
    for (const machine of input.contextualData.consistContext.relevantMachines) {
      if (machine.serialNumber) verifiedSerials.push(machine.serialNumber);
    }
  }

  const eventContent = input.event.rawContent;

  // Pattern A — purely numeric (with phone context exclusion)
  const numericPattern = new RegExp(NUMERIC_SERIAL_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = numericPattern.exec(input.responseText)) !== null) {
    if (isPhoneContext(input.responseText, match.index)) continue;
    if (serialIsVerified(match[0], verifiedSerials, eventContent)) continue;

    flags.push({
      rule:     'UNVERIFIED_SERIAL_NUMBER',
      detail:   `Numeric sequence "${match[0]}" not found in verified sources or event content`,
      severity: 'flag',
    });
    return;
  }

  // Pattern B — alphanumeric, uppercase letter prefix/suffix
  // No phone context exclusion — alphanumeric patterns won't match phone numbers
  const alphaPattern = new RegExp(ALPHA_SERIAL_PATTERN.source, 'g');

  while ((match = alphaPattern.exec(input.responseText)) !== null) {
    if (serialIsVerified(match[0], verifiedSerials, eventContent)) continue;

    flags.push({
      rule:     'UNVERIFIED_SERIAL_NUMBER',
      detail:   `Serial-like identifier "${match[0]}" not found in verified sources or event content`,
      severity: 'flag',
    });
    return;
  }
}

// ── Rule 5: Unverified Cost Figure ───────────────────────────
// Severity: flag
// Catches dollar amounts not traceable to verified sources.
// Exemptions:
// — Sentence contains estimation marker language
// — Amount preceded by ~ (informal approximation)

const COST_PATTERN = /\$[\d,]+(?:\.\d{2})?/g;

const ESTIMATION_MARKERS: string[] = [
  'estimated', 'estimate', 'approximately', 'roughly', 'around',
  'about', 'ballpark', 'typically', 'usually', 'could be',
  'might be', 'up to', 'as low as', 'as high as',
];

function sentenceContainsEstimation(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return ESTIMATION_MARKERS.some(m => lower.includes(m));
}

function checkUnverifiedCost(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  const verifiedSources = [
    input.event.rawContent,
    ...input.contextualData.openItems.map(i => i.content),
  ].join(' ');

  const sentences = input.responseText.split(/[.!?\n]+/);

  const pattern = new RegExp(COST_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input.responseText)) !== null) {
    const costStr = match[0];

    const charBefore = match.index > 0
      ? input.responseText[match.index - 1]
      : '';
    if (charBefore === '~') continue;

    const containingSentence = sentences.find(s => s.includes(costStr)) ?? '';
    if (sentenceContainsEstimation(containingSentence)) continue;

    if (verifiedSources.includes(costStr)) continue;

    flags.push({
      rule:     'UNVERIFIED_COST_FIGURE',
      detail:   `Cost figure "${costStr}" not found in verified sources and not framed as an estimate`,
      severity: 'flag',
    });
    return;
  }
}

// ── Rule 6: SMS Format Violation ─────────────────────────────
// Severity: warn
// Detects markdown formatting in SMS-channel responses.
// Pattern list is sourced from the shared formatters module to
// reduce drift in preflight detection; full alignment with
// outputRouter.formatForSms will happen once OR-3 / issue #25
// migrates SMS formatting there to the shared patterns. See audit
// finding PF-15 + Pattern 7.

function checkSmsFormatViolation(
  input: PreflightInput,
  flags: PreflightFlag[]
): void {
  if (input.event.metadata.channel !== 'sms') return;

  const hasMarkdown = SMS_MARKDOWN_PATTERNS.some(p =>
    p.test(input.responseText)
  );

  if (hasMarkdown) {
    flags.push({
      rule:     'SMS_FORMAT_VIOLATION',
      detail:   'Response contains markdown formatting not suitable for SMS channel',
      severity: 'warn',
    });
  }
}

// ── Main Entry Point ──────────────────────────────────────────
// pass = true  → all flags are warn, or no flags at all
// pass = false → at least one hold or flag severity present

export function runPreflight(input: PreflightInput): PreflightResult {
  const flags: PreflightFlag[] = [];

  if (!input.postApproval && !input.actionWasInvoked) {
    checkAutonomousAction(input, flags);
  }
  if (!input.postApproval && !input.gateWasInvoked) {
    checkOutboundDraftWithoutGate(input, flags);
  }

  checkSafetyFlagNotSurfaced(input, flags);
  checkUnverifiedSerial(input, flags);
  checkUnverifiedCost(input, flags);
  checkSmsFormatViolation(input, flags);

  const pass = flags.every(f => f.severity === 'warn');

  return { pass, flags };
}
