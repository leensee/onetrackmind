// ============================================================
// OTM Comms — Provider/Adapter Contracts (Phase 4.1 foundation)
// The four provider-agnostic interfaces the Phase 4 comms layer
// is built on: EmailProvider, SmsProvider, EmailAuthProvider,
// NotificationAdapter (Decisions Log 2026-04-26, provider-
// agnostic abstraction lock). Contracts only — no concrete
// implementations here (Outlook/Graph = 4.2, Twilio = 4.4,
// Yahoo IMAP/SMTP = 4.5).
//
// Failure surfaces are typed results — return, never throw
// (Standing Principles §05). Implementations take an injected
// Logger (src/observability/logger) plus their transport
// clients per the Phase 2/3 DI pattern; nothing here performs
// I/O or logging.
//
// Inbound shapes surface exactly what comms_log ingest needs
// (Schema v1.2 + the landed DAL): provider message id, the
// thread-identity inputs (RFC 5322 chain + provider threading
// fields layered; subject excluded — thread identity decision),
// from/to identifiers verbatim, nullable subject, verbatim body,
// provider timestamp.
// Governing: Code Gen doc v2.4; Deployment Topology v1.1;
// Phase 4 architecture decisions 1–4, 10, 16.
// ============================================================

import {
  CommsChannel,
  CommsProvider,
  DeliveryState,
  FallbackLeg,
} from '../db/schemaConstants';

// ── Provider Names ────────────────────────────────────────────
// Narrowings of the schema vocabulary — comms_log.provider is the
// canonical enum; each contract binds the subset it can serve.

export type EmailProviderName = Exclude<CommsProvider, 'twilio'>; // 'outlook' | 'yahoo'
export type SmsProviderName = Extract<CommsProvider, 'twilio'>;

// ── Typed Results ─────────────────────────────────────────────
// House failure shape (flat, like MapResult) extended with what
// callers need to act on a provider failure: retryability and the
// verbatim provider error code when one exists.

export const COMMS_FAILURE_REASONS = [
  'auth_failed', // credential rejected; a refreshed credential may succeed
  'reauth_required', // credential cannot be refreshed without user interaction
  'rate_limited',
  'network', // transport-level failure — request may never have reached the provider
  'provider_error', // provider accepted the request and returned an error
  'invalid_input', // caller-supplied payload rejected before any provider call
  'not_supported', // operation outside this implementation's declared capabilities
] as const;

export type CommsFailureReason = (typeof COMMS_FAILURE_REASONS)[number];

export type CommsResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: CommsFailureReason;
      detail: string;
      retryable: boolean;
      providerCode: string | null;
    };

/** Result of an operation with no meaningful success payload. */
export type CommsOutcome = CommsResult<null>;

// ── Inbound Message Shapes ────────────────────────────────────

// Thread-identity inputs, per the locked thread identity model:
// RFC 5322 In-Reply-To/References chains + provider-supplied
// threading fields, layered. Subject is deliberately absent —
// replies and forwards mutate it. Resolution to a thread_key is
// the ingest pipeline's job (thread_mappings), not the provider's.
export interface EmailThreadingFields {
  rfc5322MessageId: string | null;
  inReplyTo: string | null;
  /** RFC 5322 References chain, oldest → newest. Empty when absent. */
  references: string[];
  /** e.g. Graph ConversationId; null when the provider supplies none (IMAP). */
  providerConversationId: string | null;
}

export interface InboundEmail {
  provider: EmailProviderName;
  /** null → ingest records idempotency_provenance 'content_hash_fallback'. */
  providerMessageId: string | null;
  threading: EmailThreadingFields;
  /** Verbatim as received — normalization is senderRecognizer's job. */
  fromIdentifier: string;
  toIdentifiers: string[];
  subject: string | null;
  /** Verbatim; empty string allowed. */
  body: string;
  /** ISO 8601 UTC; null when the provider omits one → ingest falls back to created_at. */
  providerTimestamp: string | null;
}

// SMS thread identity is the participant phone-pair — derivable
// from fromIdentifier + toIdentifiers, so no threading block.
// No cross-channel threading in v1.
export interface InboundSms {
  provider: SmsProviderName;
  providerMessageId: string | null;
  /** E.164, verbatim as received. */
  fromIdentifier: string;
  toIdentifiers: string[];
  body: string;
  providerTimestamp: string | null;
}

// ── Outbound Shapes ───────────────────────────────────────────

export interface OutboundEmail {
  toIdentifiers: string[];
  subject: string | null;
  body: string;
  /** RFC 5322 Message-ID being replied to; null for a new thread. */
  inReplyTo: string | null;
  /** References chain to send on the reply; empty for a new thread. */
  references: string[];
}

export interface OutboundSms {
  /** Single recipient per send, E.164. */
  toIdentifier: string;
  body: string;
}

export interface SendReceipt {
  /** null → caller records idempotency_provenance 'content_hash_fallback'. */
  providerMessageId: string | null;
  providerTimestamp: string | null;
}

// Carrier for provider delivery-state callbacks (Twilio status
// callbacks, Graph delivery receipts) → comms_log delivery fields.
export interface DeliveryStatusUpdate {
  providerMessageId: string;
  deliveryState: DeliveryState;
  deliveryDetail: string | null;
  providerTimestamp: string | null;
}

// ── EmailProvider ─────────────────────────────────────────────

/**
 * Opaque provider resume position, persisted verbatim to
 * polling_state.cursor (JSON). Owned by the adapter that produced
 * it — callers never interpret it (e.g. IMAP stores
 * {uidValidity, lastSeenUid}).
 */
export type PollCursor = Record<string, unknown>;

export interface InboundEmailBatch {
  messages: InboundEmail[];
  /** Next resume position; null when the provider has none to offer. */
  cursor: PollCursor | null;
}

export interface EmailProvider {
  readonly provider: EmailProviderName;
  send(email: OutboundEmail): Promise<CommsResult<SendReceipt>>;
  /** Materializes one message — e.g. resolving a Graph change notification's id. */
  fetchMessage(providerMessageId: string): Promise<CommsResult<InboundEmail>>;
  /** Polling read: everything new since cursor (null = cold start). */
  fetchNew(cursor: PollCursor | null): Promise<CommsResult<InboundEmailBatch>>;
}

// ── SmsProvider ───────────────────────────────────────────────

export interface SmsProvider {
  readonly provider: SmsProviderName;
  send(sms: OutboundSms): Promise<CommsResult<SendReceipt>>;
}

// ── EmailAuthProvider ─────────────────────────────────────────
// Auth-mechanism-agnostic (decision 3): the same surface serves
// OAuth (Graph) and app-password (Yahoo). Refresh is the
// implementation's business — getCredential returns a currently
// usable credential or a typed failure ('reauth_required' when
// user interaction is the only way forward).

export const CREDENTIAL_MECHANISMS = ['oauth_bearer', 'app_password'] as const;

export type CredentialMechanism = (typeof CREDENTIAL_MECHANISMS)[number];

// Carries live secrets. Never pass a credential (or its token/
// password fields) to Logger fields, diagnostic metadata, or any
// serialized output — log the mechanism and expiresAt at most.
export type EmailCredential =
  | { mechanism: 'oauth_bearer'; accessToken: string; expiresAt: string | null }
  | { mechanism: 'app_password'; username: string; password: string };

export interface EmailAuthProvider {
  readonly provider: EmailProviderName;
  getCredential(): Promise<CommsResult<EmailCredential>>;
  /** Marks the current credential bad (e.g. after a provider 401) so the next getCredential refreshes. */
  invalidateCredential(): Promise<CommsOutcome>;
}

// ── NotificationAdapter ───────────────────────────────────────
// Tiered with capability flags — the flag lives on the adapter
// type, not the provider (decision 4). One interface covers both
// notification directions:
//   - arrival signals (provider → backend): Graph push
//     subscriptions (finite lifetime, ~3-day renewal), Twilio
//     webhooks, IMAP IDLE with interval-polling fallback;
//   - user-notification dispatch (backend → user/device): the
//     decision-16 fallback chain — [sms, fcm] active, email leg
//     declared but stubbed until 4.5 completes outbound sending.
// Operations outside an adapter's declared capabilities return
// the typed 'not_supported' failure — capability flags tell
// callers what is safe to invoke.

export const NOTIFICATION_TIERS = ['push', 'poll'] as const;

export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

export interface NotificationCapabilities {
  /** 'push' = signals arrive unprompted (webhook/subscription/FCM); 'poll' = adapter must go looking. */
  tier: NotificationTier;
  /** start/stop surface is live — the adapter produces MessageArrival signals. */
  signalsArrivals: boolean;
  /** Subscription has a finite lifetime (Graph ~3 days) — renew() must be scheduled. */
  requiresRenewal: boolean;
  /** Poll tier only: long-lived IDLE connection preferred, interval polling as fallback. */
  supportsIdle: boolean;
  /** Non-null → adapter carries user notifications as this fallback-chain leg. */
  dispatchLeg: FallbackLeg | null;
}

// Arrival signal. Push signals may carry only an id (Graph change
// notification → fetch via EmailProvider.fetchMessage) or the
// fully materialized message (Twilio inbound webhook).
export interface MessageArrival {
  provider: CommsProvider;
  channel: CommsChannel;
  providerMessageId: string | null;
  /** Materialized message when the signal carries one; null → fetch through the provider interface. */
  message: InboundEmail | InboundSms | null;
  /** ISO 8601 UTC — when the adapter observed the signal. */
  receivedAt: string;
}

export type MessageArrivalHandler = (arrival: MessageArrival) => Promise<void>;

export interface SubscriptionState {
  active: boolean;
  /** ISO 8601 UTC; null when the subscription does not expire. */
  expiresAt: string | null;
}

// What the fallback-chain executor (4.4) hands a dispatch-capable
// leg. Leg-appropriate rendering (FCM encrypted payload per the
// Phase 2 outputRouter contract, SMS formatting) is the
// implementation's business.
export interface UserNotification {
  title: string;
  body: string;
  /** Structured content for payload-capable legs (FCM); null for plain-text legs. */
  payload: Record<string, unknown> | null;
}

export interface DispatchReceipt {
  /** Which leg carried it — recorded on comms_log.fallback_leg_used when a fallback leg fired. */
  leg: FallbackLeg;
  providerMessageId: string | null;
}

export interface NotificationAdapter {
  /** Stable adapter identity for logs/diagnostics, e.g. 'outlook_graph_push'. */
  readonly id: string;
  readonly capabilities: NotificationCapabilities;

  // Arrival surface — live when capabilities.signalsArrivals.
  // start() acquires the signal source (webhook subscription, IDLE
  // connection, or internal polling loop); stop() releases it.
  start(onArrival: MessageArrivalHandler): Promise<CommsOutcome>;
  stop(): Promise<CommsOutcome>;
  /** Renews a finite-lifetime subscription — live when capabilities.requiresRenewal. */
  renew(): Promise<CommsResult<SubscriptionState>>;

  // Dispatch surface — live when capabilities.dispatchLeg ≠ null.
  dispatch(notification: UserNotification): Promise<CommsResult<DispatchReceipt>>;
}
