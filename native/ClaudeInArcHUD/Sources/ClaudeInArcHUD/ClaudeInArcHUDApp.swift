import AppKit
import ClaudeInArcHUDCore
import SwiftUI

@main
struct ClaudeInArcHUDApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Claude", systemImage: "bubble.left.and.bubble.right") {
            Button("Toggle HUD") {
                appDelegate.hud.toggle()
            }
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
        .menuBarExtraStyle(.menu)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let hud = HUDPanelController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Agent-style: no dock icon when packaged with LSUIElement.
        NSApp.setActivationPolicy(.accessory)
    }
}
