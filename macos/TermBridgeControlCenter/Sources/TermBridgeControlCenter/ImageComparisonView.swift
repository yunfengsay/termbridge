import AppKit
import QuickLookThumbnailing

/// One version of an image in a comparison: what it is called and its bytes.
struct ImageVersion {
    let title: String
    let name: String
    let data: Data?
    /// Why there is no picture, when there is none.
    let note: String?
}

/// A changed image before and after, side by side, or a single version for an
/// added or deleted one. Transparency shows over a checkerboard.
@MainActor
final class ImageComparisonView: NSView {
    private var columns: [NSView] = []
    private var loads: [Task<Void, Never>] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) { nil }

    func show(_ versions: [ImageVersion]) {
        loads.forEach { $0.cancel() }
        loads = []
        columns.forEach { $0.removeFromSuperview() }
        columns = versions.map { ImageColumn(title: $0.title) }
        // Equal columns filling the whole area, side by side.
        for (index, column) in columns.enumerated() {
            column.translatesAutoresizingMaskIntoConstraints = false
            addSubview(column)
            NSLayoutConstraint.activate([
                column.topAnchor.constraint(equalTo: topAnchor, constant: 16),
                column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
                index == 0 ? column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16)
                    : column.leadingAnchor.constraint(equalTo: columns[index - 1].trailingAnchor, constant: 16),
            ])
            if index > 0 { column.widthAnchor.constraint(equalTo: columns[0].widthAnchor).isActive = true }
        }
        columns.last?.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16).isActive = true
        for (version, view) in zip(versions, columns) {
            guard let column = view as? ImageColumn else { continue }
            guard let data = version.data else {
                column.show(image: nil, detail: version.note ?? "没有这个版本")
                continue
            }
            let size = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
            if let image = NSImage(data: data), image.isValid {
                column.show(image: image, detail: Self.describe(image, size: size))
                continue
            }
            column.show(image: nil, detail: "正在生成预览… · \(size)")
            loads.append(Task { [weak column] in
                let image = await Self.thumbnail(data: data, name: version.name)
                guard !Task.isCancelled else { return }
                column?.show(image: image, detail: image.map { Self.describe($0, size: size) } ?? "无法显示此图片格式 · \(size)")
            })
        }
    }

    private static func describe(_ image: NSImage, size: String) -> String {
        let pixels = image.representations.map { NSSize(width: $0.pixelsWide, height: $0.pixelsHigh) }.max { $0.width < $1.width }
        guard let pixels, pixels.width > 0 else { return size }
        return "\(Int(pixels.width)) × \(Int(pixels.height)) · \(size)"
    }

    /// Formats NSImage cannot decode (SVG on some systems, PSD…) through Quick Look.
    private static func thumbnail(data: Data, name: String) async -> NSImage? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("TermBridge-Image-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let url = directory.appendingPathComponent((name as NSString).lastPathComponent)
            try data.write(to: url, options: .atomic)
            let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 1_024, height: 1_024),
                                                       scale: 2, representationTypes: .thumbnail)
            let representation = try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
            return representation.nsImage
        } catch { return nil }
    }
}

private final class ImageColumn: NSView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let canvas = CheckerboardView()
    private let imageView = NSImageView()

    init(title value: String) {
        super.init(frame: .zero)
        title.stringValue = value
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingMiddle
        imageView.imageScaling = .scaleProportionallyDown
        imageView.animates = true
        // A large picture shrinks into the column instead of growing the window.
        for axis in [NSLayoutConstraint.Orientation.horizontal, .vertical] {
            imageView.setContentHuggingPriority(.defaultLow, for: axis)
            imageView.setContentCompressionResistancePriority(.defaultLow, for: axis)
        }
        imageView.setAccessibilityLabel(value)
        for view in [title, detail, canvas] { view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view) }
        imageView.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(imageView)
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: topAnchor),
            title.leadingAnchor.constraint(equalTo: leadingAnchor),
            detail.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
            detail.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 8),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            canvas.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            canvas.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvas.bottomAnchor.constraint(equalTo: bottomAnchor),
            imageView.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 8),
            imageView.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 8),
            imageView.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -8),
            imageView.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func show(image: NSImage?, detail value: String) {
        imageView.image = image
        detail.stringValue = value
        // An icon a few pixels wide is enlarged with hard edges; anything else only shrinks to fit.
        let pixels = image?.representations.map { max($0.pixelsWide, $0.pixelsHigh) }.max() ?? 0
        imageView.imageScaling = pixels > 0 && pixels <= 64 ? .scaleProportionallyUpOrDown : .scaleProportionallyDown
        imageView.wantsLayer = true
        imageView.layer?.magnificationFilter = .nearest
    }
}

/// The usual grey checkerboard behind transparent pixels.
private final class CheckerboardView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.masksToBounds = true
        layer?.borderWidth = 1
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let a: CGFloat = dark ? 0.16 : 0.97, b: CGFloat = dark ? 0.22 : 0.90
        let tile = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            NSColor(white: a, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 16, height: 16).fill()
            NSColor(white: b, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: 8, height: 8).fill(); NSRect(x: 8, y: 8, width: 8, height: 8).fill()
            return true
        }
        layer?.backgroundColor = NSColor(patternImage: tile).cgColor
        layer?.borderColor = NSColor.separatorColor.cgColor
    }
}
