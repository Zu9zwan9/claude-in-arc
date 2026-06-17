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

        let args = plistSafeValue(body[ProxyKey.args] as? [Any] ?? []) as? [Any] ?? []
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
              let json = String(data: data, encoding: .utf8) else {
            NSLog("[ClaudeInArcHUD] hudChrome proxy response encode failed id=%@", requestId)
            return
        }

        NSLog("[ClaudeInArcHUD] hudChrome proxy response id=%@", requestId)
        webView.evaluateJavaScript(
            "window.__claudeInArcHudChromeDispatch(\(json))",
            completionHandler: { _, error in
                if let error {
                    NSLog("[ClaudeInArcHUD] hudChrome dispatch failed id=%@ error=%@", requestId, error.localizedDescription)
                }
            }
        )
    }

    /// Distributed notifications require property-list types.
    private func plistSafeValue(_ value: Any) -> Any {
        switch value {
        case is NSNull:
            return NSNull()
        case let string as String:
            return string
        case let number as NSNumber:
            return number
        case let bool as Bool:
            return bool
        case let int as Int:
            return int
        case let double as Double:
            return double
        case let array as [Any]:
            return array.map { plistSafeValue($0) }
        case let dict as [String: Any]:
            return dict.mapValues { plistSafeValue($0) }
        case let array as NSArray:
            return array.map { plistSafeValue($0) }
        case let dict as NSDictionary:
            var out: [String: Any] = [:]
            for (key, val) in dict {
                if let key = key as? String {
                    out[key] = plistSafeValue(val)
                }
            }
            return out
        default:
            return String(describing: value)
        }
    }
}
