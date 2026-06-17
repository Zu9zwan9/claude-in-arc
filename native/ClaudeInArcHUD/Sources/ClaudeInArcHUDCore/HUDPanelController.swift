import AppKit
import WebKit

/// Borderless-ish floating panel anchored below the menu bar / notch.
@MainActor
public final class HUDPanelController: NSObject {
    public static let defaultWidth: CGFloat = 400
    public static let defaultHeight: CGFloat = 520
    private static let bridgeScheme = "claude-in-arc-ext"

    private var panel: NSPanel?
    private var webView: WKWebView?
    private var chromeBridge: HudChromeBridge?
    private var schemeHandler: ExtensionSchemeHandler?
    private var extensionRoot: URL?

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
        if extensionRoot == nil {
            extensionRoot = ExtensionRootResolver.resolve()
        }
        if let root = extensionRoot {
            NSLog("[ClaudeInArcHUD] extension root=%@", root.path)
        } else {
            NSLog("[ClaudeInArcHUD] extension root not found")
        }

        if let panel, let webView {
            positionBelowMenuBar(panel)
            panel.orderFrontRegardless()
            loadBridge()
            webView.becomeFirstResponder()
            return
        }

        guard let extensionRoot else {
            showMissingExtensionPanel()
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
        }

        // Register script message handler before WKWebView init — config is copied at creation.
        let bridge = HudChromeBridge()
        chromeBridge = bridge
        config.userContentController.add(bridge, name: "hudChrome")

        let webView = WKWebView(frame: .zero, configuration: config)
        bridge.attach(webView: webView)
        self.webView = webView

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight),
            styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Claude"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false

        webView.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView(frame: NSRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight))
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        panel.contentView = container

        positionBelowMenuBar(panel)
        panel.orderFrontRegardless()
        self.panel = panel
        loadBridge()
    }

    public func hide() {
        panel?.orderOut(nil)
    }

    public func focusChatInput() {
        webView?.becomeFirstResponder()
    }

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
            return
        }
        NSLog("[ClaudeInArcHUD] loadBridge url=%@ tabId=%@", urlString, pageTabId.map(String.init) ?? "nil")
        webView.load(URLRequest(url: url))
    }

    private func showMissingExtensionPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight),
            styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Claude"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isReleasedWhenClosed = false

        let label = NSTextField(labelWithString:
            "Claude extension not found.\n\nRun:\n  claude-in-arc install\n  claude-in-arc hud install\nThen reload arc://extensions."
        )
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: 13)
        label.maximumNumberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView(frame: panel.contentView?.bounds ?? .zero)
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -48),
        ])
        panel.contentView = container
        positionBelowMenuBar(panel)
        panel.orderFrontRegardless()
        self.panel = panel
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
