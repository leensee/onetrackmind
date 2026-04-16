// ============================================================
// OTM Tools — PO Generator
// Produces two outputs: a PurchaseOrder record (written to
// orders_log) and a PoDocument (structured for print/share).
// Tool is pure at draft stage — orchestrator owns approval gate.
// DB client injected — never constructed here.
// All queries parameterized — no string interpolation.
// is_synced pattern applies: orders_log is local-first.
// Never throws on operational failures.
// ============================================================

import { randomUUID } from 'crypto';
import {
  PoGenerateInput,
  PoGenerateResult,
  PurchaseOrder,
  PoDocument,
  PoLineItem,
} from '../types';

// ── Constants ─────────────────────────────────────────────────

const IS_NOT_SYNCED = 0; // Phase 7 sync layer sets to 1 after Supabase write

// ── Narrow DB Interface ───────────────────────────────────────

export interface PoWriteDbClient {
  run(sql: string, params: unknown[]): Promise<void>;
}

// ── Error and Result Types ────────────────────────────────────

export class PoWriteError extends Error {
  public readonly sessionId: string;
  public readonly requestId: string;
  public readonly cause:     'write_error' | 'invalid_input';

  constructor(
    message: string, sessionId: string, requestId: string,
    cause: 'write_error' | 'invalid_input'
  ) {
    super(message);
    this.name      = 'PoWriteError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = cause;
  }
}

export type PoWriteResult = PoWriteError | null;

// ── Pure Functions ────────────────────────────────────────────

export function validatePoInput(input: PoGenerateInput): string | null {
  if (!input.vendorName || input.vendorName.trim() === '') {
    return 'vendorName must not be empty';
  }
  if (!Array.isArray(input.lineItems) || input.lineItems.length === 0) {
    return 'lineItems must contain at least one item';
  }
  for (let i = 0; i < input.lineItems.length; i++) {
    const item = input.lineItems[i]!;
    if (!item.description || item.description.trim() === '') {
      return `lineItems[${i}].description must not be empty`;
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return `lineItems[${i}].quantity must be a positive integer`;
    }
    if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0 || isNaN(item.unitPrice)) {
      return `lineItems[${i}].unitPrice must be a positive number`;
    }
  }
  if (input.issuedDate !== undefined) {
    const d = new Date(input.issuedDate);
    if (isNaN(d.getTime())) return `issuedDate must be a valid ISO 8601 date; got: ${input.issuedDate}`;
  }
  return null;
}

// Generates PO number: PO-YYYYMMDD-NNNN (zero-padded to 4 digits).
export function generatePoNumber(issuedDate: string, sequence: number): string {
  const datePart = issuedDate.replace(/-/g, '').slice(0, 8); // YYYYMMDD
  const seqPart  = String(sequence).padStart(4, '0');
  return `PO-${datePart}-${seqPart}`;
}

// Computes subtotal from line items — sum of quantity * unitPrice.
export function computeSubtotal(lineItems: PoLineItem[]): number {
  return Math.round(
    lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100
  ) / 100;
}

// Formats a dollar amount: $12.50
function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Formats one line item for the PoDocument.
function formatLineItem(item: PoLineItem): string {
  const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
  const pn        = item.partNumber ? `[${item.partNumber}] ` : '';
  return `${pn}${item.description}  x${item.quantity}  ${formatCurrency(item.unitPrice)}  =  ${formatCurrency(lineTotal)}`;
}

export function buildPurchaseOrder(
  input:    PoGenerateInput,
  poNumber: string,
  subtotal: number,
  date:     string
): PurchaseOrder {
  const order: PurchaseOrder = {
    poNumber,
    userId:            input.userId,
    sessionId:         input.sessionId,
    vendorName:        input.vendorName.trim(),
    lineItems:         input.lineItems,
    subtotal,
    issuedDate:        date,
    status:            'draft',
    equipmentId:       input.equipmentId,
    equipmentPosition: input.equipmentPosition,
  };
  if (input.notes !== undefined) order.notes = input.notes.trim();
  return order;
}

export function buildPoDocument(order: PurchaseOrder): PoDocument {
  const equipmentLabel = order.equipmentPosition !== null
    ? `Pos ${order.equipmentPosition}${order.equipmentId ? ` — ${order.equipmentId}` : ''}`
    : null;

  const doc: PoDocument = {
    poNumber:           order.poNumber,
    vendorName:         order.vendorName,
    issuedDate:         order.issuedDate,
    equipmentLabel,
    lineItemsFormatted: order.lineItems.map(formatLineItem),
    subtotalFormatted:  formatCurrency(order.subtotal),
    notes:              order.notes ?? null,
    status:             'draft',
  };
  return doc;
}

// Main pure entry — builds both order and document.
export function buildPoGenerateResult(
  input:          PoGenerateInput,
  sequenceNumber: number
): PoGenerateResult {
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
    return { ok: false, error: 'sequenceNumber must be a positive integer' };
  }
  const validationError = validatePoInput(input);
  if (validationError) return { ok: false, error: validationError };

  const date     = input.issuedDate ?? new Date().toISOString().split('T')[0]!;
  const poNumber = generatePoNumber(date, sequenceNumber);
  const subtotal = computeSubtotal(input.lineItems);
  const order    = buildPurchaseOrder(input, poNumber, subtotal, date);
  const document = buildPoDocument(order);
  return { ok: true, order, document };
}

// ── DB Function ───────────────────────────────────────────────
// Called by orchestrator after approval gate resolves 'approve'.
// Writes PurchaseOrder to orders_log with status=draft, is_synced=0.
// Returns null on success; PoWriteError on failure. Never throws.

export async function writePurchaseOrder(
  order:     PurchaseOrder,
  requestId: string,
  db:        PoWriteDbClient
): Promise<PoWriteResult> {
  const entryId = randomUUID();

  try {
    await db.run(
      `INSERT INTO orders_log
         (entry_id, po_number, user_id, session_id, vendor_name, line_items_json,
          subtotal, issued_date, status, equipment_id, equipment_position,
          notes, created_at, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        order.poNumber,
        order.userId,
        order.sessionId,
        order.vendorName,
        JSON.stringify(order.lineItems),
        order.subtotal,
        order.issuedDate,
        order.status,
        order.equipmentId,
        order.equipmentPosition,
        order.notes ?? null,
        new Date().toISOString(),
        IS_NOT_SYNCED,
      ]
    );
    console.info(
      `[PoGenerator] PO written poNumber=${order.poNumber} ` +
      `vendor=${order.vendorName} subtotal=${order.subtotal} ` +
      `sessionId=${order.sessionId}`
    );
    return null;
  } catch (err) {
    return new PoWriteError(
      `Write failed: ${(err as Error).message}`,
      order.sessionId, requestId, 'write_error'
    );
  }
}
