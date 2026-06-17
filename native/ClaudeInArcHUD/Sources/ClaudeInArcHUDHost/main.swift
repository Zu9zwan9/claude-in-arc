import Foundation

/// Chrome native-messaging host for Claude-in-Arc HUD.
/// Protocol: 4-byte little-endian length + UTF-8 JSON per message on stdin/stdout.
/// Message schema: native/schemas/hud-message-v1.json

private let hudNotificationName = Notification.Name("com.claudeinarac.hud.message")

private struct InboundMessage: Decodable {
    var v: Int?
    var dir: String?
    var type: String?
    var tabId: Int?
    var collapsed: Bool?
    var url: String?
    var title: String?
    var visible: Bool?
}

private struct OutboundMessage: Encodable {
    var v: Int = 1
    var dir: String = "host_to_ext"
    var type: String
    var expanded: Bool?
}

func readMessage(from handle: FileHandle) -> Data? {
    let lengthData = handle.readData(ofLength: 4)
    guard lengthData.count == 4 else { return nil }
    let length = lengthData.withUnsafeBytes { $0.load(as: UInt32.self) }
    guard length > 0, length < 1_048_576 else { return nil }
    let payload = handle.readData(ofLength: Int(length))
    return payload.count == Int(length) ? payload : nil
}

func writeMessage<T: Encodable>(_ message: T, to handle: FileHandle) {
    guard let json = try? JSONEncoder().encode(message),
          json.count <= Int(UInt32.max) else { return }
    var length = UInt32(json.count).littleEndian
    let lengthData = Data(bytes: &length, count: 4)
    handle.write(lengthData)
    handle.write(json)
}

fileprivate func forwardToApp(_ decoded: InboundMessage) {
    guard let type = decoded.type else { return }
    var info: [String: Any] = ["type": type]
    if let tabId = decoded.tabId { info["tabId"] = tabId }
    if let url = decoded.url { info["url"] = url }
    if let title = decoded.title { info["title"] = title }
    if let collapsed = decoded.collapsed { info["collapsed"] = collapsed }
    if let visible = decoded.visible { info["visible"] = visible }
    DistributedNotificationCenter.default().post(
        name: hudNotificationName,
        object: nil,
        userInfo: info
    )
}

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

writeMessage(OutboundMessage(type: "hud_ready"), to: stdout)

while let data = readMessage(from: stdin) {
    if let line = String(data: data, encoding: .utf8) {
        stderr.write(Data("[ClaudeInArcHUDHost] \(line)\n".utf8))
    }

    let decoded = try? JSONDecoder().decode(InboundMessage.self, from: data)
    let kind = decoded?.type ?? "unknown"

    switch kind {
    case "ping":
        writeMessage(OutboundMessage(type: "pong"), to: stdout)
    case "toggle_hud":
        if let decoded { forwardToApp(decoded) }
        writeMessage(OutboundMessage(type: "hud_expanded", expanded: true), to: stdout)
    case "set_collapsed":
        if let decoded { forwardToApp(decoded) }
        let collapsed = decoded?.collapsed ?? true
        writeMessage(
            OutboundMessage(type: collapsed ? "hud_collapsed" : "hud_expanded", expanded: !collapsed),
            to: stdout
        )
    case "page_context":
        if let decoded { forwardToApp(decoded) }
        writeMessage(OutboundMessage(type: "pong"), to: stdout)
    case "sidebar_state":
        if let decoded {
            if decoded.visible == false {
                forwardToApp(InboundMessage(type: "set_collapsed", collapsed: true))
            } else if decoded.visible == true {
                forwardToApp(InboundMessage(type: "toggle_hud"))
            } else {
                forwardToApp(decoded)
            }
        }
        writeMessage(OutboundMessage(type: "pong"), to: stdout)
    default:
        writeMessage(OutboundMessage(type: "pong"), to: stdout)
    }
}
