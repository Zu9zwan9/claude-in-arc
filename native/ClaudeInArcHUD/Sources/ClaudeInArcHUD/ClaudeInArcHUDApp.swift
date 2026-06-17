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
    private var hudObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        pill.showCollapsed()
        hudObserver = DistributedNotificationCenter.default().addObserver(
            forName: HudMessageBus.notificationName,
            object: nil,
            queue: .main
        ) { [weak self] note in
            Task { @MainActor in
                self?.handleHudMessage(note)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hudObserver {
            DistributedNotificationCenter.default().removeObserver(hudObserver)
        }
    }

    private func handleHudMessage(_ notification: Notification) {
        guard let info = notification.userInfo,
              let type = info[HudMessageBus.Key.type] as? String else { return }

        NSLog("[ClaudeInArcHUD] message type=%@", type)

        switch type {
        case "toggle_hud":
            toggleHUD()
        case "set_collapsed":
            let collapsed = info[HudMessageBus.Key.collapsed] as? Bool ?? true
            if collapsed {
                panel.hide()
                pill.showCollapsed()
            } else {
                panel.show()
                pill.expand()
            }
        case "page_context":
            let title = info[HudMessageBus.Key.title] as? String ?? ""
            let url = info[HudMessageBus.Key.url] as? String ?? ""
            let tabId = info[HudMessageBus.Key.tabId] as? Int
            applyPageContext(title: title, url: url, tabId: tabId)
        default:
            break
        }
    }

    private func applyPageContext(title: String, url: String, tabId: Int?) {
        pill.updatePageContext(title: title, url: url, tabId: tabId)
        panel.updatePageContext(title: title, url: url, tabId: tabId)
    }

    func toggleHUD() {
        NSLog("[ClaudeInArcHUD] toggleHUD visible=%@", panel.isVisible ? "yes" : "no")
        if panel.isVisible {
            panel.hide()
            pill.showCollapsed()
        } else {
            panel.show()
            pill.expand()
            panel.focusChatInput()
        }
    }
}
