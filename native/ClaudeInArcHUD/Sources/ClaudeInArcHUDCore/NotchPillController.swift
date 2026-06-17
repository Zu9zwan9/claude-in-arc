import AppKit
import DynamicNotchKit
import SwiftUI

/// Collapsed Dynamic Island–style pill via DynamicNotchKit (MIT).
/// Expanded chat still uses `HUDPanelController` until M3 embeds WKWebView.
@MainActor
public final class NotchPillController: ObservableObject {
    @Published public private(set) var isExpanded = false
    @Published public var statusText = "Claude"

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
            Text(model.statusText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text("Chat bridge (M3)")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(minWidth: 280)
    }
}
