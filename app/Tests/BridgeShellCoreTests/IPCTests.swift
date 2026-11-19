import XCTest

@testable import BridgeShellCore

final class IPCTests: XCTestCase {
  private func decode(_ line: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
  }

  func testEveryCommandOfV1() {
    let cases: [(ShellCommand, [String: Any])] = [
      (.pause, ["cmd": "pause"]),
      (.resume, ["cmd": "resume"]),
      (.answer(questionId: "q1", choice: "later"), ["cmd": "answer", "questionId": "q1", "choice": "later"]),
      (.export(path: "/Users/x/Desktop/d.zip"), ["cmd": "export", "path": "/Users/x/Desktop/d.zip"]),
      (.remove(bindingId: "b1", ack: true), ["cmd": "remove", "bindingId": "b1", "ack": true]),
      (.shutdown(.update), ["cmd": "shutdown", "reason": "update"]),
      (.shutdown(.quit), ["cmd": "shutdown", "reason": "quit"]),
      (.shutdown(.logout), ["cmd": "shutdown", "reason": "logout"]),
      (.openURL("lfcp-bridge://connect#k=s"), ["cmd": "openURL", "url": "lfcp-bridge://connect#k=s"]),
    ]
    for (command, fields) in cases {
      let line = command.line(id: "7")
      XCTAssertFalse(line.contains("\n"))
      let expected = fields.merging(["v": 1, "id": "7"]) { a, _ in a }
      XCTAssertEqual(NSDictionary(dictionary: decode(line)), NSDictionary(dictionary: expected), line)
    }
  }

  func testParsesEveryEvent() {
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"hello","version":"0.6.0","pid":12}"#),
      .hello(version: "0.6.0", pid: 12))
    XCTAssertEqual(
      HostEvent.parse(
        #"{"v":1,"type":"status","state":"running","sections":[{"bindingId":"b1","title":"Work","state":"active"}]}"#
      ),
      .status(
        state: .running, reason: nil,
        sections: [SectionStatus(bindingId: "b1", title: "Work", state: "active")]))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"status","state":"unavailable","reason":"start_failed","sections":[]}"#),
      .status(state: .unavailable, reason: "start_failed", sections: []))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"question","questionId":"q","bindingId":"b","kind":"guard_mass_unlink"}"#),
      .question(questionId: "q", bindingId: "b", kind: "guard_mass_unlink", resolved: false))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"needsAttention","bindingId":"b","code":"safe_mode"}"#),
      .needsAttention(bindingId: "b", code: "safe_mode"))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"needsAttention","bindingId":"b","code":null}"#),
      .needsAttention(bindingId: "b", code: nil))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"reply","id":"3","ok":true,"result":{"handled":false}}"#),
      .reply(id: "3", ok: true, errorCode: nil))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"reply","id":null,"ok":false,"error":{"code":"bad_line"}}"#),
      .reply(id: nil, ok: false, errorCode: "bad_line"))
  }

  func testNewerAndBrokenLines() {
    XCTAssertEqual(HostEvent.parse(#"{"v":1,"type":"progress"}"#), .unknown(type: "progress"))
    XCTAssertEqual(
      HostEvent.parse(#"{"v":1,"type":"status","state":"hibernating","sections":[]}"#),
      .unknown(type: "status"))
    XCTAssertNil(HostEvent.parse("not json"))
    XCTAssertNil(HostEvent.parse(#"{"v":2,"type":"hello","version":"x","pid":1}"#))
    XCTAssertNil(HostEvent.parse(#"{"v":true,"type":"hello","version":"x","pid":1}"#))
    XCTAssertNil(HostEvent.parse(#"{"v":1,"type":"hello"}"#))
    XCTAssertNil(HostEvent.parse(#"[1]"#))
  }

  func testLineBufferSplitsAndDropsOverlongLines() {
    var b = LineBuffer()
    XCTAssertEqual(b.push(Data(#"{"a":"#.utf8)).lines, [])
    XCTAssertEqual(b.push(Data("1}\r\n\n{\"b\":2}\n{\"c\"".utf8)).lines, [#"{"a":1}"#, #"{"b":2}"#])
    XCTAssertEqual(b.push(Data(":3}\n".utf8)).lines, [#"{"c":3}"#])
    let r1 = b.push(Data(String(repeating: "x", count: IPC.maxLine + 1).utf8))
    XCTAssertEqual(r1.lines, [])
    XCTAssertEqual(r1.overlong, 1)
    let r2 = b.push(Data("tail of it\n{\"d\":4}\n".utf8))
    XCTAssertEqual(r2.lines, [#"{"d":4}"#])
    XCTAssertEqual(r2.overlong, 0)
  }
}
