import Foundation

/// Locates the patched Claude-in-Arc extension directory on disk.
public enum ExtensionRootResolver {
    public static let extensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn"

    private static let patchedBuildPath: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension", isDirectory: true)
    }()

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
