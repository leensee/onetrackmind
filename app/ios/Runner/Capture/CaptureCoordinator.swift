import AVFoundation
import AVKit
import Flutter
import UIKit

/// Owns the audio path end to end: session profile, engine, tap, file write,
/// and the Siri-triggered autostart. `start(...)` is the single capture entry
/// point — trigger source is metadata on it, never a second code path.
///
/// The Siri path deliberately runs the whole Swift-side start sequence without
/// waiting for the Flutter engine: Dart catches up through the buffered event
/// stream. That keeps Flutter cold-start latency out of the gloved-entry
/// critical path and out of the Q3 measurement.
final class CaptureCoordinator: NSObject {

  static let shared = CaptureCoordinator()

  enum CaptureError: Error {
    case alreadyCapturing
    case notCapturing
    case permissionDenied
    case engineFailure(String)
  }

  private struct ActiveCapture {
    let id: String
    let triggerSource: String
    let armLabel: String
    let utteranceId: String?
    let profile: SessionProfile
    let fileURL: URL
    let startedAtISO: String
    let startedMonotonicMs: Double
    var sessionAtStart: [String: Any]
    var routeAtStart: [String: Any]
    var micModeAtStart: [String: Any]
    var tapFormat: [String: Any]
  }

  private let session = AVAudioSession.sharedInstance()
  private var engine: AVAudioEngine?
  private let fileLock = NSLock()
  private var audioFile: AVAudioFile?
  private var active: ActiveCapture?
  private var currentProfile: SessionProfile?
  private var vpRequestedOnEngine = false

  private var timestamps: [String: Any] = [:]
  private var events: [[String: Any]] = []
  private var lastPolledMicMode: String?
  private var pollTimer: Timer?
  private var firstBufferRecorded = false

  /// Context recorded by StartCaptureIntent.perform(), merged into the next
  /// capture's timestamps (Q3 evidence).
  private var pendingIntentContext: [String: Any]?

  /// Set by the event channel on listen; events raised earlier (Siri cold
  /// start) are buffered and flushed in order.
  var eventSink: (([String: Any]) -> Void)? {
    didSet {
      guard let sink = eventSink else { return }
      let buffered = pendingEvents
      pendingEvents = []
      buffered.forEach(sink)
    }
  }
  private var pendingEvents: [[String: Any]] = []

  private override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] note in
      let reason =
        (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).map { "\($0)" } ?? "unknown"
      self?.emit(type: "routeChange", payload: [
        "reason": reason,
        "route": CaptureMetadata.routeSnapshot(AVAudioSession.sharedInstance()),
      ])
    }
    center.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
      self?.emit(type: "interruption", payload: [
        "phase": typeRaw == AVAudioSession.InterruptionType.began.rawValue ? "began" : "ended",
        "options": optionsRaw ?? 0,
      ])
    }
    center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.emit(type: "mediaServicesReset", payload: [:])
    }
  }

  // MARK: - Events

  private func emit(type: String, payload: [String: Any]) {
    var event: [String: Any] = [
      "type": type,
      "at": CaptureMetadata.isoNow(),
      "atMonotonicMs": CaptureMetadata.monotonicMs(),
      "payload": payload,
    ]
    if let captureId = active?.id { event["captureId"] = captureId }
    if active != nil { events.append(event) }
    if let sink = eventSink {
      sink(event)
    } else {
      pendingEvents.append(event)
    }
  }

  // MARK: - Control (all called on the main/platform thread)

  @discardableResult
  func configure(profile: SessionProfile) throws -> [String: Any] {
    guard active == nil else { throw CaptureError.alreadyCapturing }
    timestamps["t_configure"] = CaptureMetadata.isoNow()
    timestamps["t_configure_monotonicMs"] = CaptureMetadata.monotonicMs()
    // Deactivate before recategorizing so option changes take cleanly; a
    // failure to deactivate an inactive session is not an error worth failing on,
    // but it is worth an event.
    do {
      try session.setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      emit(type: "sessionDeactivateFailed", payload: ["detail": String(describing: error)])
    }
    vpRequestedOnEngine = try AudioSessionProfiles.apply(profile, to: session)
    currentProfile = profile
    try session.setActive(true)
    timestamps["t_sessionActive"] = CaptureMetadata.isoNow()
    timestamps["t_sessionActive_monotonicMs"] = CaptureMetadata.monotonicMs()
    return CaptureMetadata.fullSnapshot(session)
  }

  func start(triggerSource: String, armLabel: String, utteranceId: String?) throws -> String {
    guard active == nil else { throw CaptureError.alreadyCapturing }
    if currentProfile == nil {
      try configure(profile: defaultProfile())
    }
    guard let profile = currentProfile else {
      throw CaptureError.engineFailure("no profile configured")
    }

    // Fresh engine per capture: setVoiceProcessingEnabled must precede start,
    // and reusing an engine across profile changes carries stale VP state.
    let engine = AVAudioEngine()
    if vpRequestedOnEngine {
      do {
        try engine.inputNode.setVoiceProcessingEnabled(true)
      } catch {
        throw CaptureError.engineFailure(
          "setVoiceProcessingEnabled failed: \(String(describing: error))")
      }
    }
    try session.setActive(true)
    timestamps["t_sessionActive"] = CaptureMetadata.isoNow()
    timestamps["t_sessionActive_monotonicMs"] = CaptureMetadata.monotonicMs()

    let tapFormat = engine.inputNode.outputFormat(forBus: 0)
    let captureId = UUID().uuidString.lowercased()
    let fileURL = try Self.audioDirectory().appendingPathComponent("\(captureId).wav")

    // 16-bit PCM WAV at the native tap rate/channels — the file's sample rate
    // is itself evidence (HFP codec negotiation falls out of the corpus).
    let fileSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: tapFormat.sampleRate,
      AVNumberOfChannelsKey: tapFormat.channelCount,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    let file = try AVAudioFile(
      forWriting: fileURL, settings: fileSettings,
      commonFormat: tapFormat.commonFormat, interleaved: tapFormat.isInterleaved)
    // §10 bench-exception condition: protection class set to .complete
    // explicitly — the platform default leaves files readable after first unlock.
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete], ofItemAtPath: fileURL.path)

    fileLock.lock()
    audioFile = file
    fileLock.unlock()
    firstBufferRecorded = false

    engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: tapFormat) {
      [weak self] buffer, _ in
      guard let self = self else { return }
      if !self.firstBufferRecorded {
        self.firstBufferRecorded = true
        let atISO = CaptureMetadata.isoNow()
        let atMono = CaptureMetadata.monotonicMs()
        DispatchQueue.main.async {
          self.timestamps["t_firstBuffer"] = atISO
          self.timestamps["t_firstBuffer_monotonicMs"] = atMono
          self.emit(type: "firstBuffer", payload: [:])
        }
      }
      self.fileLock.lock()
      defer { self.fileLock.unlock() }
      guard let file = self.audioFile else { return }
      do {
        try file.write(from: buffer)
      } catch {
        DispatchQueue.main.async {
          self.emit(type: "fileWriteError", payload: ["detail": String(describing: error)])
        }
      }
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      engine.inputNode.removeTap(onBus: 0)
      fileLock.lock()
      audioFile = nil
      fileLock.unlock()
      throw CaptureError.engineFailure("engine.start failed: \(String(describing: error))")
    }
    timestamps["t_engineStart"] = CaptureMetadata.isoNow()
    timestamps["t_engineStart_monotonicMs"] = CaptureMetadata.monotonicMs()
    if let intentContext = pendingIntentContext {
      for (k, v) in intentContext { timestamps[k] = v }
      pendingIntentContext = nil
    }

    self.engine = engine
    active = ActiveCapture(
      id: captureId,
      triggerSource: triggerSource,
      armLabel: armLabel,
      utteranceId: utteranceId,
      profile: profile,
      fileURL: fileURL,
      startedAtISO: CaptureMetadata.isoNow(),
      startedMonotonicMs: CaptureMetadata.monotonicMs(),
      sessionAtStart: CaptureMetadata.sessionSnapshot(session),
      routeAtStart: CaptureMetadata.routeSnapshot(session),
      micModeAtStart: CaptureMetadata.micModeSnapshot(),
      tapFormat: [
        "sampleRate": tapFormat.sampleRate,
        "channels": tapFormat.channelCount,
        "commonFormat": "\(tapFormat.commonFormat.rawValue)",
      ])

    startMicModePolling()
    emit(type: "captureStarted", payload: [
      "captureId": captureId,
      "triggerSource": triggerSource,
      "armLabel": armLabel,
      "profile": profile.rawValue,
    ])
    return captureId
  }

  func stop() throws -> [String: Any] {
    guard let capture = active, let engine = engine else { throw CaptureError.notCapturing }
    stopMicModePolling()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    timestamps["t_stop"] = CaptureMetadata.isoNow()
    timestamps["t_stop_monotonicMs"] = CaptureMetadata.monotonicMs()

    fileLock.lock()
    let file = audioFile
    audioFile = nil
    fileLock.unlock()

    let vpEnabled = engine.inputNode.isVoiceProcessingEnabled
    let durationMs = CaptureMetadata.monotonicMs() - capture.startedMonotonicMs
    let metadata: [String: Any] = [
      "schema": "capture_metadata.v1",
      "profile": capture.profile.rawValue,
      "session": ["atStart": capture.sessionAtStart,
                  "atStop": CaptureMetadata.sessionSnapshot(session)],
      "vp": ["isVoiceProcessingEnabled": vpEnabled,
             "profile": capture.profile.rawValue],
      "micMode": ["atStart": capture.micModeAtStart,
                  "atStop": CaptureMetadata.micModeSnapshot()],
      "route": ["atStart": capture.routeAtStart,
                "atStop": CaptureMetadata.routeSnapshot(session)],
      "format": ["tap": capture.tapFormat,
                 "file": ["container": "wav", "bit_depth": 16,
                          "sample_rate": file?.fileFormat.sampleRate ?? 0,
                          "channels": file?.fileFormat.channelCount ?? 0]],
      "timestamps": timestamps,
      "events": events,
      "trigger_source": capture.triggerSource,
      "arm_label": capture.armLabel,
      "utterance_id": capture.utteranceId as Any,
      "device_provenance": CaptureMetadata.deviceProvenance(),
    ]

    let result: [String: Any] = [
      "captureId": capture.id,
      "filePath": capture.fileURL.path,
      "durationMs": durationMs,
      "originTimestamp": capture.startedAtISO,
      "captureMetadata": metadata,
    ]
    emit(type: "captureStopped", payload: ["captureId": capture.id, "durationMs": durationMs])
    active = nil
    self.engine = nil
    timestamps = [:]
    events = []
    return result
  }

  func snapshot() -> [String: Any] {
    var snap = CaptureMetadata.fullSnapshot(session)
    snap["profile"] = currentProfile?.rawValue as Any
    snap["capturing"] = active != nil
    snap["captureId"] = active?.id as Any
    return snap
  }

  // MARK: - Siri autostart (Q3)

  /// Called from StartCaptureIntent.perform(). Runs the full start sequence
  /// without waiting for Flutter; failures surface as events because the Siri
  /// path has no method-call response to throw into.
  func trigger(source: String, intentAt: Date) {
    let context: [String: Any] = [
      "t_intentPerform": CaptureMetadata.iso(intentAt),
      "t_intentPerform_monotonicMs": CaptureMetadata.monotonicMs(),
      "applicationStateAtPerform": "\(UIApplication.shared.applicationState.rawValue)",
      "isProtectedDataAvailableAtPerform": UIApplication.shared.isProtectedDataAvailable,
    ]
    pendingIntentContext = context
    emit(type: "intentTriggered", payload: context)

    guard active == nil else {
      emit(type: "intentIgnored", payload: ["reason": "alreadyCapturing"])
      return
    }
    AVAudioApplication.requestRecordPermission { [weak self] granted in
      DispatchQueue.main.async {
        guard let self = self else { return }
        guard granted else {
          self.emit(type: "intentStartFailed", payload: ["reason": "permissionDenied"])
          return
        }
        do {
          try self.configure(profile: self.defaultProfile())
          _ = try self.start(
            triggerSource: source, armLabel: self.defaultArmLabel(), utteranceId: nil)
        } catch {
          self.emit(type: "intentStartFailed", payload: [
            "reason": "startFailed", "detail": String(describing: error),
          ])
        }
      }
    }
  }

  /// SceneDelegate hook — t_appActive for the Q3 latency chain.
  func noteAppActive() {
    let at = CaptureMetadata.isoNow()
    let atMono = CaptureMetadata.monotonicMs()
    if pendingIntentContext != nil {
      pendingIntentContext?["t_appActive"] = at
      pendingIntentContext?["t_appActive_monotonicMs"] = atMono
    } else if active != nil {
      timestamps["t_appActive"] = at
      timestamps["t_appActive_monotonicMs"] = atMono
    }
    emit(type: "appBecameActive", payload: [:])
  }

  // MARK: - Helpers

  /// Defaults for the Siri path, settable from the bench UI via the channel.
  private func defaultProfile() -> SessionProfile {
    let stored = UserDefaults.standard.string(forKey: "otm.bench.defaultProfile")
    return stored.flatMap(SessionProfile.init(rawValue:)) ?? .vpMode
  }

  private func defaultArmLabel() -> String {
    return UserDefaults.standard.string(forKey: "otm.bench.defaultArmLabel") ?? "unlabeled-siri"
  }

  func setDefaults(profile: String?, armLabel: String?) {
    if let profile = profile {
      UserDefaults.standard.set(profile, forKey: "otm.bench.defaultProfile")
    }
    if let armLabel = armLabel {
      UserDefaults.standard.set(armLabel, forKey: "otm.bench.defaultArmLabel")
    }
  }

  private static func audioDirectory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
    let dir = base.appendingPathComponent("bench-audio", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Class-property KVO on AVCaptureDevice microphone modes is fragile;
  /// 1 Hz polling during capture is deterministic and cheap.
  private func startMicModePolling() {
    lastPolledMicMode = CaptureMetadata.micModeString(AVCaptureDevice.activeMicrophoneMode)
    pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      let now = CaptureMetadata.micModeString(AVCaptureDevice.activeMicrophoneMode)
      if now != self.lastPolledMicMode {
        self.emit(type: "micModeChanged", payload: [
          "from": self.lastPolledMicMode ?? "unknown", "to": now,
        ])
        self.lastPolledMicMode = now
      }
    }
  }

  private func stopMicModePolling() {
    pollTimer?.invalidate()
    pollTimer = nil
    lastPolledMicMode = nil
  }
}

// MARK: - Flutter channel surface

/// MethodChannel `otm/capture` + EventChannel `otm/capture/events`.
final class CaptureChannelHandler: NSObject, FlutterStreamHandler {

  static let shared = CaptureChannelHandler()

  func register(with messenger: FlutterBinaryMessenger) {
    let method = FlutterMethodChannel(name: "otm/capture", binaryMessenger: messenger)
    method.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
    let events = FlutterEventChannel(name: "otm/capture/events", binaryMessenger: messenger)
    events.setStreamHandler(self)
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let coordinator = CaptureCoordinator.shared
    let args = call.arguments as? [String: Any] ?? [:]
    do {
      switch call.method {
      case "configureSession":
        guard let raw = args["profile"] as? String,
          let profile = SessionProfile(rawValue: raw)
        else {
          result(FlutterError(
            code: "invalid_input", message: "unknown profile", details: args["profile"]))
          return
        }
        result(try coordinator.configure(profile: profile))

      case "startCapture":
        guard let triggerSource = args["triggerSource"] as? String,
          let armLabel = args["armLabel"] as? String
        else {
          result(FlutterError(
            code: "invalid_input", message: "triggerSource and armLabel required", details: nil))
          return
        }
        let utteranceId = args["utteranceId"] as? String
        AVAudioApplication.requestRecordPermission { granted in
          DispatchQueue.main.async {
            guard granted else {
              result(FlutterError(
                code: "permission_denied", message: "microphone permission denied", details: nil))
              return
            }
            do {
              let id = try coordinator.start(
                triggerSource: triggerSource, armLabel: armLabel, utteranceId: utteranceId)
              result(["captureId": id])
            } catch {
              result(FlutterError(
                code: "capture_failed", message: String(describing: error), details: nil))
            }
          }
        }

      case "stopCapture":
        result(try coordinator.stop())

      case "getSnapshot":
        result(coordinator.snapshot())

      // Returns the Application Support path so the Dart queue can live under
      // it without taking the path_provider plugin dependency.
      case "getStorageDir":
        let base = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask,
          appropriateFor: nil, create: true)
        result(base.path)

      case "setDefaults":
        coordinator.setDefaults(
          profile: args["profile"] as? String, armLabel: args["armLabel"] as? String)
        result(nil)

      case "showMicModeUI":
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
        result(nil)

      case "showInputPicker":
        if #available(iOS 26.0, *) {
          self.presentInputPicker(result: result)
        } else {
          result(FlutterError(
            code: "not_supported", message: "AVInputPickerInteraction requires iOS 26",
            details: nil))
        }

      case "setFileProtectionComplete":
        guard let path = args["path"] as? String else {
          result(FlutterError(code: "invalid_input", message: "path required", details: nil))
          return
        }
        try Self.applyCompleteProtection(atPath: path)
        result(nil)

      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      result(FlutterError(code: "capture_failed", message: String(describing: error), details: nil))
    }
  }

  // Held as AnyObject so the stored property needs no availability annotation
  // (the concrete AVInputPickerInteraction type is iOS 26+).
  private var inputPickerInteraction: AnyObject?

  @available(iOS 26.0, *)
  private func presentInputPicker(result: @escaping FlutterResult) {
    guard
      let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first
    else {
      result(FlutterError(code: "no_view", message: "no root view controller", details: nil))
      return
    }
    let interaction = AVInputPickerInteraction()
    root.view.addInteraction(interaction)
    inputPickerInteraction = interaction
    interaction.present()
    result(nil)
  }

  /// §10 condition: `.complete` protection applied explicitly, recursively —
  /// Dart-written queue files get the platform default otherwise.
  static func applyCompleteProtection(atPath path: String) throws {
    let fm = FileManager.default
    try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: path)
    var isDirectory: ObjCBool = false
    guard fm.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
      return
    }
    for child in try fm.contentsOfDirectory(atPath: path) {
      try applyCompleteProtection(atPath: (path as NSString).appendingPathComponent(child))
    }
  }

  // MARK: FlutterStreamHandler

  func onListen(withArguments arguments: Any?, eventSink: @escaping FlutterEventSink)
    -> FlutterError?
  {
    CaptureCoordinator.shared.eventSink = { event in eventSink(event) }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    CaptureCoordinator.shared.eventSink = nil
    return nil
  }
}
