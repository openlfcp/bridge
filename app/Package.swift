// swift-tools-version:6.0
// LFCP Bridge.app — the shell (A§1, A§2.3, PLAN §E-004): status item, the host's supervisor, the
// stdio JSON-lines channel to the host (docs/reference/app-ipc-v1.md), the lfcp-bridge:// handler.
// The .app bundle itself is assembled by scripts/app/build-dev-app.sh (E-005: the release one).
//
//   swift test                                     the core: IPC, supervisor, menu model, URL handoff
//   swift build -c release                         the shell executable (LFCPBridge)
//   swift build -c release -Xswiftc -DLFCP_TEST_HOOKS   with the L5 smoke's hooks (never released)
import PackageDescription

let package = Package(
  name: "lfcp-bridge-app",
  platforms: [.macOS(.v15)],
  targets: [
    // Foundation and Security (the code checks of the write gate): everything the tests reach,
    // with a fake host.
    .target(name: "BridgeShellCore", path: "Sources/BridgeShellCore"),
    // AppKit, ServiceManagement: the status item, SMAppService, the app delegate.
    .executableTarget(
      name: "LFCPBridge", dependencies: ["BridgeShellCore"], path: "Sources/LFCPBridge"),
    .testTarget(
      name: "BridgeShellCoreTests", dependencies: ["BridgeShellCore"],
      path: "Tests/BridgeShellCoreTests"),
  ],
  swiftLanguageModes: [.v5]
)
