import AppKit

/// Connection feedback lives in the terminal viewport, where the user is looking.
@MainActor
final class TerminalStatusView: NSView {
    let title = NSTextField(labelWithString: "正在连接终端")
    let detail = NSTextField(wrappingLabelWithString: "")
    private let icon = NSImageView()
    private let spinner = NSProgressIndicator()
    private let retry = NSButton(title: "重新连接", target: nil, action: nil)
    var onRetry: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(white: 0.065, alpha: 1).cgColor
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.alignment = .center
        detail.font = .systemFont(ofSize: 13)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 5
        detail.setContentCompressionResistancePriority(.required, for: .vertical)
        icon.contentTintColor = .secondaryLabelColor
        icon.imageScaling = .scaleProportionallyUpOrDown
        spinner.style = .spinning; spinner.controlSize = .small
        retry.bezelStyle = .rounded; retry.controlSize = .large
        retry.target = self; retry.action = #selector(reconnect)
        let stack = NSStackView(views: [icon, title, detail, spinner, retry])
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -18),
            stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            icon.widthAnchor.constraint(equalToConstant: 34), icon.heightAnchor.constraint(equalToConstant: 34),
        ])
    }
    required init?(coder: NSCoder) { nil }

    func show(title: String, detail: String, waiting: Bool, retryAvailable: Bool = true) {
        self.title.stringValue = title; self.detail.stringValue = detail
        icon.image = NSImage(systemSymbolName: waiting ? "terminal" : "exclamationmark.circle", accessibilityDescription: nil)
        retry.isHidden = waiting || !retryAvailable; spinner.isHidden = !waiting
        if waiting { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        isHidden = false
    }
    @objc private func reconnect() { onRetry?() }
}
