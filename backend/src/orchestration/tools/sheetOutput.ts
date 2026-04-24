// ============================================================
// OTM Tools — Sheet Output
// Produces RFC 4180-compliant CSV from tabular data.
// Universal format: compatible with user download (.csv),
// Google Sheets API upload, and Excel import.
// Interface layer handles file write or API delivery.
// Pure functions only — no DB access, no file system calls.
// ============================================================

import {
  SheetTable,
  SheetRow,
  SheetCellValue,
  SheetOutputResult,
} from '../types';

// ── Validation ────────────────────────────────────────────────

export function validateSheetTable(table: SheetTable): string | null {
  if (!Array.isArray(table.headers) || table.headers.length === 0) {
    return 'headers must be a non-empty array';
  }
  const seen = new Set<string>();
  for (const h of table.headers) {
    if (!h || h.trim() === '') return 'each header must be a non-empty string';
    if (seen.has(h)) return `duplicate header: "${h}"`;
    seen.add(h);
  }
  if (!Array.isArray(table.rows) || table.rows.length === 0) {
    return 'rows must be a non-empty array';
  }
  if ('title' in table && (typeof table.title !== 'string' || table.title.trim() === '')) {
    return 'title must be a non-empty string when present';
  }
  return null;
}

// ── Pure Functions ────────────────────────────────────────────

// RFC 4180 cell escaping:
// - Wrap in double quotes if value contains comma, double quote, or newline
// - Double any internal double quotes
// - Null → empty string
export function escapeCsvCell(value: SheetCellValue): string {
  if (value === null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Builds one CSV row string from a SheetRow, ordered by headers.
// Missing keys produce empty cells — never throws on missing columns.
export function buildCsvRow(row: SheetRow, headers: string[]): string {
  return headers.map(h => escapeCsvCell(row[h] ?? null)).join(',');
}

// Produces RFC 4180 CSV string from a SheetTable.
// CRLF line endings per spec.
// Title is NOT written into the CSV — RFC 4180 has no comment
// mechanism, and "# title" would render as literal cell A1 content
// in Google Sheets and Excel. Title is returned on SheetOutputResult
// as out-of-band metadata for the interface layer to surface
// (filename, sheet tab, email subject, UI header).
export function buildCsvPayload(table: SheetTable): string {
  const lines: string[] = [];
  lines.push(table.headers.map(h => escapeCsvCell(h)).join(','));
  for (const row of table.rows) {
    lines.push(buildCsvRow(row, table.headers));
  }
  return lines.join('\r\n');
}

// Main entry — validates then builds.
export function buildSheetOutput(table: SheetTable): SheetOutputResult {
  const validationError = validateSheetTable(table);
  if (validationError) return { ok: false, error: validationError };

  const csv = buildCsvPayload(table);
  return {
    ok:          true,
    csv,
    rowCount:    table.rows.length,
    columnCount: table.headers.length,
    ...(typeof table.title === 'string' ? { title: table.title.trim() } : {}),
  };
}
