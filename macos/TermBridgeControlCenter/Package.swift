// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TermBridgeControlCenter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TermBridgeControlCenter", targets: ["TermBridgeControlCenter"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.20.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.6"),
        .package(path: "Vendor/CodeEditTextView"),
    ],
    targets: [
        .executableTarget(name: "TermBridgeControlCenter", dependencies: ["SwiftTerm", "Sparkle", "CodeEditTextView"],
            resources: [.copy("Resources/AgentChat"), .copy("Resources/Desktop"), .copy("Resources/MarkdownPreview"), .copy("Resources/CodeEditor-LICENSES.txt")],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .testTarget(
            name: "TermBridgeControlCenterTests",
            dependencies: ["TermBridgeControlCenter"]
        ),
    ]
)
