import AppKit
import ClaudeInArcHUDCore
import SwiftUI

@main
struct ClaudeInArcHUDApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Claude", systemImage: "bubble.left.and.bubble.right") {
            Button("Toggle HUD") {
                appDelegate.toggleHUD()
            }
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
        .menuBarExtraStyle(.menu)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let panel = HUDPanelController()
    let pill = NotchPillController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Agent-style: no dock icon when packaged with LSUIElement.
        NSApp.setActivationPolicy(.accessory)
        pill.showCollapsed()
    }

    func toggleHUD() {
        if panel.isVisible {
            panel.hide()
            pill.showCollapsed()
        } else {
            panel.show()
            pill.expand()
        }
    }
}
