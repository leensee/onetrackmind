// ============================================================
// OTM Orchestration — Crypto Utilities
// AES-256-GCM encryption for FCM payload content.
// Node.js built-in crypto only — no third-party dependencies.
// Key must be a 64-char hex string (32 bytes).
// IV is randomly generated per encryption — never reused.
// ============================================================

import { createCipheriv, randomBytes } from 'crypto';

export interface EncryptedContent {
  iv:         string;   // 12-byte random IV, hex-encoded
  authTag:    string;   // 16-byte GCM auth tag, hex-encoded
  ciphertext: string;   // encrypted content, hex-encoded
}

// Validates key is a 64-char hex string (32 bytes for AES-256).
// Throws immediately on misconfiguration — never silently degrades.
export function validateKeyHex(keyHex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'FCM_PAYLOAD_KEY must be a 64-character hex string (32 bytes for AES-256-GCM)'
    );
  }
}

export function encryptPayloadContent(
  plaintext: string,
  keyHex:    string
): EncryptedContent {
  validateKeyHex(keyHex);

  const key = Buffer.from(keyHex, 'hex');
  const iv  = randomBytes(12);   // 96-bit IV — GCM standard

  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    iv:         iv.toString('hex'),
    authTag:    authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

// ============================================================
// OTM Orchestration — Output Router
// Takes audited, approved response text and routes it to the
// correct channel with correct formatting applied.
// Channel-specific clients are injected — never constructed here.
// Primary call always produces app-formatted output. Router
// transforms for the channel.
// ============================================================

import {
  RouteInstruction,
  RouteResult,
  FailedRecipient,
} from './types';

// ── Constants ─────────────────────────────────────────────────

export const SMS_MAX_CHARS        = 1_600;
export const PUSH_BODY_MAX_CHARS  = 200;

// ── Injected Client Types ─────────────────────────────────────
// Router never constructs clients — all injected by orchestrator.

export type SmsSend   = (to: string, body: string) => Promise<void>;
export type PushSend  = (token: string, payload: Record<string, unknown>) => Promise<void>;
export type AppWsSend = (payload: Record<string, unknown>) => Promise<void>;

export interface RouterClients {
  appWsSend?:    AppWsSend;
  smsSend?:      SmsSend;
  pushSend?:     PushSend;
  fcmPayloadKey?: string;   // injected from FCM_PAYLOAD_KEY env var by orchestrator
}

// ── Output Router Error ───────────────────────────────────────

export class OutputRouterError extends Error {
  public readonly requestId: string;
  public readonly channel:   string;
  public readonly cause:     'format_error' | 'delivery_error' | 'no_recipients';

  constructor(
    message:   string,
    requestId: string,
    channel:   string,
    cause:     'format_error' | 'delivery_error' | 'no_recipients'
  ) {
    super(message);
    this.name      = 'OutputRouterError';
    this.requestId = requestId;
    this.channel   = channel;
    this.cause     = cause;
  }
}

// ── SMS Formatter ─────────────────────────────────────────────
// Pure function — exported for testing.
// Returns string[] — one element per SMS segment.
// Each segment ≤ SMS_MAX_CHARS.
// Sentence-boundary split with hard-truncation fallback.

export function formatForSms(text: string): string[] {
  // Step 1: Strip markdown
  const stripped = text
    .replace(/^#{1,6}\s+/gm, '')       // headers
    .replace(/\*\*/g, '')               // bold
    .replace(/\*/g, '')                 // italic
    .replace(/`{1,3}/g, '')            // code ticks
    .replace(/^\|.*\|$/gm, '')         // table rows
    .replace(/^[-*]\s+/gm, '')         // list markers
    .replace(/\n{3,}/g, '\n\n')        // collapse excess newlines
    .trim();

  // Step 2: Split into SMS_MAX_CHARS segments at sentence boundaries
  const segments: string[] = [];
  let remaining = stripped;

  while (remaining.length > 0) {
    if (remaining.length <= SMS_MAX_CHARS) {
      segments.push(remaining.trim());
      break;
    }

    // Find last sentence boundary at or before SMS_MAX_CHARS
    const window = remaining.substring(0, SMS_MAX_CHARS);
    const lastBoundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf('.\n'),
      window.lastIndexOf('?\n'),
      window.lastIndexOf('!\n'),
    );

    if (lastBoundary > 0) {
      // Include the punctuation character, cut after it
      const cutPoint = lastBoundary + 1;
      segments.push(remaining.substring(0, cutPoint).trim());
      remaining = remaining.substring(cutPoint).trim();
    } else {
      // Hard fallback: no sentence boundary found — truncate at limit
      segments.push(remaining.substring(0, SMS_MAX_CHARS).trim() + '…');
      remaining = remaining.substring(SMS_MAX_CHARS).trim();
    }
  }

  return segments.filter(s => s.length > 0);
}

// ── Push Formatter ────────────────────────────────────────────
// Pure function — exported for testing.
// Produces FCM-compatible payload.

export function formatForPush(
  text:          string,
  sessionId:     string,
  fcmPayloadKey?: string
): Record<string, unknown> {
  let encryptedContent: EncryptedContent | undefined;

  if (fcmPayloadKey) {
    try {
      encryptedContent = encryptPayloadContent(text, fcmPayloadKey);
    } catch (err) {
      // Encryption failed — omit fullContent, notification still fires.
      // Never transmit plaintext on key failure.
      console.error(
        `[OutputRouter] FCM payload encryption failed — fullContent omitted: ` +
        `${(err as Error).message}`
      );
    }
  } else {
    // Key not configured — omit fullContent, notification still fires.
    console.warn(
      '[OutputRouter] FCM_PAYLOAD_KEY not configured — fullContent omitted from push payload.'
    );
  }

  const data: Record<string, unknown> = { sessionId };
  if (encryptedContent) {
    data['encryptedContent'] = encryptedContent;
  }

  return {
    notification: {
      title: 'OneTrackMind',
      body:  text.substring(0, PUSH_BODY_MAX_CHARS),
    },
    data,
  };
}

// ── Channel Route Functions ───────────────────────────────────

export async function routeToApp(
  responseText: string,
  instruction:  RouteInstruction,
  appWsSend:    AppWsSend
): Promise<RouteResult> {
  try {
    await appWsSend({ type: 'response', content: responseText });
    return {
      channel:      'app',
      success:      true,
      delivered:    ['app'],
      failed:       [],
      segmentCount: 1,
      requestId:    instruction.requestId,
    };
  } catch (err) {
    return {
      channel:      'app',
      success:      false,
      delivered:    [],
      failed:       [{ recipient: 'app', reason: (err as Error).message }],
      segmentCount: 0,
      requestId:    instruction.requestId,
    };
  }
}

export async function routeToSms(
  responseText: string,
  instruction:  RouteInstruction,
  smsSend:      SmsSend
): Promise<RouteResult> {
  const { recipients, requestId } = instruction;

  if (!recipients || recipients.length === 0) {
    throw new OutputRouterError(
      'SMS route requires at least one recipient',
      requestId,
      'sms',
      'no_recipients'
    );
  }

  const segments = formatForSms(responseText);
  const delivered: string[] = [];
  const failed: FailedRecipient[] = [];

  // Per-recipient: send all segments sequentially.
  // One recipient failing does not abort others.
  for (const recipient of recipients) {
    let recipientFailed = false;

    for (const segment of segments) {
      try {
        await smsSend(recipient, segment);
      } catch (err) {
        failed.push({ recipient, reason: (err as Error).message });
        recipientFailed = true;
        break; // Stop sending segments to this recipient on failure
      }
    }

    if (!recipientFailed) {
      delivered.push(recipient);
    }
  }

  return {
    channel:      'sms',
    success:      failed.length === 0,
    delivered,
    failed,
    segmentCount: segments.length,
    requestId,
  };
}

export async function routeToPush(
  responseText: string,
  instruction:  RouteInstruction,
  pushSend:     PushSend,
  fcmPayloadKey?: string
): Promise<RouteResult> {
  const { recipients, requestId } = instruction;

  if (!recipients || recipients.length === 0) {
    throw new OutputRouterError(
      'Push route requires at least one FCM token',
      requestId,
      'push',
      'no_recipients'
    );
  }

  const payload  = formatForPush(responseText, instruction.sessionId, fcmPayloadKey);
  const delivered: string[] = [];
  const failed: FailedRecipient[] = [];

  for (const token of recipients) {
    try {
      await pushSend(token, payload);
      delivered.push(token);
    } catch (err) {
      failed.push({ recipient: token, reason: (err as Error).message });
    }
  }

  return {
    channel:      'push',
    success:      failed.length === 0,
    delivered,
    failed,
    segmentCount: 1,
    requestId,
  };
}

export function routeToLog(instruction: RouteInstruction): RouteResult {
  console.info(
    `[OutputRouter] log-only requestId=${instruction.requestId} ` +
    `sessionId=${instruction.sessionId}`
  );
  return {
    channel:      'log',
    success:      true,
    delivered:    ['log'],
    failed:       [],
    segmentCount: 1,
    requestId:    instruction.requestId,
  };
}

// ── Main Entry Point ──────────────────────────────────────────

export async function routeOutput(
  responseText: string,
  instruction:  RouteInstruction,
  clients:      RouterClients
): Promise<RouteResult> {
  const { channel, requestId } = instruction;

  switch (channel) {
    case 'app': {
      if (!clients.appWsSend) {
        throw new OutputRouterError(
          'appWsSend client required for app channel',
          requestId, 'app', 'delivery_error'
        );
      }
      return routeToApp(responseText, instruction, clients.appWsSend);
    }

    case 'sms': {
      if (!clients.smsSend) {
        throw new OutputRouterError(
          'smsSend client required for sms channel',
          requestId, 'sms', 'delivery_error'
        );
      }
      return routeToSms(responseText, instruction, clients.smsSend);
    }

    case 'push': {
      if (!clients.pushSend) {
        throw new OutputRouterError(
          'pushSend client required for push channel',
          requestId, 'push', 'delivery_error'
        );
      }
      return routeToPush(responseText, instruction, clients.pushSend, clients.fcmPayloadKey);
    }

    case 'log':
      return routeToLog(instruction);

    default: {
      const exhaustiveCheck: never = channel;
      throw new OutputRouterError(
        `Unrecognized channel: ${String(exhaustiveCheck)}`,
        requestId, String(exhaustiveCheck), 'delivery_error'
      );
    }
  }
}
