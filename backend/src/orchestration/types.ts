// ============================================================
// OTM Orchestration — Shared Types
// All types are edition-agnostic. Edition-specific behavior
// is injected via EditionConfig, not hardcoded here.
// ============================================================

// ── Edition Configuration ───────────────────────────────────

export interface EditionConfig {
  editionId: string;
  systemPromptPath: string;
  styleProfileTable: string;
  contextFields: ContextFieldConfig;
  contextWindowConfig?: ContextWindowConfig;
  auditConfig?: AuditConfig;
}

export interface ContextFieldConfig {
  includeActiveFlags: boolean;
  includeOpenItems: boolean;
  includeConsistContext: boolean;
  additionalFields?: string[];
}

export interface ContextWindowConfig {
  totalTokens?: number;
  responseReserve?: number;
  dynamicInjectionCap?: number;
}

export interface AuditConfig {
  maxSystemRegens?: number;
  maxManualRegens?: number;
  githubRepo?: string;
  feedbackFallbackEmail?: string;
}

// ── Event Types ─────────────────────────────────────────────

export type EventType =
  | 'user_message'
  | 'inbound_sms'
  | 'inbound_email'
  | 'system_trigger'
  | 'session_lifecycle';

export interface ProcessedEvent {
  eventType: EventType;
  rawContent: string;
  metadata: EventMetadata;
  timestamp: string;
}

export interface EventMetadata {
  sessionId: string;
  userId: string;
  channel?: string;
  sender?: string;
  threadId?: string;
  emailProvider?: string;
}

// ── Email Normalization ───────────────────────────────────────

export interface NormalizedEmailNotification {
  messageId:    string;
  threadId?:    string;
  emailAddress: string;
  provider:     string;
}

// ── Session State ────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  userId: string;
  editionId: string;
  openedAt: string;
  lastInteractionAt: string;
  conversationHistory: Message[];
  activeFlags: ActiveFlag[];
  openItems: OpenItem[];
  consistContext: ConsistContext | null;
  isFromLogReplay: boolean;
}

export interface ActiveFlag {
  flagId: string;
  type: 'safety' | 'push' | 'pull' | 'audit';
  content: string;
  raisedAt: string;
  acknowledged: boolean;
}

export interface OpenItem {
  itemId: string;
  category: 'safety' | 'machine' | 'parts' | 'compliance' | 'contact';
  content: string;
  priority: number;
  isPush: boolean;
}

export interface ConsistContext {
  consistId: string;
  relevantMachines: MachineRef[];
}

export interface MachineRef {
  position: number;
  name: string;
  serialNumber?: string;
}

// ── Messages ─────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

// ── Context Data ─────────────────────────────────────────────

export interface ContextualData {
  activeFlags: ActiveFlag[];
  openItems: OpenItem[];
  consistContext: ConsistContext | null;
  additionalRecords?: Record<string, unknown>[];
}

// ── Assembler Inputs / Outputs ───────────────────────────────

export interface AssemblerInput {
  editionConfig: EditionConfig;
  styleProfile: string;
  conversationHistory: Message[];
  currentInput: ProcessedEvent;
  contextualData: ContextualData;
}

export interface AssemblerOutput {
  systemPrompt: string;
  messages: Message[];
  tokenEstimate: number;
  contextWindowUsedPct: number;
  historyTrimmed: boolean;
  historyTurnsTrimmed: number;
}

// ── Audit Types ──────────────────────────────────────────────

export type AuditResult = 'pass' | 'flag' | 'revise';

export interface PreflightResult {
  pass: boolean;
  flags: PreflightFlag[];
}

export interface PreflightFlag {
  rule:     string;
  detail:   string;
  severity: 'hold' | 'flag' | 'warn';
}

export interface PreflightInput {
  responseText:   string;
  event:          ProcessedEvent;
  contextualData: ContextualData;
  postApproval:   boolean;
}

export interface ModelAuditResult {
  result:      AuditResult;
  issue?:      string;
  correction?: string;
}

export interface ModelAuditInput {
  responseText:   string;
  event:          ProcessedEvent;
  contextualData: ContextualData;
  preflightFlags: PreflightFlag[];
  sessionId:      string;
  requestId:      string;
}

// ── Regen / Feedback Payload ─────────────────────────────────

export type UserAction = 'use_as_is' | 'dropped' | 'pending' | 'feedback_sent';

export interface AttemptRecord {
  attempt: number;
  responseDraft: string;
  preflightResult: PreflightResult;
  modelAuditResult: ModelAuditResult;
}

export interface FeedbackPayload {
  sessionId: string;
  timestamp: string;
  eventType: EventType;
  initialInput: string;
  attempts: AttemptRecord[];
  manualRegens: AttemptRecord[];
  userAction: UserAction;
  sessionContextSnapshot: {
    activeFlags: ActiveFlag[];
    openItems: OpenItem[];
    lastInboundSender?: string;
  };
}

// ── User Settings ─────────────────────────────────────────────

export interface UserSettings {
  digestThresholdHours:         number;
  pushRepeatIntervalHours:      number;
  budgetVariancePushThreshold:  number;
  budgetVariancePullThreshold:  number;
  defaultSessionOpenPreference: 'summary' | 'skip';
  wakeWordSensitivity:          number;
  ttsRate:                      number;
  voiceResponseMode:            'always' | 'wake_word_only' | 'never';
  shiftStartTime:               string;
  timeZone:                     string;
  commsLogRetentionDays:        number;
  styleExclusions:              string[];
  styleProfileVisible:          boolean;
}

// ── Context Loader Inputs / Outputs ──────────────────────────

export interface ContextLoaderInput {
  event:         ProcessedEvent;
  sessionState:  SessionState;
  editionConfig: EditionConfig;
}

export interface ContextLoaderOutput {
  styleProfile:   string;
  userSettings:   UserSettings;
  contextualData: ContextualData;
}

// ── Primary Call Inputs / Outputs ────────────────────────────

export interface PrimaryCallInput {
  assemblerOutput: AssemblerOutput;
  sessionId:       string;
  requestId:       string;
}

export interface PrimaryCallOutput {
  responseText:  string;
  inputTokens:   number;
  outputTokens:  number;
  durationMs:    number;
  model:         string;
}

// ── Output Router ─────────────────────────────────────────────

export interface RouteInstruction {
  channel:     'app' | 'sms' | 'push' | 'log';
  recipients?: string[];
  sessionId:   string;
  requestId:   string;
}

export interface FailedRecipient {
  recipient: string;
  reason:    string;
}

export interface RouteResult {
  channel:      'app' | 'sms' | 'push' | 'log';
  success:      boolean;
  delivered:    string[];
  failed:       FailedRecipient[];
  segmentCount: number;
  requestId:    string;
}

// ── Session Persistence ───────────────────────────────────────

export type SessionLogEntryType =
  | 'session_open'
  | 'user_message'
  | 'assistant_response'
  | 'flag_raised'
  | 'flag_acknowledged'
  | 'approval_decision'
  | 'route_result'
  | 'session_close';

export interface SessionLogEntry {
  entryId:       string;   // UUID — enables idempotent replay
  sessionId:     string;
  userId:        string;
  entryType:     SessionLogEntryType;
  payload:       string;   // JSON-serialized, validated at write time
  schemaVersion: number;   // payload schema version — used by replay for migration
  timestamp:     string;   // ISO 8601
}

// ── SQLite Client — shared structural interface ───────────────
// Moved from sessionPersistence.ts — used by tool layer and
// persistence layer. Structural — not tied to a specific library.

export interface SqliteClient {
  run(sql: string, params: unknown[]): Promise<void>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

// ── Machine / Fleet ───────────────────────────────────────────

export type MachineType = 'consist' | 'support';

// Resolved machine identity returned to the caller.
// position is null for support equipment.
export interface MachineIdentity {
  machineId:   string;
  position:    number | null;
  fullName:    string;
  machineType: MachineType;
}

// Full roster row used internally for identifier resolution.
// commonNames is data-driven from the DB — never hardcoded.
export interface MachineRosterEntry extends MachineIdentity {
  serialNumber: string | undefined;
  commonNames:  string[];
}

// One EAV spec row in caller-facing shape.
// value is null only when isGap === true (first-class field).
// isGap: true  → spec known but value not yet confirmed;
//                caller must surface this explicitly to the user.
// isGap: false → value is confirmed and present.
export interface SpecEntry {
  key:         string;
  value:       string | null;
  unit:        string | undefined;
  source:      string | undefined;
  confirmedAt: string | undefined;
  isGap:       boolean;
}

// ── Spec Lookup ───────────────────────────────────────────────

export interface SpecLookupInput {
  identifier: string;    // position number, serial, full name, or common name
  keys?:      string[];  // specific spec keys; absent = return all entries
  sessionId:  string;
  requestId:  string;
}

// Discriminated result — all four states require explicit caller action.
// status: 'not_found' / unknown_machine → identifier matched nothing in roster
// status: 'not_found' / ambiguous       → multiple machines matched; surface all
//                                         candidates to user for disambiguation
// status: 'found'                        → entries may contain isGap=true rows and/or
//                                         unknownKeys; both must be surfaced to user
// status: 'error'                        → DB failure; message carries sanitized detail
//                                         for orchestrator logging; never throws
export type SpecLookupResult =
  | { status: 'found';     machine: MachineIdentity; entries: SpecEntry[]; unknownKeys: string[] }
  | { status: 'not_found'; reason: 'unknown_machine' }
  | { status: 'not_found'; reason: 'ambiguous'; candidates: MachineIdentity[] }
  | { status: 'error';     cause: 'db_error'; message: string };

// ── Diagnostic Logger ─────────────────────────────────────────

// Three severity levels — determined by the tool generating the event
// via exported pure determineSeverity() functions. Never set by the
// orchestrator directly.
export type DiagnosticSeverity = 'info' | 'warning' | 'critical';

// One diagnostic_log row in caller-facing shape.
// isSynced: false until Phase 7 sync layer confirms Supabase write.
// Local purge only deletes rows where isSynced === true.
export interface DiagnosticEntry {
  entryId:      string;           // UUID
  sessionId:    string;
  userId:       string;
  category:     string;           // plain string — extensible without migration
  severity:     DiagnosticSeverity;
  machineId:    string | null;    // null for system-level events
  message:      string;
  metadataJson: string | null;    // JSON-serialized metadata, null if none supplied
  timestamp:    string;           // ISO 8601
  isSynced:     boolean;
}

export interface DiagnosticLogInput {
  userId:    string;
  sessionId: string;
  requestId: string;
  category:  string;
  severity:  DiagnosticSeverity;
  machineId: string | null;
  message:   string;
  metadata?: Record<string, unknown>;
}

export interface DiagnosticPurgeResult {
  entriesDeleted: number;
  purgedBefore:   string;   // ISO 8601 cutoff used
}

// ── Todo Tool ─────────────────────────────────────────────────

export type TodoCategory =
  | 'safety'
  | 'equipment_specific'
  | 'parts_inventory'
  | 'compliance_admin'
  | 'contact';

export type TodoTimeSensitivity = 'urgent' | 'standard' | 'low';
export type TodoStatus         = 'open' | 'done' | 'dismissed';

// Validated draft — returned by buildTodoDraft().
// Orchestrator routes this through the approval gate before calling writeTodo().
export interface TodoDraft {
  userId:             string;
  sessionId:          string;
  requestId:          string;
  description:        string;
  category:           TodoCategory;
  timeSensitivity:    TodoTimeSensitivity;
  dueDate?:           string;           // ISO 8601
  equipmentId:        string | null;    // resolved by orchestrator via specLookup
  equipmentNote?:     string;           // free-text when equipmentId is null
  linkedContactId:    string | null;    // resolved by orchestrator
  linkedContactNote?: string;           // free-text when linkedContactId is null
  metadataJson:       string | null;
}

export interface TodoCreateInput {
  userId:             string;
  sessionId:          string;
  requestId:          string;
  description:        string;
  category:           TodoCategory;
  timeSensitivity:    TodoTimeSensitivity;
  dueDate?:           string;
  equipmentId:        string | null;
  equipmentNote?:     string;
  linkedContactId:    string | null;
  linkedContactNote?: string;
  metadata?:          Record<string, unknown>;
}

export interface TodoUpdateInput {
  todoId:    string;
  status:    'done' | 'dismissed';
  userId:    string;
  sessionId: string;
  requestId: string;
}

// ── Comms Drafter ─────────────────────────────────────────────

// toneLevel: integer 0–10.
// Reference anchors (not enforced as enum values):
//   0 = neutral, 5 = peer, 10 = formal
// Contact's stored toneLevel is the default.
// User instruction overrides it (e.g. "a little more casual" → decrement 1–2).
// Orchestrator supplies the value; tool validates range and integer constraint.

export interface SmsDraft {
  channel:    'sms';
  recipients: string[];   // resolved phone numbers
  body:       string;     // plain text; output router formats at send time
  toneLevel:  number;     // 0–10
}

export interface EmailDraft {
  channel:    'email';
  recipients: string[];   // resolved email addresses
  subject:    string;
  body:       string;     // plain text or simple HTML; no provider extensions
  toneLevel:  number;     // 0–10
  replyTo?:   string;
}

export type CommsDraft = SmsDraft | EmailDraft;

export interface CommsDraftInput {
  channel:    'sms' | 'email';
  recipients: string[];
  body:       string;
  toneLevel:  number;
  subject?:   string;   // required for email, ignored for sms
  replyTo?:   string;   // email only
  sessionId:  string;
  requestId:  string;
}

// Discriminated result — same pattern as buildTodoDraft.
export type CommsDraftResult =
  | { ok: true;  draft: CommsDraft }
  | { ok: false; error: string };

// ── Expense Parser ────────────────────────────────────────────

export type PurchaseMethod =
  | { type: 'card';    lastFour?: string }
  | { type: 'account'; accountRef?: string }
  | { type: 'cash' }
  | { type: 'unknown' };

export interface ExpenseLineItem {
  description: string;
  quantity?:   number;
  unitPrice?:  number;
  totalPrice?: number;
}

// Partial results are first-class — fields not extractable are null.
// rawText is always present (verbatim input or extracted text).
// confidence reflects overall extraction quality.
// parseWarnings lists non-fatal issues encountered during parsing.
export interface ExpenseRecord {
  vendor:         string | null;
  date:           string | null;       // ISO 8601 when extractable
  amount:         number | null;       // total, parsed float
  currency:       string;              // defaults to 'USD'
  purchaseMethod: PurchaseMethod | null;
  lineItems:      ExpenseLineItem[];
  rawText:        string;
  confidence:     'high' | 'medium' | 'low';
  parseWarnings:  string[];
}

export interface ExpenseParseInput {
  inputType:      'text' | 'image';
  text?:          string;        // required when inputType === 'text'
  imageBytes?:    Uint8Array;    // required when inputType === 'image'
  imageMimeType?: string;        // required when inputType === 'image'
  sessionId:      string;
  requestId:      string;
}

export type ExpenseParseResult =
  | { ok: true;  record: ExpenseRecord }
  | { ok: false; error: string };

// ── PO Generator ──────────────────────────────────────────────

export interface PoLineItem {
  description: string;
  quantity:    number;    // positive integer
  unitPrice:   number;    // positive float
  partNumber?: string;
}

// Internal record — written to orders_log.
// status is always 'draft' at generation time.
// Approval required before any status change.
export interface PurchaseOrder {
  poNumber:          string;        // PO-YYYYMMDD-NNNN
  userId:            string;
  sessionId:         string;
  vendorName:        string;
  lineItems:         PoLineItem[];
  subtotal:          number;
  issuedDate:        string;        // ISO 8601
  status:            'draft';
  equipmentId:       string | null;
  equipmentPosition: number | null;
  notes?:            string;
}

// Formatted representation for print/share.
// Tool produces structured data; rendering is the interface layer's job.
export interface PoDocument {
  poNumber:              string;
  vendorName:            string;
  issuedDate:            string;
  equipmentLabel:        string | null;   // e.g. "Pos 1 — Nordco CX Spiker #1"
  lineItemsFormatted:    string[];        // e.g. "Filter HF6553  x1  $12.50  =  $12.50"
  subtotalFormatted:     string;          // e.g. "$23.21"
  notes:                 string | null;
  status:                'draft';
}

export interface PoGenerateInput {
  userId:            string;
  sessionId:         string;
  requestId:         string;
  sequenceNumber:    number;     // caller supplies; tool formats into poNumber
  vendorName:        string;
  lineItems:         PoLineItem[];
  equipmentId:       string | null;
  equipmentPosition: number | null;
  issuedDate?:       string;    // ISO 8601; defaults to today if absent
  notes?:            string;
}

export type PoGenerateResult =
  | { ok: true;  order: PurchaseOrder; document: PoDocument }
  | { ok: false; error: string };
