// Appended to the app target's AppDelegate.swift by app.plugin.js. App Intents must live in
// the app target: Xcode extracts their metadata (what Shortcuts and Siri list) from the
// target's own sources, not from the static pods it links.

struct WakeMacIntent: AppIntent {
  static let title: LocalizedStringResource = "Wake Mac"
  static let description = IntentDescription(
    "Wakes your sleeping Mac over Wi-Fi and keeps it awake until you let it sleep.")
  static let openAppWhenRun = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let message = MacWake.wakeMessage(try await MacWake.wake())
    return .result(dialog: "\(message)")
  }
}

struct LetMacSleepIntent: AppIntent {
  static let title: LocalizedStringResource = "Let Mac sleep"
  static let description = IntentDescription(
    "Releases the hold from Wake Mac so your Mac can sleep again.")
  static let openAppWhenRun = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let message = MacWake.sleepMessage(try await MacWake.letSleep())
    return .result(dialog: "\(message)")
  }
}

struct PaseoAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: WakeMacIntent(),
      phrases: ["Wake Mac with \(.applicationName)", "Wake my Mac with \(.applicationName)"],
      shortTitle: "Wake Mac",
      systemImageName: "laptopcomputer")
    AppShortcut(
      intent: LetMacSleepIntent(),
      phrases: [
        "Let Mac sleep with \(.applicationName)", "Let my Mac sleep with \(.applicationName)",
      ],
      shortTitle: "Let Mac sleep",
      systemImageName: "moon.zzz")
  }
}
