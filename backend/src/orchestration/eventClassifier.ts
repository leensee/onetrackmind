// ============================================================
// OTM Orchestration — Event Classifier
// Classifies inbound events by source into typed ProcessedEvents.
// Classification is deterministic on source — never on content.
// Email normalization happens in route handlers before this runs —
// classifier never sees provider-specific webhook payloads.
// Stateless, synchronous, no external calls, no DB access.
// ============================================================

import { EventType, ProcessedEvent, EventMetadata, NormalizedEmailNotification } from './types';
import { extractString } from './typeUtils';

// ── Source Types ─────────────────────────────────────────────
// Set by the route handler before calling classifyEvent.
// Describes event category — never vendor identity.

export type ClassificationSource =
  | 'app'        // Flutter app — user_message
  | 'email'      // Any email provider (normalized before arrival) — inbound_email
  | 'sms'        // Any SMS provider (normalized before arrival) — inbound_sms
  | 'internal'   // Internal scheduler/monitor — system_trigger
  | 'lifecycle'; // Session open/close signal — session_lifecycle

const SOURCE_TO_EVENT_TYPE: Record<ClassificationSource, EventType> = {
  app:       'user_message',
  email:     'inbound_email',
  sms:       'inbound_sms',
  internal:  'system_trigger',
  lifecycle: 'session_lifecycle',
};

// ── Internal Payload ──────────────────────────────────────────
// Structured payload for system_trigger and session_lifecycle.
// Route handlers construct this — never parsed from freeform text.

export interface InternalPayload {
  triggerType: string;                  // e.g. 'pm_overdue', 'digest_threshold'
  data: Record<string, unknown>;        // trigger-specific structured data
}

// ── Raw Input ─────────────────────────────────────────────────
// Everything the classifier receives. Source is set by the route
// handler — never inferred. Provider normalization completed before
// this point.

export interface RawInput {
  source: ClassificationSource;
  requestId: string;                              // for pipeline tracing
  sessionId: string;                              // established before classifier runs
  userId: string;                                 // from auth context
  body: Record<string, unknown>;                  // raw parsed body — untrusted; not used for email
  headers?: Record<string, string>;               // carried through, not used for classification
  normalizedEmail?: NormalizedEmailNotification;  // required when source === 'email'
  internalPayload?: InternalPayload;              // required when source === 'internal' | 'lifecycle'
}

// ── Classification Error ──────────────────────────────────────

export class ClassificationError extends Error {
  public readonly requestId: string;
  public readonly source: string;

  constructor(message: string, requestId: string, source: string) {
    super(message);
    this.name = 'ClassificationError';
    this.requestId = requestId;
    this.source = source;
  }
}

// ── Raw Content Extractors ────────────────────────────────────

function extractAppContent(body: Record<string, unknown>, requestId: string): string {
  const content = extractString(body, 'content');
  if (content === undefined || content.trim() === '') {
    throw new ClassificationError(
      'app body missing required field: content (non-empty string)',
      requestId,
      'app'
    );
  }
  return content;
}

function extractSmsContent(body: Record<string, unknown>, requestId: string): string {
  // Route handler normalizes provider-specific field names to 'body' before this runs.
  const smsBody = extractString(body, 'body');
  if (smsBody === undefined) {
    throw new ClassificationError(
      'sms body missing required field: body (string) — handler must normalize before classifying',
      requestId,
      'sms'
    );
  }
  // Empty string is valid — MMS with no text body
  return smsBody;
}

function extractEmailContent(
  normalizedEmail: NormalizedEmailNotification | undefined,
  requestId: string
): string {
  // Full email body fetch is deferred to the context loader.
  // Classifier works with notification metadata only — provider-agnostic.
  if (!normalizedEmail) {
    throw new ClassificationError(
      'email event missing required normalizedEmail — route handler must normalize before classifying',
      requestId,
      'email'
    );
  }
  return JSON.stringify({
    messageId:    normalizedEmail.messageId,
    threadId:     normalizedEmail.threadId ?? null,
    emailAddress: normalizedEmail.emailAddress,
    provider:     normalizedEmail.provider,
  });
}

function extractInternalContent(
  internalPayload: InternalPayload | undefined,
  requestId: string
): string {
  if (!internalPayload) {
    throw new ClassificationError(
      'internal event missing required internalPayload',
      requestId,
      'internal'
    );
  }
  return JSON.stringify({
    triggerType: internalPayload.triggerType,
    data:        internalPayload.data,
  });
}

function extractLifecycleContent(
  body: Record<string, unknown>,
  internalPayload: InternalPayload | undefined,
  requestId: string
): string {
  if (internalPayload) {
    return JSON.stringify({
      triggerType: internalPayload.triggerType,
      data:        internalPayload.data,
    });
  }
  const event = extractString(body, 'event');
  if (event === undefined || event.trim() === '') {
    throw new ClassificationError(
      'lifecycle event missing required field: event or internalPayload',
      requestId,
      'lifecycle'
    );
  }
  return event;
}

// ── Metadata Assembly ─────────────────────────────────────────
// exactOptionalPropertyTypes: true requires conditional assignment —
// optional properties may only be assigned a concrete value, never
// `string | undefined` directly.

function buildMetadata(input: RawInput): EventMetadata {
  const metadata: EventMetadata = {
    sessionId: input.sessionId,
    userId:    input.userId,
  };

  switch (input.source) {
    case 'app':
      metadata.channel = 'app';
      break;

    case 'sms': {
      metadata.channel = 'sms';
      const sender   = extractString(input.body, 'sender');
      const threadId = extractString(input.body, 'threadId');
      if (sender !== undefined)   metadata.sender   = sender;
      if (threadId !== undefined) metadata.threadId = threadId;
      break;
    }

    case 'email':
      metadata.channel = 'email';
      if (input.normalizedEmail) {
        metadata.sender        = input.normalizedEmail.emailAddress;
        metadata.emailProvider = input.normalizedEmail.provider;
        if (input.normalizedEmail.threadId !== undefined) {
          metadata.threadId = input.normalizedEmail.threadId;
        }
      }
      break;

    case 'internal':
      metadata.channel = 'internal';
      break;

    case 'lifecycle':
      metadata.channel = 'lifecycle';
      break;
  }

  return metadata;
}

// ── Main Classifier ───────────────────────────────────────────

export function classifyEvent(input: RawInput): ProcessedEvent {
  const eventType = SOURCE_TO_EVENT_TYPE[input.source];

  let rawContent: string;

  switch (input.source) {
    case 'app':
      rawContent = extractAppContent(input.body, input.requestId);
      break;
    case 'sms':
      rawContent = extractSmsContent(input.body, input.requestId);
      break;
    case 'email':
      rawContent = extractEmailContent(input.normalizedEmail, input.requestId);
      break;
    case 'internal':
      rawContent = extractInternalContent(input.internalPayload, input.requestId);
      break;
    case 'lifecycle':
      rawContent = extractLifecycleContent(input.body, input.internalPayload, input.requestId);
      break;
    default: {
      const exhaustiveCheck: never = input.source;
      throw new ClassificationError(
        `Unrecognized source: ${String(exhaustiveCheck)}`,
        input.requestId,
        String(exhaustiveCheck)
      );
    }
  }

  const metadata = buildMetadata(input);

  // Log classification — no body content, no PII beyond session/request IDs
  console.info(
    `[EventClassifier] requestId=${input.requestId} source=${input.source} ` +
    `eventType=${eventType} sessionId=${input.sessionId}` +
    (metadata.emailProvider ? ` emailProvider=${metadata.emailProvider}` : '')
  );

  return {
    eventType,
    rawContent,
    metadata,
    timestamp: new Date().toISOString(),
  };
}
