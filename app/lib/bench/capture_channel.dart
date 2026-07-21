import 'package:flutter/services.dart';

/// Typed bindings for the `otm/capture` MethodChannel and the
/// `otm/capture/events` EventChannel. Swift owns the audio path; Dart owns
/// UI, queue, and submission.
class CaptureChannel {
  static const _method = MethodChannel('otm/capture');
  static const _events = EventChannel('otm/capture/events');

  /// Broadcast stream of {type, at, atMonotonicMs, payload, captureId?} maps.
  /// Events raised before Dart attached (Siri cold start) are buffered on the
  /// Swift side and flushed in order on first listen.
  Stream<Map<String, dynamic>> get events => _events
      .receiveBroadcastStream()
      .map((event) => (event as Map).cast<String, dynamic>());

  Future<Map<String, dynamic>> configureSession(String profile) async {
    final result =
        await _method.invokeMethod<Map>('configureSession', {'profile': profile});
    return (result ?? {}).cast<String, dynamic>();
  }

  /// The single capture entry point — trigger source is metadata, never a
  /// separate code path.
  Future<String> startCapture({
    required String triggerSource,
    required String armLabel,
    String? utteranceId,
  }) async {
    final result = await _method.invokeMethod<Map>('startCapture', {
      'triggerSource': triggerSource,
      'armLabel': armLabel,
      'utteranceId': utteranceId,
    });
    return (result ?? {})['captureId'] as String;
  }

  Future<Map<String, dynamic>> stopCapture() async {
    final result = await _method.invokeMethod<Map>('stopCapture');
    return (result ?? {}).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> getSnapshot() async {
    final result = await _method.invokeMethod<Map>('getSnapshot');
    return (result ?? {}).cast<String, dynamic>();
  }

  Future<String> getStorageDir() async {
    final result = await _method.invokeMethod<String>('getStorageDir');
    return result!;
  }

  /// Defaults used by the Siri autostart path (stored in UserDefaults).
  Future<void> setDefaults({String? profile, String? armLabel}) {
    return _method.invokeMethod<void>('setDefaults', {
      'profile': profile,
      'armLabel': armLabel,
    });
  }

  Future<void> showMicModeUI() => _method.invokeMethod<void>('showMicModeUI');

  Future<void> showInputPicker() =>
      _method.invokeMethod<void>('showInputPicker');

  /// §10 bench-exception condition: queue files explicitly set to the
  /// complete protection class (recursive over a directory).
  Future<void> setFileProtectionComplete(String path) {
    return _method.invokeMethod<void>('setFileProtectionComplete', {'path': path});
  }
}
