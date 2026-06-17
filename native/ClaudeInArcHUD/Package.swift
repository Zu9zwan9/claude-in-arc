// swift-tools-version: 5.9
// Phase 2 scaffold — optional macOS HUD companion for claude-in-arc.
// See native/README.md and docs/DYNAMIC_ISLAND.md.

import PackageDescription

let package = Package(
    name: "ClaudeInArcHUD",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ClaudeInArcHUD", targets: ["ClaudeInArcHUD"]),
        .executable(name: "ClaudeInArcHUDHost", targets: ["ClaudeInArcHUDHost"]),
        .library(name: "ClaudeInArcHUDCore", targets: ["ClaudeInArcHUDCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/MrKai77/DynamicNotchKit.git", from: "1.0.0"),
    ],
    targets: [
        .target(
            name: "ClaudeInArcHUDCore",
            dependencies: [
                .product(name: "DynamicNotchKit", package: "DynamicNotchKit"),
            ],
            path: "Sources/ClaudeInArcHUDCore"
        ),
        .executableTarget(
            name: "ClaudeInArcHUD",
            dependencies: ["ClaudeInArcHUDCore"],
            path: "Sources/ClaudeInArcHUD"
        ),
        .executableTarget(
            name: "ClaudeInArcHUDHost",
            path: "Sources/ClaudeInArcHUDHost"
        ),
    ]
)
