// swift-tools-version:5.7
// LFCP Reminders Helper (D-010 r4 §8). The primary build is scripts/build.sh (swiftc only, works
// with Command Line Tools); this manifest is an additional check on machines with a full toolchain.
import PackageDescription

let package = Package(
    name: "lfcp-reminders-helper",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "HelperCore", targets: ["HelperCore"]),
    ],
    targets: [
        // Pure protocol core: JSON, protocol v2, field rules, memory backend. No EventKit.
        .target(name: "HelperCore", path: "Sources/HelperCore"),
        // XCTest is not available with Command Line Tools only, so the tests are an executable.
        .executableTarget(name: "helper-core-tests", dependencies: ["HelperCore"], path: "Tests/HelperCoreTests"),
    ]
)
