// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TermbridgeCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "Termbridge", targets: ["Termbridge"])
    ],
    targets: [
        .target(
            name: "Termbridge",
            path: "Termbridge",
            exclude: [
                "App",
                "AgentChat/AgentChatScreen.swift",
                "AgentChat/AgentChatViewModel.swift",
                "AgentChat/AgentChatWebView.swift",
                "Info.plist",
                "Networking",
                "Resources",
                "Terminal/TerminalWebView.swift",
                "Views"
            ],
            sources: [
                "Models/SessionInfo.swift",
                "AgentChat/AgentChatState.swift",
                "Models/AppNavigation.swift",
                "Models/AgentCompletionTracker.swift",
                "Terminal/ComposerPayload.swift",
                "Terminal/ComposerAttachment.swift",
                "Review/ReviewPresentation.swift",
                "Review/ReviewNavigatorPresentation.swift",
                "Review/ReviewFileIcon.swift",
                "Review/ReviewSyntaxHighlighter.swift",
                "Protocol/FrameCodec.swift",
                "Protocol/MessagePack.swift",
                "Security/ConnectionSettings.swift",
                "Security/PairingCode.swift",
                "Security/HMACHelper.swift"
            ]
        ),
        .testTarget(
            name: "TermbridgeTests",
            dependencies: ["Termbridge"],
            path: "TermbridgeTests"
        )
    ]
)
