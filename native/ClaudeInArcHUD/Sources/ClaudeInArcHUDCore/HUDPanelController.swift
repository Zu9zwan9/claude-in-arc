import AppKit
import WebKit

/// Borderless-ish floating panel anchored below the menu bar / notch.
/// Chat UI lives here — the DynamicNotchKit pill stays compact (page context only).
@MainActor
public final class HUDPanelController: NSObject {
    public static let defaultWidth: CGFloat = 400
    public static let defaultHeight: CGFloat = 520
    private static let bridgeScheme = "claude-in-arc-ext"
    private static let panelLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)

    private var panel: NSPanel?
    private var webView: WKWebView?
    private var chromeBridge: HudChromeBridge?
    private var schemeHandler: ExtensionSchemeHandler?
    private var extensionRoot: URL?
    private var debugLabel: NSTextField?
    private var navigationDelegate: PanelNavigationDelegate?

    public private(set) var pageTitle = ""
    public private(set) var pageURL = ""
    public private(set) var pageTabId: Int?

    public override init() {
        super.init()
        extensionRoot = ExtensionRootResolver.resolve()
    }

    public func updatePageContext(title: String, url: String, tabId: Int?) {
        let tabChanged = tabId != pageTabId
        pageTitle = title
        pageURL = url
        pageTabId = tabId
        if tabChanged, isVisible {
            loadBridge()
        }
    }

    public var isVisible: Bool {
        panel?.isVisible == true
    }

    public func toggle() {
        if isVisible {
            hide()
        } else {
            show()
        }
    }

    public func show() {
        let diagnostics = ExtensionRootResolver.diagnose()
        if let root = diagnostics.root {
            extensionRoot = root
            NSLog("[ClaudeInArcHUD] extension root=%@", root.path)
        } else {
            extensionRoot = ExtensionRootResolver.resolve()
            NSLog("[ClaudeInArcHUD] extension root not found")
        }

        if let blocking = diagnostics.blockingMessage {
            NSLog("[ClaudeInArcHUD] blocking: %@", blocking)
            presentPanelShell()
            setDebugStatus("Error — see panel")
            showBridgeError(blocking)
            bringPanelForward()
            return
        }

        guard let extensionRoot else {
            showMissingExtensionPanel()
            return
        }

        if let panel, webView != nil {
            positionBelowMenuBar(panel)
            bringPanelForward()
            loadBridge()
            focusWebView()
            setDebugStatus("Loading…")
            return
        }

        let config = WKWebViewConfiguration()
        let handler = ExtensionSchemeHandler(extensionRoot: extensionRoot)
        schemeHandler = handler
        config.setURLSchemeHandler(handler, forURLScheme: Self.bridgeScheme)

        let polyfillPath = extensionRoot.appendingPathComponent("claude-arc-hud-chrome-polyfill.js")
        if let polyfill = try? String(contentsOf: polyfillPath, encoding: .utf8) {
            let script = WKUserScript(
                source: polyfill,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
            config.userContentController.addUserScript(script)
            NSLog("[ClaudeInArcHUD] injected chrome polyfill from %@", polyfillPath.path)
        } else {
            NSLog("[ClaudeInArcHUD] chrome polyfill missing at %@", polyfillPath.path)
            presentPanelShell()
            setDebugStatus("Polyfill missing")
            showBridgeError(
                "Chrome polyfill missing. Run claude-in-arc install --panel-mode hud, then Reload arc://extensions."
            )
            bringPanelForward()
            return
        }

        let bridge = HudChromeBridge()
        chromeBridge = bridge
        config.userContentController.add(bridge, name: "hudChrome")

        let webView = WKWebView(frame: .zero, configuration: config)
        bridge.attach(webView: webView)
        let navDelegate = PanelNavigationDelegate(owner: self)
        navigationDelegate = navDelegate
        webView.navigationDelegate = navDelegate
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView

        let panel = makePanel(width: Self.defaultWidth, height: Self.defaultHeight)
        embed(webView, in: panel)
        positionBelowMenuBar(panel)
        self.panel = panel
        setDebugStatus("Loading bridge…")
        bringPanelForward()
        loadBridge()
    }

    public func hide() {
        panel?.orderOut(nil)
        setDebugStatus("Hidden")
    }

    public func focusChatInput() {
        focusWebView()
    }

    // MARK: - Navigation callbacks (PanelNavigationDelegate)

    fileprivate func navigationDidFinish(url: String?) {
        NSLog("[ClaudeInArcHUD] navigation finished url=%@", url ?? "nil")
        if let url, url.contains("claude-arc-hud-bridge") {
            setDebugStatus("Bridge loaded — loading chat…")
        } else if let url, url.contains("sidepanel.html") {
            setDebugStatus("Chat panel loaded")
        }
    }

    fileprivate func navigationDidFail(url: String?, error: String) {
        NSLog("[ClaudeInArcHUD] navigation failed url=%@ error=%@", url ?? "nil", error)
        setDebugStatus("Load failed")
        let detail = url.map { "\($0)\n\n\(error)" } ?? error
        showBridgeError("Could not load Claude panel.\n\n\(detail)")
    }

    // MARK: - Private

    private func loadBridge() {
        guard let webView else {
            NSLog("[ClaudeInArcHUD] loadBridge skipped — no webView")
            return
        }
        var path = "claude-arc-hud-bridge.html"
        if let tabId = pageTabId {
            path += "?tabId=\(tabId)"
        }
        let urlString = "\(Self.bridgeScheme)://localhost/\(path)"
        guard let url = URL(string: urlString) else {
            NSLog("[ClaudeInArcHUD] loadBridge invalid url=%@", urlString)
            setDebugStatus("Invalid bridge URL")
            showBridgeError("Internal error: invalid bridge URL.")
            return
        }
        NSLog("[ClaudeInArcHUD] loadBridge url=%@ tabId=%@", urlString, pageTabId.map(String.init) ?? "nil")
        setDebugStatus("Loading bridge…")
        webView.load(URLRequest(url: url))
    }

    private func makePanel(width: CGFloat, height: CGFloat) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Claude"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isFloatingPanel = true
        panel.level = Self.panelLevel
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .fullScreenPrimary]
        panel.isReleasedWhenClosed = false
        panel.acceptsMouseMovedEvents = true
        panel.backgroundColor = NSColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        return panel
    }

    private func presentPanelShell() {
        if panel == nil {
            let panel = makePanel(width: Self.defaultWidth, height: Self.defaultHeight)
            let container = panelContainer(width: Self.defaultWidth, height: Self.defaultHeight)
            panel.contentView = container
            positionBelowMenuBar(panel)
            self.panel = panel
        }
        if webView == nil, let container = panel?.contentView {
            let placeholder = NSTextField(labelWithString: "")
            placeholder.tag = 9001
            placeholder.alignment = .center
            placeholder.textColor = .secondaryLabelColor
            placeholder.font = .systemFont(ofSize: 13)
            placeholder.maximumNumberOfLines = 0
            placeholder.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(placeholder)
            NSLayoutConstraint.activate([
                placeholder.centerXAnchor.constraint(equalTo: container.centerXAnchor),
                placeholder.centerYAnchor.constraint(equalTo: container.centerYAnchor),
                placeholder.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -48),
            ])
        }
    }

    private func panelContainer(width: CGFloat, height: CGFloat) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1).cgColor

        let debug = NSTextField(labelWithString: "Claude HUD")
        debug.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        debug.textColor = .tertiaryLabelColor
        debug.lineBreakMode = .byTruncatingMiddle
        debug.translatesAutoresizingMaskIntoConstraints = false
        debug.tag = 9002
        container.addSubview(debug)
        NSLayoutConstraint.activate([
            debug.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            debug.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            debug.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -4),
        ])
        debugLabel = debug
        return container
    }

    private func embed(_ webView: WKWebView, in panel: NSPanel) {
        let container = panelContainer(width: Self.defaultWidth, height: Self.defaultHeight)
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -18),
        ])
        panel.contentView = container
    }

    private func bringPanelForward() {
        guard let panel else { return }
        positionBelowMenuBar(panel)
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        focusWebView()
        NSLog("[ClaudeInArcHUD] panel shown frame=%@", NSStringFromRect(panel.frame))
    }

    private func focusWebView() {
        guard let panel, let webView else { return }
        panel.makeFirstResponder(webView)
        _ = webView.becomeFirstResponder()
    }

    private func setDebugStatus(_ text: String) {
        debugLabel?.stringValue = text
        NSLog("[ClaudeInArcHUD] status: %@", text)
    }

    private func showBridgeError(_ message: String) {
        if let webView {
            guard let data = try? JSONSerialization.data(withJSONObject: message),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript(
                """
                (function(m){
                  var el=document.getElementById('claude-in-arc-hud-bridge-error');
                  if(el){el.textContent=m;}
                  if(document.body){document.body.setAttribute('data-error','true');}
                })(\(json));
                """,
                completionHandler: nil
            )
            return
        }
        if let container = panel?.contentView,
           let label = container.viewWithTag(9001) as? NSTextField {
            label.stringValue = message
        }
    }

    private func showMissingExtensionPanel() {
        presentPanelShell()
        setDebugStatus("Extension not found")
        showBridgeError(
            """
            Claude extension not found.

            Run:
              claude-in-arc install --panel-mode hud
              claude-in-arc hud install
            Then Reload arc://extensions.
            """
        )
        bringPanelForward()
    }

    /// Center horizontally under the menu bar / notch gap.
    public func positionBelowMenuBar(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.frame
        let size = panel.frame.size

        let x: CGFloat
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let notchLeft = left.maxX
            let notchRight = right.minX
            let notchMid = (notchLeft + notchRight) / 2
            x = notchMid - size.width / 2
        } else {
            x = screenFrame.midX - size.width / 2
        }

        let menuBarHeight = screenFrame.maxY - screen.visibleFrame.maxY
        let y = screenFrame.maxY - menuBarHeight - size.height - 8
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - WKNavigationDelegate

@MainActor
private final class PanelNavigationDelegate: NSObject, WKNavigationDelegate {
    private weak var owner: HUDPanelController?

    init(owner: HUDPanelController) {
        self.owner = owner
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        owner?.navigationDidFinish(url: webView.url?.absoluteString)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        owner?.navigationDidFail(url: webView.url?.absoluteString, error: error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        owner?.navigationDidFail(url: webView.url?.absoluteString, error: error.localizedDescription)
    }
}
