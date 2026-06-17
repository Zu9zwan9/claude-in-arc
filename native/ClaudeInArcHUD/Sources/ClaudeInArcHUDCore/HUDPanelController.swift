import AppKit

/// Borderless-ish floating panel anchored below the menu bar / notch.
public final class HUDPanelController {
    public static let defaultWidth: CGFloat = 400
    public static let defaultHeight: CGFloat = 520

    private var panel: NSPanel?

    public init() {}

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
        if let panel {
            positionBelowMenuBar(panel)
            panel.orderFrontRegardless()
            return
        }

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

        let placeholder = NSHostingPlaceholderView(frame: panel.contentView?.bounds ?? .zero)
        panel.contentView = placeholder

        positionBelowMenuBar(panel)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    public func hide() {
        panel?.orderOut(nil)
    }

    /// Center horizontally under the menu bar / notch gap.
    /// Uses `auxiliaryTopLeftArea` + `auxiliaryTopRightArea` when present (notched MacBooks),
    /// matching the pattern used by Boring Notch and other OSS notch overlays.
    public func positionBelowMenuBar(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.frame
        let size = panel.frame.size

        let x: CGFloat
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            // Notch span: center the HUD in the gap between auxiliary areas.
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

/// Minimal placeholder until WKWebView loads extension sidepanel.html.
private final class NSHostingPlaceholderView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()

        let text = "Claude in Arc HUD (scaffold)\n\nNative messaging + sidepanel bridge TBD."
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        let attributed = NSAttributedString(string: text, attributes: attrs)
        let size = attributed.size()
        let rect = NSRect(
            x: (bounds.width - size.width) / 2,
            y: (bounds.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
        attributed.draw(in: rect)
    }
}
