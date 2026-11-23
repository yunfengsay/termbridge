// swift-tools-version: 5.9
import PackageDescription

let package = Package(name: "TermBridgeDesktop", platforms: [.macOS(.v14)],
    products: [.executable(name: "termbridge-desktop", targets: ["TermBridgeDesktop"])],
    targets: [.executableTarget(name: "TermBridgeDesktop"),
              .testTarget(name: "TermBridgeDesktopTests", dependencies: ["TermBridgeDesktop"])])
