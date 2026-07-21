import AVFoundation
import UIKit

/// Snapshot helpers for the per-capture metadata block — the spike's proof
/// burden. Arm labels are ground-truthed by these values, never by intent.
enum CaptureMetadata {

  static func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
  }

  static func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  /// Monotonic milliseconds — immune to wallclock adjustment, used for
  /// intent→first-buffer latency budgets.
  static func monotonicMs() -> Double {
    return CACurrentMediaTime() * 1000.0
  }

  static func micModeString(_ mode: AVCaptureDevice.MicrophoneMode) -> String {
    switch mode {
    case .standard: return "standard"
    case .wideSpectrum: return "wideSpectrum"
    case .voiceIsolation: return "voiceIsolation"
    @unknown default: return "unknown(\(mode.rawValue))"
    }
  }

  static func micModeSnapshot() -> [String: Any] {
    return [
      "preferred": micModeString(AVCaptureDevice.preferredMicrophoneMode),
      "active": micModeString(AVCaptureDevice.activeMicrophoneMode),
    ]
  }

  static func routeSnapshot(_ session: AVAudioSession) -> [String: Any] {
    func portMap(_ p: AVAudioSessionPortDescription) -> [String: Any] {
      var m: [String: Any] = [
        "portType": p.portType.rawValue,
        "portName": p.portName,
        "uid": p.uid,
      ]
      if let ds = p.selectedDataSource {
        m["selectedDataSource"] = ds.dataSourceName
      }
      return m
    }
    let route = session.currentRoute
    return [
      "inputs": route.inputs.map(portMap),
      "outputs": route.outputs.map(portMap),
    ]
  }

  static func decodeOptions(_ options: AVAudioSession.CategoryOptions) -> [String] {
    var names: [String] = []
    if options.contains(.mixWithOthers) { names.append("mixWithOthers") }
    if options.contains(.duckOthers) { names.append("duckOthers") }
    if options.contains(.allowBluetoothHFP) { names.append("allowBluetoothHFP") }
    if options.contains(.defaultToSpeaker) { names.append("defaultToSpeaker") }
    if options.contains(.interruptSpokenAudioAndMixWithOthers) {
      names.append("interruptSpokenAudioAndMixWithOthers")
    }
    if options.contains(.allowBluetoothA2DP) { names.append("allowBluetoothA2DP") }
    if options.contains(.allowAirPlay) { names.append("allowAirPlay") }
    if options.contains(.overrideMutedMicrophoneInterruption) {
      names.append("overrideMutedMicrophoneInterruption")
    }
    if #available(iOS 26.0, *) {
      if options.contains(.bluetoothHighQualityRecording) {
        names.append("bluetoothHighQualityRecording")
      }
    }
    return names
  }

  /// The negotiated input sample rate is the codec evidence for the HFP
  /// question: 8 kHz ⇒ CVSD, 16 kHz ⇒ mSBC, 24/32 kHz ⇒ LE Audio / HQ path.
  static func sessionSnapshot(_ session: AVAudioSession) -> [String: Any] {
    return [
      "category": session.category.rawValue,
      "mode": session.mode.rawValue,
      "options": decodeOptions(session.categoryOptions),
      "sampleRate": session.sampleRate,
      "preferredSampleRate": session.preferredSampleRate,
      "ioBufferDuration": session.ioBufferDuration,
      "inputLatency": session.inputLatency,
      "inputNumberOfChannels": session.inputNumberOfChannels,
      "isInputAvailable": session.isInputAvailable,
    ]
  }

  static func deviceProvenance() -> [String: Any] {
    let device = UIDevice.current
    var model = device.model
    var systemInfo = utsname()
    uname(&systemInfo)
    let machineMirror = Mirror(reflecting: systemInfo.machine)
    let identifier = machineMirror.children.reduce(into: "") { result, element in
      guard let value = element.value as? Int8, value != 0 else { return }
      result.append(String(UnicodeScalar(UInt8(value))))
    }
    if !identifier.isEmpty { model = identifier }
    let build =
      (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?") + "+"
      + (Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")
    return [
      "device_model": model,
      "os_version": "\(device.systemName) \(device.systemVersion)",
      "app_build": build,
      "device_name": device.name,
    ]
  }

  static func fullSnapshot(_ session: AVAudioSession) -> [String: Any] {
    return [
      "session": sessionSnapshot(session),
      "route": routeSnapshot(session),
      "micMode": micModeSnapshot(),
      "at": isoNow(),
    ]
  }
}
