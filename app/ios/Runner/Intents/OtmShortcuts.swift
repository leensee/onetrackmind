import AppIntents

/// App Shortcuts are registered automatically at install — the Q3 flow needs
/// zero user setup beyond first launch.
struct OtmShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartCaptureIntent(),
      phrases: [
        "Start \(.applicationName) capture",
        "\(.applicationName) capture",
      ],
      shortTitle: "Start capture",
      systemImageName: "mic"
    )
  }
}
