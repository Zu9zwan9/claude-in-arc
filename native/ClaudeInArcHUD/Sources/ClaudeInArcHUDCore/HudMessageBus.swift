import Foundation

/// Cross-process bridge: `ClaudeInArcHUDHost` → menu-bar app via `DistributedNotificationCenter`.
/// Keep `notificationName` in sync with `ClaudeInArcHUDHost/main.swift`.
public enum HudMessageBus {
    public static let notificationName = Notification.Name("com.claudeinarac.hud.message")

    public enum Key {
        public static let type = "type"
        public static let tabId = "tabId"
        public static let url = "url"
        public static let title = "title"
        public static let collapsed = "collapsed"
        public static let visible = "visible"
    }
}
