import XCTest

@testable import BridgeShellCore

final class PeerCredentialsTests: XCTestCase {
  func testThePeerOfAConnectedUnixSocketIsThisUser() {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    defer {
      close(fds[0])
      close(fds[1])
    }
    XCTAssertEqual(PeerCredentials.uid(of: fds[0]), geteuid())
  }

  func testNotASocketIsNotTold() {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&fds), 0)
    defer {
      close(fds[0])
      close(fds[1])
    }
    XCTAssertNil(PeerCredentials.uid(of: fds[0]))
  }
}
