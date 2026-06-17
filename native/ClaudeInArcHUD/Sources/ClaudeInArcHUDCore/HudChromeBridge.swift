import Foundation
import WebKit

/// Forwards chrome.* polyfill calls from WKWebView to the extension via native messaging.
@MainActor
public final class HudChromeBridge: NSObject, WKScriptMessageHandler {
    public static let proxyRequestNotification = Notification.Name("com.claudeinarac.hud.proxy.request")
    public static let proxyResponseNotification = Notification.Name("com.claudeinarac.hud.proxy.response")

    public enum ProxyKey {
        public static let requestId = "requestId"
        public static let method = "method"
        public static let args = "args"
        public static let result = "result"
        public static let error = "error"
    }

    private weak var webView: WKWebView?
    private var observer: NSObjectProtocol?

    public init(webView: WKWebView? = nil) {
        self.webView = webView
        super.init()
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Self.proxyResponseNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            Task { @MainActor in
                self?.handleProxyResponse(note)
            }
        }
    }

    deinit {
        if let observer {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
    }

    public func attach(webView: WKWebView) {
        self.webView = webView
    }

    public func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "hudChrome",
              let body = message.body as? [String: Any],
              let requestId = body[ProxyKey.requestId] as? String,
              let method = body[ProxyKey.method] as? String else { return }

        let args = body[ProxyKey.args] as? [Any] ?? []
        NSLog("[ClaudeInArcHUD] hudChrome proxy request method=%@ id=%@", method, requestId)
        let info: [String: Any] = [
            ProxyKey.requestId: requestId,
            ProxyKey.method: method,
            ProxyKey.args: args,
        ]
        DistributedNotificationCenter.default().post(
            name: Self.proxyRequestNotification,
            object: nil,
            userInfo: info
        )
    }

    private func handleProxyResponse(_ notification: Notification) {
        guard let info = notification.userInfo,
              let requestId = info[ProxyKey.requestId] as? String,
              let webView else { return }

        var payload: [String: Any] = ["id": requestId]
        if let error = info[ProxyKey.error] as? String, !error.isEmpty {
            payload["error"] = error
        } else if let result = info[ProxyKey.result] {
            payload["result"] = result
        } else {
            payload["result"] = NSNull()
        }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }

        webView.evaluateJavaScript(
            "window.__claudeInArcHudChromeDispatch(\(json))",
            completionHandler: nil
        )
    }
}
