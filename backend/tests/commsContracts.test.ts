// ============================================================
// Tests: comms/contracts.ts — Phase 4 provider/adapter contracts
// Contracts are types, so the load-bearing checks are
// compile-level: minimal mock implementations of all four
// interfaces prove each contract is satisfiable by its intended
// implementations (Graph push / IMAP poll / Twilio / FCM), and an
// ingest-shaped mapping proves InboundEmail surfaces every field
// comms_log needs (it would not typecheck against CommsLogDomain
// otherwise). Runtime asserts cover the vocabulary constants and
// the typed not_supported convention.
// Run via: npm run test:comms-contracts
// ============================================================

import {
  COMMS_FAILURE_REASONS,
  CREDENTIAL_MECHANISMS,
  CommsOutcome,
  CommsResult,
  DispatchReceipt,
  EmailAuthProvider,
  EmailCredential,
  EmailProvider,
  InboundEmail,
  InboundEmailBatch,
  MessageArrivalHandler,
  NOTIFICATION_TIERS,
  NotificationAdapter,
  OutboundEmail,
  OutboundSms,
  PollCursor,
  SendReceipt,
  SmsProvider,
  SubscriptionState,
  UserNotification,
} from '../src/comms/contracts';
import { CommsLogDomain } from '../src/db/mapping/commsLog';
import { FallbackLeg, TriageLabel } from '../src/db/schemaConstants';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Shared mock results ───────────────────────────────────────

const NOT_SUPPORTED = {
  ok: false,
  reason: 'not_supported',
  detail: 'outside declared capabilities',
  retryable: false,
  providerCode: null,
} as const;

const OK_NULL: CommsOutcome = { ok: true, value: null };

const RECEIPT: SendReceipt = {
  providerMessageId: 'prov-msg-1',
  providerTimestamp: '2026-07-09T12:00:00Z',
};

// ── Mock EmailProvider (satisfiable by Graph and IMAP alike) ──

const SAMPLE_INBOUND: InboundEmail = {
  provider: 'outlook',
  providerMessageId: 'AAMk-123',
  threading: {
    rfc5322MessageId: '<msg-1@example.com>',
    inReplyTo: '<msg-0@example.com>',
    references: ['<msg-0@example.com>'],
    providerConversationId: 'conv-1',
  },
  fromIdentifier: 'dispatch@example.com',
  toIdentifiers: ['kurt@example.com'],
  subject: 'Load 4417',
  body: 'Pickup moved to 06:00.',
  providerTimestamp: '2026-07-09T11:58:03Z',
};

const mockEmailProvider: EmailProvider = {
  provider: 'outlook',
  async send(_email: OutboundEmail): Promise<CommsResult<SendReceipt>> {
    return { ok: true, value: RECEIPT };
  },
  async fetchMessage(providerMessageId: string): Promise<CommsResult<InboundEmail>> {
    return { ok: true, value: { ...SAMPLE_INBOUND, providerMessageId } };
  },
  async fetchNew(cursor: PollCursor | null): Promise<CommsResult<InboundEmailBatch>> {
    return {
      ok: true,
      value: {
        messages: [SAMPLE_INBOUND],
        cursor: cursor ?? { uidValidity: 7, lastSeenUid: 42 },
      },
    };
  },
};

// ── Mock SmsProvider ──────────────────────────────────────────

const mockSmsProvider: SmsProvider = {
  provider: 'twilio',
  async send(_sms: OutboundSms): Promise<CommsResult<SendReceipt>> {
    return { ok: true, value: RECEIPT };
  },
};

// ── Mock EmailAuthProviders — both mechanisms, one surface ────

function mockAuth(provider: 'outlook' | 'yahoo', credential: EmailCredential): EmailAuthProvider {
  return {
    provider,
    async getCredential(): Promise<CommsResult<EmailCredential>> {
      return { ok: true, value: credential };
    },
    async invalidateCredential(): Promise<CommsOutcome> {
      return OK_NULL;
    },
  };
}

const graphAuth = mockAuth('outlook', {
  mechanism: 'oauth_bearer',
  accessToken: 'tok',
  expiresAt: '2026-07-09T13:00:00Z',
});
const yahooAuth = mockAuth('yahoo', {
  mechanism: 'app_password',
  username: 'kurt@example.com',
  password: 'app-pass',
});

// ── Mock NotificationAdapters — the three intended shapes ─────

// Graph push subscription: push tier, arrival surface, finite
// lifetime (~3-day renewal), no dispatch leg.
const graphPushAdapter: NotificationAdapter = {
  id: 'outlook_graph_push',
  capabilities: {
    tier: 'push',
    signalsArrivals: true,
    requiresRenewal: true,
    supportsIdle: false,
    dispatchLeg: null,
  },
  async start(_onArrival: MessageArrivalHandler): Promise<CommsOutcome> {
    return OK_NULL;
  },
  async stop(): Promise<CommsOutcome> {
    return OK_NULL;
  },
  async renew(): Promise<CommsResult<SubscriptionState>> {
    return { ok: true, value: { active: true, expiresAt: '2026-07-12T12:00:00Z' } };
  },
  async dispatch(_n: UserNotification): Promise<CommsResult<DispatchReceipt>> {
    return NOT_SUPPORTED;
  },
};

// Yahoo IMAP: poll tier, IDLE preferred with interval-polling
// fallback, nothing to renew, no dispatch leg.
const imapPollAdapter: NotificationAdapter = {
  id: 'yahoo_imap_poll',
  capabilities: {
    tier: 'poll',
    signalsArrivals: true,
    requiresRenewal: false,
    supportsIdle: true,
    dispatchLeg: null,
  },
  async start(_onArrival: MessageArrivalHandler): Promise<CommsOutcome> {
    return OK_NULL;
  },
  async stop(): Promise<CommsOutcome> {
    return OK_NULL;
  },
  async renew(): Promise<CommsResult<SubscriptionState>> {
    return NOT_SUPPORTED;
  },
  async dispatch(_n: UserNotification): Promise<CommsResult<DispatchReceipt>> {
    return NOT_SUPPORTED;
  },
};

// FCM: dispatch-only leg of the decision-16 fallback chain.
function dispatchOnlyAdapter(id: string, leg: FallbackLeg, stubbed: boolean): NotificationAdapter {
  return {
    id,
    capabilities: {
      tier: 'push',
      signalsArrivals: false,
      requiresRenewal: false,
      supportsIdle: false,
      dispatchLeg: leg,
    },
    async start(): Promise<CommsOutcome> {
      return NOT_SUPPORTED;
    },
    async stop(): Promise<CommsOutcome> {
      return NOT_SUPPORTED;
    },
    async renew(): Promise<CommsResult<SubscriptionState>> {
      return NOT_SUPPORTED;
    },
    async dispatch(_n: UserNotification): Promise<CommsResult<DispatchReceipt>> {
      if (stubbed) return NOT_SUPPORTED; // email leg: declared, inactive until 4.5
      return { ok: true, value: { leg, providerMessageId: null } };
    },
  };
}

const fcmAdapter = dispatchOnlyAdapter('fcm_dispatch', 'fcm', false);
const smsLegAdapter = dispatchOnlyAdapter('sms_leg', 'sms', false);
const emailStubAdapter = dispatchOnlyAdapter('email_leg_stub', 'email', true);

// ── Ingest-shaped mapping: InboundEmail covers comms_log needs ──
// If InboundEmail lacked any field comms_log ingest requires,
// this function would not typecheck against CommsLogDomain.

function toInboundCommsLogDomain(
  m: InboundEmail,
  resolved: { id: string; createdAt: string; threadKey: string; contentHash: string; triageLabel: TriageLabel }
): CommsLogDomain {
  return {
    id: resolved.id,
    createdAt: resolved.createdAt,
    provider: m.provider,
    channel: 'email',
    direction: 'inbound',
    providerMessageId: m.providerMessageId,
    idempotencyProvenance: m.providerMessageId === null ? 'content_hash_fallback' : 'provider_id',
    contentHash: resolved.contentHash,
    threadKey: resolved.threadKey,
    fromIdentifier: m.fromIdentifier,
    toIdentifiers: m.toIdentifiers,
    subject: m.subject,
    body: m.body,
    providerTimestamp: m.providerTimestamp ?? resolved.createdAt,
    contactId: null,
    topicTag: null,
    triageLabel: resolved.triageLabel,
    timeSensitivityFlag: 'none',
    deliveryState: null,
    deliveryDetail: null,
    fallbackLegUsed: null,
    isSynced: false,
    userAcknowledgedAt: null,
    userActionTaken: null,
  };
}

async function runTests(): Promise<void> {
  // ── Vocabulary constants ────────────────────────────────────
  console.log('\n[contracts] vocabulary');
  assert(
    NOTIFICATION_TIERS.length === 2 && NOTIFICATION_TIERS.includes('push') && NOTIFICATION_TIERS.includes('poll'),
    'NOTIFICATION_TIERS = push, poll'
  );
  assert(
    CREDENTIAL_MECHANISMS.length === 2 &&
      CREDENTIAL_MECHANISMS.includes('oauth_bearer') &&
      CREDENTIAL_MECHANISMS.includes('app_password'),
    'CREDENTIAL_MECHANISMS = oauth_bearer, app_password'
  );
  assert(
    (['auth_failed', 'reauth_required', 'rate_limited', 'network', 'provider_error', 'invalid_input', 'not_supported'] as const)
      .every((r) => (COMMS_FAILURE_REASONS as readonly string[]).includes(r)),
    'COMMS_FAILURE_REASONS carries the full reason set'
  );

  // ── EmailProvider / SmsProvider mocks behave ────────────────
  console.log('\n[contracts] provider mocks');
  const sent = await mockEmailProvider.send({
    toIdentifiers: ['dispatch@example.com'],
    subject: 'Re: Load 4417',
    body: 'Confirmed.',
    inReplyTo: '<msg-1@example.com>',
    references: ['<msg-0@example.com>', '<msg-1@example.com>'],
  });
  assert(sent.ok && sent.value.providerMessageId === 'prov-msg-1', 'EmailProvider.send returns a typed receipt');

  const batch = await mockEmailProvider.fetchNew(null);
  assert(
    batch.ok && batch.value.messages.length === 1 && batch.value.cursor !== null,
    'EmailProvider.fetchNew cold start returns messages + opaque cursor'
  );

  const smsSent = await mockSmsProvider.send({ toIdentifier: '+15550100', body: 'ok' });
  assert(smsSent.ok, 'SmsProvider.send returns a typed receipt');

  // ── EmailAuthProvider — mechanism-agnostic union ────────────
  console.log('\n[contracts] auth mechanisms');
  const graphCred = await graphAuth.getCredential();
  assert(
    graphCred.ok && graphCred.value.mechanism === 'oauth_bearer' && graphCred.value.accessToken === 'tok',
    'oauth_bearer credential narrows by mechanism'
  );
  const yahooCred = await yahooAuth.getCredential();
  assert(
    yahooCred.ok && yahooCred.value.mechanism === 'app_password' && yahooCred.value.username === 'kurt@example.com',
    'app_password credential narrows by mechanism'
  );
  assert((await graphAuth.invalidateCredential()).ok, 'invalidateCredential returns a typed outcome');

  // ── NotificationAdapter capability tiers ────────────────────
  console.log('\n[contracts] notification adapter tiers');
  assert(
    graphPushAdapter.capabilities.tier === 'push' && graphPushAdapter.capabilities.requiresRenewal,
    'Graph push adapter: push tier, renewal required'
  );
  const renewed = await graphPushAdapter.renew();
  assert(
    renewed.ok && renewed.value.expiresAt !== null,
    'Graph renew() reports the finite subscription lifetime'
  );
  assert(
    imapPollAdapter.capabilities.tier === 'poll' && imapPollAdapter.capabilities.supportsIdle,
    'IMAP adapter: poll tier with IDLE upgrade'
  );
  const imapRenew = await imapPollAdapter.renew();
  assert(
    !imapRenew.ok && imapRenew.reason === 'not_supported',
    'operations outside capabilities return typed not_supported'
  );
  const pushDispatch = await graphPushAdapter.dispatch({ title: 't', body: 'b', payload: null });
  assert(
    !pushDispatch.ok && pushDispatch.reason === 'not_supported',
    'arrival-only adapter refuses dispatch with typed not_supported'
  );

  // ── Decision-16 fallback chain is expressible ───────────────
  console.log('\n[contracts] fallback chain [sms, fcm] + email stub');
  const chain: NotificationAdapter[] = [smsLegAdapter, fcmAdapter, emailStubAdapter];
  const activeLegs = chain
    .filter((a) => a.capabilities.dispatchLeg !== null)
    .map((a) => a.capabilities.dispatchLeg);
  assert(
    activeLegs.length === 3 && activeLegs[0] === 'sms' && activeLegs[1] === 'fcm' && activeLegs[2] === 'email',
    'chain declares legs in order sms → fcm → email'
  );
  const fcmReceipt = await fcmAdapter.dispatch({ title: 'OTM', body: 'Load 4417 update', payload: { commsLogId: 'x' } });
  assert(fcmReceipt.ok && fcmReceipt.value.leg === 'fcm', 'FCM leg dispatch returns its FallbackLeg for comms_log');
  const emailAttempt = await emailStubAdapter.dispatch({ title: 'OTM', body: 'b', payload: null });
  assert(!emailAttempt.ok && emailAttempt.reason === 'not_supported', 'email leg stub declared but inactive until 4.5');

  // ── InboundEmail → comms_log inbound field coverage ─────────
  console.log('\n[contracts] inbound comms_log coverage');
  const domain = toInboundCommsLogDomain(SAMPLE_INBOUND, {
    id: 'row-1',
    createdAt: '2026-07-09T12:00:00Z',
    threadKey: 'thread-1',
    contentHash: 'hash-1',
    triageLabel: 'action_required',
  });
  assert(domain.providerMessageId === 'AAMk-123', 'provider message id surfaces');
  assert(domain.subject === 'Load 4417' && domain.body === 'Pickup moved to 06:00.', 'nullable subject + verbatim body surface');
  assert(domain.providerTimestamp === '2026-07-09T11:58:03Z', 'provider timestamp surfaces');
  assert(domain.idempotencyProvenance === 'provider_id', 'provenance derives from provider message id presence');

  const noTimestamp = toInboundCommsLogDomain(
    { ...SAMPLE_INBOUND, providerMessageId: null, providerTimestamp: null },
    { id: 'row-2', createdAt: '2026-07-09T12:00:00Z', threadKey: 'thread-1', contentHash: 'hash-2', triageLabel: 'unclear_review' }
  );
  assert(noTimestamp.providerTimestamp === '2026-07-09T12:00:00Z', 'omitted provider timestamp falls back to created_at');
  assert(noTimestamp.idempotencyProvenance === 'content_hash_fallback', 'null provider message id → content_hash_fallback');

  // Threading inputs present for thread_mappings resolution — subject not among them.
  const threadingKeys = Object.keys(SAMPLE_INBOUND.threading).sort();
  assert(
    threadingKeys.join(',') === 'inReplyTo,providerConversationId,references,rfc5322MessageId',
    'threading = RFC 5322 chain + provider conversation id, subject excluded'
  );

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n[contracts] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
