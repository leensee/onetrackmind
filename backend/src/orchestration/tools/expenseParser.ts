// ============================================================
// OTM Tools — Expense Parser
// Parses field-incurred expense records from text/verbal input
// or receipt images. Provider-agnostic via injected extractor.
// Two-stage pipeline: extraction (image → text) → parsing.
// Partial results are first-class — unextractable fields null.
// Never throws on operational failures.
// ============================================================

import {
  ExpenseParseInput,
  ExpenseParseResult,
  ExpenseRecord,
  ExpenseLineItem,
  PurchaseMethod,
} from '../types';

// ── Constants ─────────────────────────────────────────────────

export const DEFAULT_CURRENCY = 'USD';

// Structured extraction prompt for image path.
// Instructs the extractor to return verbatim receipt text
// rather than interpreting it — parsing is done here.
export const IMAGE_EXTRACTION_PROMPT =
  'Extract all text from this receipt or expense document verbatim. ' +
  'Include vendor name, date, all line items with prices, subtotal, ' +
  'tax, total, and payment method if visible. Return only the raw text.';

// ── ImageExtractorClient ──────────────────────────────────────
// Injected interface — never constructed here.
// Default implementation uses Claude vision (already a dependency).
// Swap to Textract, Google Vision, Mindee, etc. by providing a
// different implementation — no structural code changes required.

export interface ImageExtractorClient {
  extractText(
    imageBytes: Uint8Array,
    mimeType:   string,
    prompt:     string
  ): Promise<string>;
}

// ── Validation ────────────────────────────────────────────────

export function validateParseInput(input: ExpenseParseInput): string | null {
  if (input.inputType !== 'text' && input.inputType !== 'image') {
    return `inputType must be 'text' or 'image'; got: ${input.inputType}`;
  }
  if (input.inputType === 'text') {
    if (!input.text || input.text.trim() === '') return 'text must not be empty for text input';
  }
  if (input.inputType === 'image') {
    if (!input.imageBytes || input.imageBytes.length === 0) {
      return 'imageBytes must not be empty for image input';
    }
    if (!input.imageMimeType || input.imageMimeType.trim() === '') {
      return 'imageMimeType must not be empty for image input';
    }
  }
  return null;
}

// ── Pure Parse Functions ──────────────────────────────────────
// All operate on plain text. No async, no external calls.
// Exported for isolated testing.

export function parseVendor(text: string): string | null {
  // Look for vendor on first 3 lines — typically the header
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const line of lines.slice(0, 3)) {
    // Skip lines that are clearly not vendor names
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line)) continue;
    if (/^(date|total|subtotal|tax|amount|receipt|invoice)/i.test(line)) continue;
    if (line.length >= 3 && line.length <= 60) return line;
  }
  return null;
}

export function parseDate(text: string): string | null {
  const patterns = [
    // MM/DD/YYYY or MM-DD-YYYY
    /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/,
    // YYYY-MM-DD
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    // Month DD, YYYY
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const d = new Date(match[0]);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]!;
    }
  }
  return null;
}

export function parseAmount(text: string): number | null {
  // Prefer lines labelled 'total' over subtotals
  const lines = text.split('\n');
  const totalLine = lines.find(l => /\btotal\b/i.test(l) && !/subtotal/i.test(l));
  const searchText = totalLine ?? text;
  // Match dollar amounts: must have $ prefix OR decimal point to avoid
  // matching bare integers from dates, quantities, or other non-amount numbers.
  const matches = searchText.match(/\$\s*\d{1,6}(?:,\d{3})*(?:\.\d{2})?|\d{1,6}(?:,\d{3})*\.\d{2}/g);
  if (!matches) return null;
  const amounts = matches
    .map(m => parseFloat(m.replace(/[$,\s]/g, '')))
    .filter(n => !isNaN(n) && n > 0);
  if (amounts.length === 0) return null;
  return amounts[amounts.length - 1]!;
}

export function parsePurchaseMethod(text: string): PurchaseMethod {
  // Card with last four digits
  const cardMatch = text.match(/(?:card|visa|mastercard|amex|credit|debit)[^\d]*(\d{4})/i);
  if (cardMatch) {
    const method: PurchaseMethod = { type: 'card' };
    if (cardMatch[1]) (method as { type: 'card'; lastFour?: string }).lastFour = cardMatch[1];
    return method;
  }
  // Account charge
  const accountMatch = text.match(/(?:charged?\s+to|account|acct)[^\w]*([A-Z0-9\-]{3,20})/i);
  if (accountMatch) {
    const method: PurchaseMethod = { type: 'account' };
    if (accountMatch[1]) (method as { type: 'account'; accountRef?: string }).accountRef = accountMatch[1];
    return method;
  }
  // Cash
  if (/\bcash\b/i.test(text)) return { type: 'cash' };
  return { type: 'unknown' };
}

export function parseLineItems(text: string): ExpenseLineItem[] {
  const items: ExpenseLineItem[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const line of lines) {
    // Skip header/total lines
    if (/^(total|subtotal|tax|date|vendor|receipt|invoice|thank)/i.test(line)) continue;
    // Match "description ... price" pattern: at least one word followed by a dollar amount
    const match = line.match(/^(.+?)\s+\$?\s*(\d+(?:\.\d{2})?)$/);
    if (match && match[1] && match[2]) {
      const price = parseFloat(match[2]);
      if (!isNaN(price) && price > 0 && match[1].length >= 2) {
        items.push({ description: match[1].trim(), totalPrice: price });
      }
    }
  }
  return items;
}

export function computeConfidence(
  vendor: string | null,
  date:   string | null,
  amount: number | null
): 'high' | 'medium' | 'low' {
  const present = [vendor, date, amount !== null ? amount : null].filter(v => v !== null).length;
  if (present === 3) return 'high';
  if (present === 2) return 'medium';
  return 'low';
}

// Runs full parse pipeline on raw text. Pure — no async, no external calls.
export function buildExpenseRecord(rawText: string): ExpenseRecord {
  const vendor   = parseVendor(rawText);
  const date     = parseDate(rawText);
  const amount   = parseAmount(rawText);
  const method   = parsePurchaseMethod(rawText);
  const items    = parseLineItems(rawText);
  const confidence = computeConfidence(vendor, date, amount);

  const warnings: string[] = [];
  if (!vendor) warnings.push('vendor not found');
  if (!date)   warnings.push('date not found');
  if (amount === null) warnings.push('total amount not found');

  return {
    vendor,
    date,
    amount,
    currency:       DEFAULT_CURRENCY,
    purchaseMethod: method,
    lineItems:      items,
    rawText,
    confidence,
    parseWarnings:  warnings,
  };
}

// ── Main Entry ────────────────────────────────────────────────
// Validates input, routes to text or image path, returns typed result.
// extractor is optional — only required for image input.
// Never throws on operational failures.

export async function parseExpense(
  input:      ExpenseParseInput,
  extractor?: ImageExtractorClient
): Promise<ExpenseParseResult> {
  const validationError = validateParseInput(input);
  if (validationError) return { ok: false, error: validationError };

  let rawText: string;

  if (input.inputType === 'text') {
    rawText = input.text!.trim();
  } else {
    if (!extractor) {
      return { ok: false, error: 'imageExtractor is required for image input but was not provided' };
    }
    try {
      rawText = await extractor.extractText(
        input.imageBytes!,
        input.imageMimeType!,
        IMAGE_EXTRACTION_PROMPT
      );
      if (!rawText || rawText.trim() === '') {
        return { ok: false, error: 'image extraction returned empty text' };
      }
    } catch (err) {
      return { ok: false, error: `image extraction failed: ${(err as Error).message}` };
    }
  }

  return { ok: true, record: buildExpenseRecord(rawText) };
}
