// ============================================================
// OTM Orchestration — Shared Formatters
// Single source of truth for rendering shared domain types
// (ActiveFlag, OpenItem, MachineRef, ConsistContext, tool drafts)
// into human-readable strings. Consumers: promptAssembler (PA-8),
// modelAudit (MA-5), orchestratorTools approval gate (OT-9),
// preflight SMS markdown detection (PF-15).
// Pure — no side effects, no I/O, deterministic on inputs.
// Resolves audit finding 2026-04-16-OT-9 (Phase 3 audit).
// Also addresses PA-8, MA-5, PF-15 (Pattern 7 — reimplemented
// format logic for the same data types).
// ============================================================

import {
  ActiveFlag,
  OpenItem,
  MachineRef,
  ConsistContext,
  TodoDraft,
  CommsDraft,
  PoDocument,
} from './types';

const DEFAULT_INDENT = '  ';

// ── Element formatters ────────────────────────────────────────

/**
 * Render a single ActiveFlag as "[TYPE] content".
 * Type is uppercased. Bracketed label style is canonical — see
 * audit §Pattern 7 style-canonicalisation decision in the
 * commit-5 plan.
 */
export function formatActiveFlag(flag: ActiveFlag): string {
  return `[${flag.type.toUpperCase()}] ${flag.content}`;
}

/**
 * Render a single OpenItem as "[category] content", or
 * "[category [PUSH]] content" when isPush is true. Category
 * is kept lowercase to match the source enum.
 */
export function formatOpenItem(item: OpenItem): string {
  const pushLabel = item.isPush ? ' [PUSH]' : '';
  return `[${item.category}${pushLabel}] ${item.content}`;
}

/**
 * Render a single MachineRef as "Pos N: name — SN: serial", or
 * "Pos N: name" when the serial number is absent. Em-dash
 * separator is canonical.
 */
export function formatMachineRef(m: MachineRef): string {
  const serial = m.serialNumber ? ` — SN: ${m.serialNumber}` : '';
  return `Pos ${m.position}: ${m.name}${serial}`;
}

// ── List formatters (audit-prescribed names) ──────────────────

/**
 * Render an ActiveFlag[] as newline-joined indented lines.
 * Returns '' on empty input so callers control whether to emit
 * a section header + 'none' fallback or omit the section entirely.
 */
export function formatActiveFlags(
  flags: ActiveFlag[],
  indent: string = DEFAULT_INDENT,
): string {
  if (flags.length === 0) return '';
  return flags.map(f => `${indent}${formatActiveFlag(f)}`).join('\n');
}

/**
 * Render an OpenItem[] as newline-joined indented lines.
 * Returns '' on empty input. Same empty-handling contract as
 * formatActiveFlags.
 */
export function formatOpenItems(
  items: OpenItem[],
  indent: string = DEFAULT_INDENT,
): string {
  if (items.length === 0) return '';
  return items.map(i => `${indent}${formatOpenItem(i)}`).join('\n');
}

/**
 * Render a ConsistContext as newline-joined indented machine
 * lines. The consist identifier is NOT included — callers own
 * the section header (PA-8 emits "CONSIST CONTEXT (<id>):",
 * MA-5 emits "Consist machines:" with no id). Returns '' when
 * ctx is null or relevantMachines is empty.
 */
export function formatConsistContext(
  ctx: ConsistContext | null,
  indent: string = DEFAULT_INDENT,
): string {
  if (!ctx || ctx.relevantMachines.length === 0) return '';
  return ctx.relevantMachines
    .map(m => `${indent}${formatMachineRef(m)}`)
    .join('\n');
}

// ── Approval-gate rendering (OT-9 fix) ────────────────────────

/**
 * Render a tool draft as a human-readable multi-line string
 * suitable for the approval gate's `content` field. Replaces
 * JSON.stringify(draft) in orchestratorTools (OT-9). Phase 4's
 * tablet UI consumes this directly.
 *
 * Discriminated on draft shape:
 *  - CommsDraft: SmsDraft | EmailDraft (channel: 'sms' | 'email').
 *  - PoDocument: detected by `poNumber`.
 *  - TodoDraft: fallback case when neither `channel` nor `poNumber`
 *    is present.
 */
export function formatDraftForApproval(
  draft: TodoDraft | CommsDraft | PoDocument,
): string {
  if ('channel' in draft) return formatCommsDraftForApproval(draft);
  if ('poNumber' in draft) return formatPoDocumentForApproval(draft);
  return formatTodoDraftForApproval(draft);
}

function formatTodoDraftForApproval(draft: TodoDraft): string {
  const lines: string[] = [];
  lines.push('Create to-do:');
  lines.push(`  ${draft.description}`);
  lines.push('');
  lines.push(`Category: ${draft.category}`);
  lines.push(`Time sensitivity: ${draft.timeSensitivity}`);
  if (draft.dueDate) lines.push(`Due: ${draft.dueDate}`);
  const equipment = draft.equipmentId ?? draft.equipmentNote;
  if (equipment) lines.push(`Equipment: ${equipment}`);
  const contact = draft.linkedContactId ?? draft.linkedContactNote;
  if (contact) lines.push(`Linked contact: ${contact}`);
  return lines.join('\n');
}

function formatCommsDraftForApproval(draft: CommsDraft): string {
  const lines: string[] = [];
  const recipients = draft.recipients.join(', ');
  if (draft.channel === 'sms') {
    lines.push(`Send SMS to: ${recipients}`);
    lines.push(`Tone level: ${draft.toneLevel}`);
    lines.push('');
    lines.push(draft.body);
  } else {
    lines.push(`Send email to: ${recipients}`);
    lines.push(`Subject: ${draft.subject}`);
    if (draft.replyTo) lines.push(`Reply-to: ${draft.replyTo}`);
    lines.push(`Tone level: ${draft.toneLevel}`);
    lines.push('');
    lines.push(draft.body);
  }
  return lines.join('\n');
}

function formatPoDocumentForApproval(doc: PoDocument): string {
  const lines: string[] = [];
  lines.push(`Purchase order ${doc.poNumber}`);
  lines.push(`Vendor: ${doc.vendorName}`);
  lines.push(`Issued: ${doc.issuedDate}`);
  if (doc.equipmentLabel) lines.push(`Equipment: ${doc.equipmentLabel}`);
  lines.push('');
  lines.push('Line items:');
  for (const item of doc.lineItemsFormatted) {
    lines.push(`  ${item}`);
  }
  lines.push('');
  lines.push(`Subtotal: ${doc.subtotalFormatted}`);
  if (doc.notes) {
    lines.push('');
    lines.push(`Notes: ${doc.notes}`);
  }
  return lines.join('\n');
}

// ── SMS markdown patterns ─────────────────────────────────────

/**
 * Regex list for detecting SMS-incompatible markdown in response
 * text. Used by:
 *  - preflight Rule 6 (PF-15) via .test() — this commit
 *  - outputRouter.formatForSms (OR-3, migration pending) via
 *    .replace() — future commit
 *
 * Patterns are intentionally NOT global-flagged: stateful .test()
 * on g-flagged module-scoped regexes produces false negatives on
 * subsequent calls (lastIndex drift). The OR-3 migration will
 * compose g-flagged replacers from these sources — e.g.
 * `new RegExp(p.source, p.flags + 'g')`.
 *
 * Superset of what PF-15 detected pre-migration — now also
 * catches the table-row full-line pattern and italic `*` that
 * outputRouter.formatForSms strips but preflight previously
 * missed. Detection and removal will share one source of truth
 * once OR-3 lands.
 */
export const SMS_MARKDOWN_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s+/m,       // headers: # ## ### ...
  /^\|.*\|$/m,         // table rows
  /^[-*]\s+/m,         // list markers (both - and *)
  /\*\*/,              // bold
  /\*/,                // italic (fires after ** if only asterisks remain)
  /`{1,3}/,            // inline or fenced code ticks
];
