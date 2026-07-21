import 'dart:convert';
import 'dart:io';

import 'models.dart';

/// Submits queue entries to the bench receiver over the LAN.
/// dart:io HttpClient only — no `http` package (no new deps in the spike).
class SubmitClient {
  final Duration timeout;

  SubmitClient({this.timeout = const Duration(seconds: 60)});

  /// POST /v1/captures. Transport-level failures never throw; they map to
  /// {reason: 'network', retryable: true} per the submission contract.
  Future<BenchSubmitResult<Map<String, dynamic>>> submit({
    required CaptureEntry entry,
    required File? audioFile,
    required String receiverUrl,
    required String secret,
  }) async {
    final Map<String, dynamic> payload;
    if (entry.payloadKind == 'audio') {
      if (audioFile == null || !audioFile.existsSync()) {
        return const BenchSubmitResult.failure(
          reason: 'invalid_input',
          detail: 'audio payload with no audio file on disk',
          retryable: false,
        );
      }
      payload = {
        'kind': 'audio',
        'audioBase64': base64Encode(await audioFile.readAsBytes()),
        'format': entry.audioFormat,
      };
    } else {
      payload = {'kind': 'text', 'text': entry.text};
    }

    // The receiver owns sync/retry state interpretation on its side; the
    // submitted entry omits the device-local queue bookkeeping fields.
    final entryJson = entry.toJson()
      ..remove('is_synced')
      ..remove('attempt_count')
      ..remove('last_attempt_at')
      ..remove('next_attempt_at')
      ..remove('last_failure');

    final body = jsonEncode({
      'schema': 'otm-bench-capture.v1',
      'entry': entryJson,
      'payload': payload,
    });

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    try {
      final uri = Uri.parse('$receiverUrl/v1/captures');
      final request = await client.postUrl(uri).timeout(timeout);
      request.headers.contentType = ContentType.json;
      request.headers.set('x-otm-bench-secret', secret);
      request.write(body);
      final response = await request.close().timeout(timeout);
      final responseBody =
          await response.transform(utf8.decoder).join().timeout(timeout);
      return _mapResponse(response.statusCode, responseBody);
    } on Exception catch (e) {
      return BenchSubmitResult.failure(
        reason: 'network',
        detail: e.toString(),
        retryable: true,
      );
    } finally {
      client.close(force: true);
    }
  }

  Future<bool> ping(String receiverUrl) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final request = await client
          .getUrl(Uri.parse('$receiverUrl/health'))
          .timeout(const Duration(seconds: 5));
      final response = await request.close().timeout(const Duration(seconds: 5));
      await response.drain<void>();
      return response.statusCode == 200;
    } on Exception {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  BenchSubmitResult<Map<String, dynamic>> _mapResponse(
      int statusCode, String body) {
    Map<String, dynamic>? decoded;
    try {
      decoded = (jsonDecode(body) as Map).cast<String, dynamic>();
    } on FormatException {
      decoded = null;
    }
    if (statusCode == 200 && decoded != null && decoded['ok'] == true) {
      return BenchSubmitResult.success(
          (decoded['value'] as Map? ?? {}).cast<String, dynamic>());
    }
    final reason = decoded?['reason'] as String? ??
        switch (statusCode) {
          401 || 403 => 'auth_failed',
          400 => 'invalid_input',
          500 => 'storage_error',
          _ => 'network',
        };
    final retryable = decoded?['retryable'] as bool? ??
        (reason == 'storage_error' || reason == 'network');
    return BenchSubmitResult.failure(
      reason: reason,
      detail: decoded?['detail'] as String? ?? 'HTTP $statusCode',
      retryable: retryable,
    );
  }
}
