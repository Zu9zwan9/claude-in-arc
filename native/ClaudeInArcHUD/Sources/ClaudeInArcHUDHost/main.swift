import Foundation

/// Chrome native-messaging host stub.
/// Protocol: 4-byte little-endian length + UTF-8 JSON per message on stdin/stdout.
/// See https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

struct NativeMessage: Codable {
    var type: String?
    var tabId: Int?
    var text: String?
}

func readMessage(from handle: FileHandle) -> Data? {
    let lengthData = handle.readData(ofLength: 4)
    guard lengthData.count == 4 else { return nil }
    let length = lengthData.withUnsafeBytes { $0.load(as: UInt32.self) }
    guard length > 0, length < 1_048_576 else { return nil }
    let payload = handle.readData(ofLength: Int(length))
    return payload.count == Int(length) ? payload : nil
}

func writeMessage(_ object: [String: Any], to handle: FileHandle) {
    guard let json = try? JSONSerialization.data(withJSONObject: object),
          json.count <= Int(UInt32.max) else { return }
    var length = UInt32(json.count).littleEndian
    let lengthData = Data(bytes: &length, count: 4)
    handle.write(lengthData)
    handle.write(json)
}

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

writeMessage(["type": "ready", "host": "com.claudeinarac.hud"], to: stdout)

while let data = readMessage(from: stdin) {
    let decoded = try? JSONDecoder().decode(NativeMessage.self, from: data)
    let kind = decoded?.type ?? "unknown"
    if let line = String(data: data, encoding: .utf8) {
        stderr.write(Data("[ClaudeInArcHUDHost] \(line)\n".utf8))
    }
    writeMessage(
        [
            "type": "ack",
            "received": kind,
            "echoTabId": decoded?.tabId as Any,
        ],
        to: stdout
    )
}
