import Foundation

/// Locates the patched Claude-in-Arc extension directory on disk.
public enum ExtensionRootResolver {
    public static let extensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn"

    public struct Diagnostics {
        public let root: URL?
        public let patchedBuildPresent: Bool
        public let arcRegisteredPath: String?
        public let storeCopyActive: Bool
        public let missingBridgeAssets: Bool

        public var blockingMessage: String? {
            if storeCopyActive {
                return """
                Extension not loaded — Arc is using the Chrome Web Store copy.

                On arc://extensions: Remove the Store "Claude" entry, keep only \
                Load unpacked → ClaudeInArc/Claude-in-Arc-Extension, then Reload.

                Run: claude-in-arc doctor
                """
            }
            if root == nil {
                if !patchedBuildPresent {
                    return """
                    Claude extension not found.

                    Run:
                      claude-in-arc install --panel-mode hud
                      claude-in-arc hud install
                    Then Reload on arc://extensions.
                    """
                }
                return """
                HUD bridge assets missing from the patched build.

                Run: claude-in-arc install --panel-mode hud
                Then Reload on arc://extensions.
                """
            }
            if missingBridgeAssets {
                return """
                HUD bridge files missing in extension folder.

                Run: claude-in-arc install --panel-mode hud
                Then Reload on arc://extensions.
                """
            }
            return nil
        }
    }

    private static let patchedBuildPath: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension", isDirectory: true)
    }()

    private static let arcUserDataPath: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Arc/User Data", isDirectory: true)
    }()

    public static func diagnose() -> Diagnostics {
        let patchedPresent = validExtensionRoot(patchedBuildPath) != nil
        let registeredPath = arcRegisteredExtensionPath()
        let patchedPath = patchedBuildPath.path
        let storeActive = registeredPath.map {
            !$0.isEmpty && !$0.hasPrefix(patchedPath) && !($0 as NSString).standardizingPath.hasPrefix(patchedPath)
        } ?? false

        let root = resolve()
        let missingBridge: Bool
        if let root {
            missingBridge = !FileManager.default.fileExists(
                atPath: root.appendingPathComponent("claude-arc-hud-bridge.html").path
            )
        } else {
            missingBridge = true
        }

        return Diagnostics(
            root: root,
            patchedBuildPresent: patchedPresent,
            arcRegisteredPath: registeredPath,
            storeCopyActive: storeActive,
            missingBridgeAssets: missingBridge
        )
    }

    public static func resolve() -> URL? {
        if let patched = validExtensionRoot(patchedBuildPath) {
            NSLog("[ClaudeInArcHUD] extension root (patched build): %@", patched.path)
            return patched
        }
        if let arc = newestArcExtensionRoot() {
            NSLog("[ClaudeInArcHUD] extension root (Arc profile): %@", arc.path)
            return arc
        }
        NSLog("[ClaudeInArcHUD] extension root not found")
        return nil
    }

    private static func arcRegisteredExtensionPath() -> String? {
        for prefName in ["Default/Secure Preferences", "Default/Preferences"] {
            let prefURL = arcUserDataPath.appendingPathComponent(prefName)
            guard let data = try? Data(contentsOf: prefURL),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let extensions = json["extensions"] as? [String: Any],
                  let settings = extensions["settings"] as? [String: Any],
                  let ext = settings[extensionId] as? [String: Any],
                  let path = ext["path"] as? String else {
                continue
            }
            return path
        }
        return nil
    }

    private static func validExtensionRoot(_ url: URL) -> URL? {
        let manifest = url.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
        let bridge = url.appendingPathComponent("claude-arc-hud-bridge.html")
        guard FileManager.default.fileExists(atPath: bridge.path) else { return nil }
        return url
    }

    private static func newestArcExtensionRoot() -> URL? {
        let arcRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Arc", isDirectory: true)
        guard let enumerator = FileManager.default.enumerator(
            at: arcRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        var candidates: [URL] = []
        let suffix = "Extensions/\(extensionId)"
        for case let url as URL in enumerator {
            guard url.hasDirectoryPath else { continue }
            if url.path.hasSuffix(suffix) {
                if let versions = try? FileManager.default.contentsOfDirectory(
                    at: url,
                    includingPropertiesForKeys: nil
                ) {
                    candidates.append(contentsOf: versions.filter(\.hasDirectoryPath))
                }
            }
        }

        let valid = candidates.compactMap(validExtensionRoot)
        return valid.sorted { $0.lastPathComponent > $1.lastPathComponent }.first
    }
}
