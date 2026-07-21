import 'dart:convert';

/// Queue entry for the capture path. JSON keys are snake_case, Dart fields
/// camelCase — the same data-access-boundary mapping the backend uses.
///
/// `payloadKind` is the discriminator ('audio' | 'text') — per the locked
/// design, the payload shape is the **only** seam in the capture path: no
/// transcription-engine interface, no trigger interface, no noise-handling
/// seam. Trigger source is metadata on the single capture entry point.
class CaptureEntry {
  static const schema = 'otm-capture-entry.v1';

  final String id;
  final String payloadKind; // 'audio' | 'text'
  final String triggerSource;
  final String originTimestamp; // ISO-8601 UTC
  final Map<String, dynamic> deviceProvenance;
  final String sessionId;
  final String armLabel;
  final String? utteranceId;
  final String? audioFile; // relative filename; null iff payloadKind == 'text'
  final String? text; // null iff payloadKind == 'audio'
  final Map<String, dynamic>? audioFormat;
  final Map<String, dynamic> captureMetadata;
  final int isSynced; // 0 on write; 1 after confirmed receipt (house vocabulary)
  final int attemptCount;
  final String? lastAttemptAt;
  final String? nextAttemptAt;
  final Map<String, dynamic>? lastFailure; // {reason, detail, retryable}

  const CaptureEntry({
    required this.id,
    required this.payloadKind,
    required this.triggerSource,
    required this.originTimestamp,
    required this.deviceProvenance,
    required this.sessionId,
    required this.armLabel,
    this.utteranceId,
    this.audioFile,
    this.text,
    this.audioFormat,
    required this.captureMetadata,
    this.isSynced = 0,
    this.attemptCount = 0,
    this.lastAttemptAt,
    this.nextAttemptAt,
    this.lastFailure,
  });

  CaptureEntry copyWith({
    int? isSynced,
    int? attemptCount,
    String? lastAttemptAt,
    String? nextAttemptAt,
    Map<String, dynamic>? lastFailure,
    bool clearLastFailure = false,
  }) {
    return CaptureEntry(
      id: id,
      payloadKind: payloadKind,
      triggerSource: triggerSource,
      originTimestamp: originTimestamp,
      deviceProvenance: deviceProvenance,
      sessionId: sessionId,
      armLabel: armLabel,
      utteranceId: utteranceId,
      audioFile: audioFile,
      text: text,
      audioFormat: audioFormat,
      captureMetadata: captureMetadata,
      isSynced: isSynced ?? this.isSynced,
      attemptCount: attemptCount ?? this.attemptCount,
      lastAttemptAt: lastAttemptAt ?? this.lastAttemptAt,
      nextAttemptAt: nextAttemptAt ?? this.nextAttemptAt,
      lastFailure: clearLastFailure ? null : (lastFailure ?? this.lastFailure),
    );
  }

  Map<String, dynamic> toJson() => {
        'schema': schema,
        'id': id,
        'payload_kind': payloadKind,
        'trigger_source': triggerSource,
        'origin_timestamp': originTimestamp,
        'device_provenance': deviceProvenance,
        'session_id': sessionId,
        'arm_label': armLabel,
        'utterance_id': utteranceId,
        'audio_file': audioFile,
        'text': text,
        'audio_format': audioFormat,
        'capture_metadata': captureMetadata,
        'is_synced': isSynced,
        'attempt_count': attemptCount,
        'last_attempt_at': lastAttemptAt,
        'next_attempt_at': nextAttemptAt,
        'last_failure': lastFailure,
      };

  factory CaptureEntry.fromJson(Map<String, dynamic> json) {
    return CaptureEntry(
      id: json['id'] as String,
      payloadKind: json['payload_kind'] as String,
      triggerSource: json['trigger_source'] as String,
      originTimestamp: json['origin_timestamp'] as String,
      deviceProvenance:
          (json['device_provenance'] as Map).cast<String, dynamic>(),
      sessionId: json['session_id'] as String,
      armLabel: json['arm_label'] as String,
      utteranceId: json['utterance_id'] as String?,
      audioFile: json['audio_file'] as String?,
      text: json['text'] as String?,
      audioFormat:
          (json['audio_format'] as Map?)?.cast<String, dynamic>(),
      captureMetadata:
          (json['capture_metadata'] as Map).cast<String, dynamic>(),
      isSynced: json['is_synced'] as int,
      attemptCount: json['attempt_count'] as int,
      lastAttemptAt: json['last_attempt_at'] as String?,
      nextAttemptAt: json['next_attempt_at'] as String?,
      lastFailure: (json['last_failure'] as Map?)?.cast<String, dynamic>(),
    );
  }

  String encode() => const JsonEncoder.withIndent('  ').convert(toJson());
}

/// Submission result mirroring the backend's CommsResult shape
/// (backend/src/comms/contracts.ts): discriminated, non-throwing.
class BenchSubmitResult<T> {
  final bool ok;
  final T? value;
  final String? reason; // auth_failed | invalid_input | storage_error | network
  final String? detail;
  final bool retryable;

  const BenchSubmitResult.success(T this.value)
      : ok = true,
        reason = null,
        detail = null,
        retryable = false;

  const BenchSubmitResult.failure({
    required String this.reason,
    required String this.detail,
    required this.retryable,
  })  : ok = false,
        value = null;
}

/// Bench settings, persisted as a JSON file in the storage dir — deliberately
/// not shared_preferences (no new plugin deps in the spike).
class BenchSettings {
  final String receiverUrl; // e.g. http://192.168.1.20:8787
  final String secret;
  final String sessionId;

  const BenchSettings({
    this.receiverUrl = '',
    this.secret = '',
    this.sessionId = 'dev-session',
  });

  Map<String, dynamic> toJson() => {
        'receiver_url': receiverUrl,
        'secret': secret,
        'session_id': sessionId,
      };

  factory BenchSettings.fromJson(Map<String, dynamic> json) => BenchSettings(
        receiverUrl: json['receiver_url'] as String? ?? '',
        secret: json['secret'] as String? ?? '',
        sessionId: json['session_id'] as String? ?? 'dev-session',
      );
}
