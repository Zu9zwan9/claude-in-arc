import AppKit
import DynamicNotchKit
import SwiftUI

/// Collapsed Dynamic Island–style pill via DynamicNotchKit (MIT).
/// Expanded notch shows page context; chat lives in `HUDPanelController` (WKWebView).
@MainActor
public final class NotchPillController: ObservableObject {
    @Published public private(set) var isExpanded = false
    @Published public var statusText = "Claude"
    @Published public private(set) var pageTitle = ""
    @Published public private(set) var pageURL = ""
    @Published public private(set) var pageTabId: Int?

    private var notch: DynamicNotch<
        NotchExpandedView,
        NotchCompactLeadingView,
        NotchCompactTrailingView
    >?

    public init() {}

    private func ensureNotch() {
        guard notch == nil else { return }
        let model = self
        notch = DynamicNotch(style: .auto) {
            NotchExpandedView(model: model)
        } compactLeading: {
            NotchCompactLeadingView()
        } compactTrailing: {
            NotchCompactTrailingView(model: model)
        }
    }

    public func showCollapsed(on screen: NSScreen? = nil) {
        ensureNotch()
        let target = screen ?? NSScreen.main ?? NSScreen.screens.first
        guard let target else { return }

        Task {
            await notch?.compact(on: target)
            isExpanded = false
        }
    }

    public func expand(on screen: NSScreen? = nil) {
        ensureNotch()
        let target = screen ?? NSScreen.main ?? NSScreen.screens.first
        guard let target else { return }

        Task {
            await notch?.expand(on: target)
            isExpanded = true
        }
    }

    public func hide() {
        Task {
            await notch?.hide()
            isExpanded = false
        }
    }

    public func updatePageContext(title: String, url: String, tabId: Int?) {
        pageTitle = title
        pageURL = url
        pageTabId = tabId
        if !title.isEmpty {
            statusText = title.count > 40 ? String(title.prefix(37)) + "…" : title
        } else if !url.isEmpty {
            statusText = url
        } else {
            statusText = "Claude"
        }
    }
}

private struct NotchCompactLeadingView: View {
    var body: some View {
        Image(systemName: "bubble.left.and.bubble.right.fill")
            .font(.system(size: 11, weight: .semibold))
    }
}

private struct NotchCompactTrailingView: View {
    @ObservedObject var model: NotchPillController

    var body: some View {
        Text(model.statusText)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
    }
}

private struct NotchExpandedView: View {
    @ObservedObject var model: NotchPillController

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                Text("Claude in Arc")
                    .font(.system(size: 13, weight: .semibold))
            }
            if !model.pageTitle.isEmpty {
                Text(model.pageTitle)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(2)
            }
            if !model.pageURL.isEmpty {
                Text(model.pageURL)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if !model.statusText.isEmpty && model.statusText != "Claude" {
                Text(model.statusText)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let tabId = model.pageTabId {
                Text("tab \(tabId)")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Text("Press ⌘E to open the chat panel below the notch")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(minWidth: 280)
    }
}
