import AppIntents
import UIKit

/// Siri/Shortcuts entry for Q3. `openAppWhenRun` foregrounds the app (the
/// locked constraint: sessions are foreground-established only), then
/// `perform()` runs in-process and hands off to the same single capture entry
/// point every other trigger uses — trigger source is metadata, not a path.
struct StartCaptureIntent: AppIntent {
  static var title: LocalizedStringResource = "Start OTM Capture"
  static var description = IntentDescription(
    "Starts a bench capture with the default session profile.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    CaptureCoordinator.shared.trigger(source: "siri-shortcut", intentAt: Date())
    return .result()
  }
}
