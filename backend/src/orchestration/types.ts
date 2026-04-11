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
  // hold — approval gate triggered; output held pending user action
  // flag — safety content prepended; continues to model audit
  // warn — advisory; logged, does not block output
}

// PreflightInput — what the pre-flight checker receives.
// postApproval: true when this response follows a cleared approval gate
// in the current turn. Suppresses Rules 1 and 2 which would otherwise
// false-positive on post-approval confirmation language.

export interface PreflightInput {
  responseText:   string;
  event:          ProcessedEvent;
  contextualData: ContextualData;
  postApproval:   boolean;
}

export interface ModelAuditResult {
  result:      AuditResult;
  issue?:      string;       // what is wrong
  correction?: string;       // specific data point or framing fix to inject into regen prompt
  // revisedContent removed — revision is handled by primary call regen at 0.7 temperature
  // correction is a targeted instruction, not a full rewrite
}

// ModelAuditInput — what the model audit receives.
// preflightFlags: findings from Layer 1 included as context for Layer 2.

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
