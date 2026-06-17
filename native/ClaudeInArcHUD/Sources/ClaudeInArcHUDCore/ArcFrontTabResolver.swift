import Foundation

/// Best-effort read of Arc's front tab via AppleScript when extension tabId is missing.
public enum ArcFrontTabResolver {
    public struct Snapshot: Sendable {
        public let url: String
        public let title: String
    }

    /// Arc's AppleScript API: `URL of active tab of front window` (not Chrome tab ids).
    public static func snapshot() -> Snapshot? {
        let script = """
        tell application "Arc"
            try
                set tabUrl to URL of active tab of front window
                set tabTitle to title of active tab of front window
                return (tabUrl as text) & "\\t" & (tabTitle as text)
            on error
                return ""
            end try
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else { return nil }
        var error: NSDictionary?
        guard let output = appleScript.executeAndReturnError(&error).stringValue else {
            if let error {
                NSLog("[ClaudeInArcHUD] Arc AppleScript failed: %@", String(describing: error))
            }
            return nil
        }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
        let url = parts.first.map(String.init) ?? ""
        let title = parts.count > 1 ? String(parts[1]) : ""
        guard !url.isEmpty else { return nil }
        return Snapshot(url: url, title: title)
    }
}
