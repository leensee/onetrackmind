import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'capture_channel.dart';
import 'models.dart';
import 'submit_client.dart';

/// File-based capture queue: capture → local queue → submit → confirm →
/// dequeue, in all connectivity states. The queue is where retry state,
/// origin timestamp, and device provenance live — the harness exercises this
/// real path, never a direct synchronous submit.
///
/// NOT A PRECEDENT (§10 bench-exception ruling, 2026-07-21): this spike queue
/// is JSON sidecars + files with iOS complete file protection applied
/// explicitly. The PRODUCT capture queue uses SQLCipher-encrypted SQLite per
/// Security & Compliance Policy §3.3, unchanged.
///
/// Layout: <storage>/capture-queue/<entryId>/entry.json [+ audio.wav]
/// Lifecycle mirrors the house `is_synced` vocabulary: written 0, flipped to
/// 1 on confirmed receipt. On confirm the audio file is deleted immediately
/// (device-side zero retention); the metadata sidecar is retained — pending
/// rows are never purged, in the schema convention's spirit.
class CaptureQueue {
  final Directory root;
  final CaptureChannel channel;
  final SubmitClient client;
  final BenchSettings Function() settings;
  final void Function(String line) log;

  Timer? _drainTimer;
  bool _draining = false;
  bool _foreground = true;

  CaptureQueue({
    required this.root,
    required this.channel,
    required this.client,
    required this.settings,
    required this.log,
  });

  static Future<CaptureQueue> open({
    required CaptureChannel channel,
    required SubmitClient client,
    required BenchSettings Function() settings,
    required void Function(String line) log,
  }) async {
    final storage = await channel.getStorageDir();
    final root = Directory('$storage/capture-queue');
    await root.create(recursive: true);
    return CaptureQueue(
      root: root,
      channel: channel,
      client: client,
      settings: settings,
      log: log,
    );
  }

  // ── Enqueue ────────────────────────────────────────────────

  /// Enqueues a stopped capture (the stopCapture result map). Moves the audio
  /// file into the entry directory and applies complete file protection.
  /// Arm label and utterance id come from the Swift-recorded metadata, not
  /// from UI state — the log is authoritative over intent.
  Future<CaptureEntry> enqueueAudio({
    required Map<String, dynamic> stopResult,
    required String sessionId,
  }) async {
    final metadata =
        (stopResult['captureMetadata'] as Map).cast<String, dynamic>();
    final format = (metadata['format'] as Map?)?.cast<String, dynamic>();
    final fileFormat = (format?['file'] as Map?)?.cast<String, dynamic>();
    final armLabel = metadata['arm_label'] as String? ?? 'unlabeled';
    final utteranceId = metadata['utterance_id'] as String?;
    final entry = CaptureEntry(
      id: stopResult['captureId'] as String,
      payloadKind: 'audio',
      triggerSource: metadata['trigger_source'] as String? ?? 'ui-button',
      originTimestamp: stopResult['originTimestamp'] as String,
      deviceProvenance:
          (metadata['device_provenance'] as Map?)?.cast<String, dynamic>() ??
              {},
      sessionId: sessionId,
      armLabel: armLabel,
      utteranceId: utteranceId,
      audioFile: 'audio.wav',
      audioFormat: fileFormat,
      captureMetadata: metadata,
    );

    final dir = Directory('${root.path}/${entry.id}');
    await dir.create(recursive: true);
    final source = File(stopResult['filePath'] as String);
    await source.rename('${dir.path}/audio.wav');
    await File('${dir.path}/entry.json').writeAsString(entry.encode());
    await channel.setFileProtectionComplete(dir.path);
    log('queued audio ${entry.id} (${entry.armLabel})');
    return entry;
  }

  /// Text-payload path — exercises the discriminator end to end.
  Future<CaptureEntry> enqueueText({
    required String text,
    required String sessionId,
    required Map<String, dynamic> deviceProvenance,
  }) async {
    final entry = CaptureEntry(
      id: _uuidV4(),
      payloadKind: 'text',
      triggerSource: 'ui-button',
      originTimestamp: _isoNow(),
      deviceProvenance: deviceProvenance,
      sessionId: sessionId,
      armLabel: 'text-note',
      text: text,
      captureMetadata: {'schema': 'capture_metadata.v1', 'kind': 'text-note'},
    );
    final dir = Directory('${root.path}/${entry.id}');
    await dir.create(recursive: true);
    await File('${dir.path}/entry.json').writeAsString(entry.encode());
    await channel.setFileProtectionComplete(dir.path);
    log('queued text ${entry.id}');
    return entry;
  }

  // ── Drain ──────────────────────────────────────────────────

  /// Foreground-only drain loop, per the locked constraint — no background
  /// session work of any kind in this harness.
  void startDraining() {
    _drainTimer ??=
        Timer.periodic(const Duration(seconds: 5), (_) => drainOnce());
  }

  void setForeground(bool foreground) {
    _foreground = foreground;
  }

  Future<void> drainOnce() async {
    if (_draining || !_foreground) return;
    _draining = true;
    try {
      final cfg = settings();
      if (cfg.receiverUrl.isEmpty || cfg.secret.isEmpty) return;
      final now = DateTime.now().toUtc();
      for (final entry in await listEntries()) {
        if (entry.isSynced == 1) continue;
        final failure = entry.lastFailure;
        if (failure != null && failure['retryable'] == false) continue; // parked
        final next = entry.nextAttemptAt;
        if (next != null && DateTime.parse(next).isAfter(now)) continue;
        await _submitEntry(entry, cfg);
      }
    } finally {
      _draining = false;
    }
  }

  Future<void> _submitEntry(CaptureEntry entry, BenchSettings cfg) async {
    final dir = Directory('${root.path}/${entry.id}');
    final audio = entry.payloadKind == 'audio'
        ? File('${dir.path}/${entry.audioFile}')
        : null;
    final result = await client.submit(
      entry: entry,
      audioFile: audio,
      receiverUrl: cfg.receiverUrl,
      secret: cfg.secret,
    );
    if (result.ok) {
      // Confirmed receipt: device-side audio deleted immediately (zero
      // retention after confirm), sidecar flipped to synced and kept.
      if (audio != null && audio.existsSync()) {
        await audio.delete();
      }
      final synced = entry.copyWith(
        isSynced: 1,
        lastAttemptAt: _isoNow(),
        clearLastFailure: true,
      );
      await File('${dir.path}/entry.json').writeAsString(synced.encode());
      final duplicate = result.value?['duplicate'] == true;
      log('confirmed ${entry.id}${duplicate ? ' (duplicate)' : ''}');
      return;
    }

    final attempts = entry.attemptCount + 1;
    final updated = entry.copyWith(
      attemptCount: attempts,
      lastAttemptAt: _isoNow(),
      nextAttemptAt: result.retryable ? _backoffFrom(attempts) : null,
      lastFailure: {
        'reason': result.reason,
        'detail': result.detail,
        'retryable': result.retryable,
      },
    );
    await File('${dir.path}/entry.json').writeAsString(updated.encode());
    log(result.retryable
        ? 'retryable failure ${entry.id}: ${result.reason} (attempt $attempts)'
        : 'PARKED ${entry.id}: ${result.reason} — ${result.detail}');
  }

  // ── Introspection ──────────────────────────────────────────

  Future<List<CaptureEntry>> listEntries() async {
    final entries = <CaptureEntry>[];
    await for (final child in root.list()) {
      if (child is! Directory) continue;
      final file = File('${child.path}/entry.json');
      if (!file.existsSync()) continue;
      try {
        entries.add(CaptureEntry.fromJson(
            (jsonDecode(await file.readAsString()) as Map)
                .cast<String, dynamic>()));
      } on FormatException catch (e) {
        log('unreadable entry ${child.path}: $e');
      }
    }
    entries.sort((a, b) => a.originTimestamp.compareTo(b.originTimestamp));
    return entries;
  }

  Future<({int pending, int parked, int synced})> summary() async {
    var pending = 0, parked = 0, synced = 0;
    for (final e in await listEntries()) {
      if (e.isSynced == 1) {
        synced++;
      } else if (e.lastFailure != null && e.lastFailure!['retryable'] == false) {
        parked++;
      } else {
        pending++;
      }
    }
    return (pending: pending, parked: parked, synced: synced);
  }

  void dispose() {
    _drainTimer?.cancel();
    _drainTimer = null;
  }

  // ── Helpers ────────────────────────────────────────────────

  String _backoffFrom(int attempts) {
    final seconds =
        min(300, 5 * pow(2, min(attempts, 10)).toInt()) + Random().nextInt(2);
    return DateTime.now().toUtc().add(Duration(seconds: seconds)).toIso8601String();
  }

  static String _isoNow() => DateTime.now().toUtc().toIso8601String();

  static String _uuidV4() {
    final rng = Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex =
        bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
