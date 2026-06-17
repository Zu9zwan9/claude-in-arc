import Foundation

/// Chrome native-messaging host for Claude-in-Arc HUD.
/// Protocol: 4-byte little-endian length + UTF-8 JSON per message on stdin/stdout.
/// Message schema: native/schemas/hud-message-v1.json

private let hudNotificationName = Notification.Name("com.claudeinarac.hud.message")
private let proxyRequestName = Notification.Name("com.claudeinarac.hud.proxy.request")
private let proxyResponseName = Notification.Name("com.claudeinarac.hud.proxy.response")

private struct InboundMessage: Decodable {
    var v: Int?
    var dir: String?
    var type: String?
    var tabId: Int?
    var collapsed: Bool?
    var url: String?
    var title: String?
    var visible: Bool?
    var requestId: String?
    var method: String?
    var args: [AnyCodable]?
    var result: AnyCodable?
    var error: String?
}

private struct OutboundMessage: Encodable {
    var v: Int = 1
    var dir: String = "host_to_ext"
    var type: String
    var expanded: Bool?
    var requestId: String?
    var method: String?
    var args: [AnyCodable]?
}

/// Lossy JSON value wrapper for native-messaging payloads.
private struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encode(String(describing: value))
        }
    }
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

fileprivate func forwardProxyResponse(_ decoded: InboundMessage) {
    guard let requestId = decoded.requestId else { return }
    var info: [String: Any] = ["requestId": requestId]
    if let result = decoded.result {
        info["result"] = result.value
    }
    if let error = decoded.error {
        info["error"] = error
    }
    DistributedNotificationCenter.default().post(
        name: proxyResponseName,
        object: nil,
        userInfo: info
    )
}

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

let proxyObserver = DistributedNotificationCenter.default().addObserver(
    forName: proxyRequestName,
    object: nil,
    queue: nil
) { note in
    guard let info = note.userInfo,
          let requestId = info["requestId"] as? String,
          let method = info["method"] as? String else { return }
    let args = info["args"] as? [Any] ?? []
    writeMessage(
        OutboundMessage(
            type: "hud_chrome_call",
            requestId: requestId,
            method: method,
            args: args.map { AnyCodable($0) }
        ),
        to: stdout
    )
}

defer {
    DistributedNotificationCenter.default().removeObserver(proxyObserver)
}

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
    case "hud_chrome_response":
        if let decoded { forwardProxyResponse(decoded) }
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
