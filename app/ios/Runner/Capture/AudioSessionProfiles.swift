import AVFoundation

// iOS 26 SDK symbol checklist — verify at first compile in Xcode 26 (bench plan,
// risk watchlist): `.allowBluetoothHFP` (renamed from the deprecated `.allowBluetooth`),
// `.bluetoothHighQualityRecording`, `AVInputPickerInteraction`.

/// Bench session profiles. This is instrument configuration for the spike's
/// comparative arms, not a product abstraction: the product capture path has
/// exactly one session configuration, chosen from what Q1 proves out.
enum SessionProfile: String, CaseIterable {
  /// Voice-processing eligibility via session mode: .playAndRecord + .voiceChat.
  case vpMode = "vp-mode"
  /// Voice-processing eligibility via AVAudioEngine:
  /// inputNode.setVoiceProcessingEnabled(true) before engine start.
  case vpEngine = "vp-engine"
  /// Control arm: .measurement mode, minimal system processing.
  case raw = "raw"
  /// iOS 26 high-quality Bluetooth recording path (supported devices only).
  case btHq = "bt-hq"
}

enum ProfileError: Error {
  case notSupported(String)
}

struct AudioSessionProfiles {
  /// Applies the profile's category/mode/options to the session.
  /// Returns true when the caller must additionally enable voice processing
  /// on the engine's input node (the vp-engine path).
  static func apply(_ profile: SessionProfile, to session: AVAudioSession) throws -> Bool {
    switch profile {
    case .vpMode:
      try session.setCategory(
        .playAndRecord, mode: .voiceChat,
        options: [.allowBluetoothHFP, .defaultToSpeaker])
      return false
    case .vpEngine:
      try session.setCategory(
        .playAndRecord, mode: .default,
        options: [.allowBluetoothHFP])
      return true
    case .raw:
      try session.setCategory(
        .playAndRecord, mode: .measurement,
        options: [.allowBluetoothHFP])
      return false
    case .btHq:
      guard #available(iOS 26.0, *) else {
        throw ProfileError.notSupported("bt-hq requires iOS 26")
      }
      try session.setCategory(
        .playAndRecord, mode: .voiceChat,
        options: [.allowBluetoothHFP, .defaultToSpeaker, .bluetoothHighQualityRecording])
      return false
    }
  }
}
