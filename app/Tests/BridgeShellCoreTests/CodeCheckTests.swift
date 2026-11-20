import XCTest

@testable import BridgeShellCore

/// The write gate's code checks (A§9.1 (3)–(5)): what can be checked without a signed release
/// build. The checks on a real artifact (a broken seal, another shell, another helper) are L5.
final class CodeCheckTests: XCTestCase {
  private func tempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    return dir
  }

  func testAnUnsignedBundleIsNotValidAndItsFilesHaveNoCdhash() throws {
    let dir = try tempDir()
    let file = dir.appendingPathComponent("tool")
    try Data([0xCF, 0xFA, 0xED, 0xFE, 0, 0, 0, 0]).write(to: file)
    XCTAssertNotNil(CodeCheck.checkValidity(dir.appendingPathComponent("missing.app")))
    XCTAssertNotNil(CodeCheck.checkValidity(dir))
    XCTAssertThrowsError(try CodeCheck.cdhash(file: file, arch: CodeCheck.arch))
    switch CodeCheck.run(bundle: dir, paths: ["tool", "../etc/passwd"]) {
    case .failed(let why):
      XCTAssertTrue(why.hasPrefix("the running shell: OSStatus"), why)
    case .identity(let i):
      XCTAssertEqual(i.arch, CodeCheck.arch)
      XCTAssertFalse(i.valid)
      XCTAssertNotNil(i.detail)
      XCTAssertTrue(i.nested.isEmpty)
      XCTAssertEqual(i.shell.count, 40)
    }
  }

  func testTheRunningCodeHasACdhashOrSaysWhyNot() {
    // The test runner is signed (ad hoc at least): its cdhash is 20 bytes, lowercase hex.
    do {
      let h = try CodeCheck.runningCdhash()
      XCTAssertNotNil(h.range(of: "^[0-9a-f]{40}$", options: .regularExpression), h)
    } catch {
      XCTAssertTrue("\(error)".hasPrefix("OSStatus"))
    }
  }

  func testASignedSystemToolHasACdhashForItsSlice() throws {
    // /usr/bin/true is a universal Apple binary (arm64e, x86_64): a slice by name either reads or
    // says why not; when it reads, it is a cdhash.
    let url = URL(fileURLWithPath: "/usr/bin/true")
    if let h = try? CodeCheck.cdhash(file: url, arch: "x86_64") {
      XCTAssertNotNil(h.range(of: "^[0-9a-f]{40}$", options: .regularExpression), h)
    }
    XCTAssertNil(CodeCheck.checkValidity(url))
  }
}
