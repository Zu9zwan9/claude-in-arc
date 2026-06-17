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

    /// `DistributedNotificationCenter` delivers numeric userInfo values as `NSNumber`, not `Int`.
    public static func intValue(in info: [AnyHashable: Any], key: String) -> Int? {
        if let value = info[key] as? Int { return value }
        if let number = info[key] as? NSNumber { return number.intValue }
        if let string = info[key] as? String, let value = Int(string) { return value }
        return nil
    }
}
