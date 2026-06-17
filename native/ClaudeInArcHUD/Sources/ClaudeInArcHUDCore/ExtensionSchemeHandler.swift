import Foundation
import WebKit

/// Serves extension files for `claude-in-arc-ext://localhost/...` inside the HUD WebView.
public final class ExtensionSchemeHandler: NSObject, WKURLSchemeHandler {
    private let extensionRoot: URL
    private let queue = DispatchQueue(label: "com.claudeinarac.hud.scheme", qos: .userInitiated)
    private var stoppedTasks = Set<ObjectIdentifier>()
    private let lock = NSLock()

    public init(extensionRoot: URL) {
        self.extensionRoot = extensionRoot
        super.init()
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        let taskId = ObjectIdentifier(urlSchemeTask)
        let resourcePath = requestURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let extRoot = extensionRoot

        queue.async { [weak self] in
            guard let self else { return }
            if self.isStopped(taskId) {
                return
            }

            guard !resourcePath.isEmpty, !resourcePath.contains("..") else {
                self.finish(taskId, urlSchemeTask) { $0.didFailWithError(URLError(.fileDoesNotExist)) }
                return
            }

            let fileURL = extRoot.appendingPathComponent(resourcePath)
            guard fileURL.path.hasPrefix(extRoot.path),
                  FileManager.default.fileExists(atPath: fileURL.path),
                  let data = try? Data(contentsOf: fileURL) else {
                self.finish(taskId, urlSchemeTask) { $0.didFailWithError(URLError(.fileDoesNotExist)) }
                return
            }

            let mime = Self.mimeType(for: resourcePath)
            guard let response = HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": mime]
            ) else {
                self.finish(taskId, urlSchemeTask) { $0.didFailWithError(URLError(.badURL)) }
                return
            }

            self.finish(taskId, urlSchemeTask) {
                $0.didReceive(response)
                $0.didReceive(data)
                $0.didFinish()
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock()
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
        lock.unlock()
    }

    private func isStopped(_ id: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stoppedTasks.contains(id)
    }

    private func finish(_ id: ObjectIdentifier, _ task: WKURLSchemeTask, block: @escaping (WKURLSchemeTask) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isStopped(id) else { return }
            block(task)
            self.lock.lock()
            self.stoppedTasks.remove(id)
            self.lock.unlock()
        }
    }

    public static func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        default: return "application/octet-stream"
        }
    }
}
