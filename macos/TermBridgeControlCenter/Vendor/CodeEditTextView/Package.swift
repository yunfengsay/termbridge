// swift-tools-version: 5.9
import PackageDescription

// Sources are unmodified CodeEditTextView 0.12.1. Only the manifest is reduced:
// use the actual DequeModule dependency and omit upstream's lint build plugin.
let package = Package(
    name: "CodeEditTextView",
    platforms: [.macOS(.v13)],
    products: [.library(name: "CodeEditTextView", targets: ["CodeEditTextView"])],
    dependencies: [
        .package(url: "https://github.com/ChimeHQ/TextStory", exact: "0.9.2"),
        .package(url: "https://github.com/apple/swift-collections.git", exact: "1.7.3"),
    ],
    targets: [
        .target(name: "CodeEditTextView", dependencies: [
            "TextStory", .product(name: "DequeModule", package: "swift-collections"), "CodeEditTextViewObjC"
        ], exclude: ["Documentation.docc"]),
        .target(name: "CodeEditTextViewObjC", publicHeadersPath: "include"),
    ]
)
