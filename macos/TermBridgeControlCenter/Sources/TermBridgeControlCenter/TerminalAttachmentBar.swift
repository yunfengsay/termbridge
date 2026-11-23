import AppKit
import SwiftUI

struct TerminalAttachmentBar: View {
    @ObservedObject var attachments: TerminalAttachments
    let send: () -> Void
    let focusTerminal: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(attachments.items) { item in
                        HStack(spacing: 6) {
                            if let data = item.image?.data, let image = NSImage(data: data) {
                                Image(nsImage: image).resizable().scaledToFit().frame(width: 42, height: 42)
                            } else { Image(systemName: "photo").frame(width: 42, height: 42) }
                            VStack(alignment: .leading) {
                                Text(item.state.label).font(.caption).lineLimit(2)
                                if case .failed = item.state {
                                    Button("重试") { attachments.retry(item.id); focusTerminal() }.font(.caption)
                                }
                            }
                            Button { attachments.remove(item.id); focusTerminal() } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).help("移除图片")
                        }.padding(6).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                    }
                    if let error = attachments.error { Text(error).font(.caption).foregroundStyle(.red) }
                }
            }
            if !attachments.items.isEmpty || !attachments.draft.isEmpty {
                VStack(alignment: .trailing, spacing: 6) {
                    Button(action: send) {
                        HStack(spacing: 6) {
                            if attachments.pendingSubmission != nil { ProgressView().controlSize(.small) }
                            else { Image(systemName: "arrow.up") }
                            Text(attachments.pendingSubmission == nil ? "发送" : "等待上传")
                        }
                        .frame(minWidth: 76)
                    }
                    .disabled(attachments.pendingSubmission != nil || !attachments.canQueueSubmission)
                    .help("回车发送；图片上传完成后自动提交。Shift+回车换行。")
                    if attachments.pendingSubmission != nil {
                        Button("取消发送") { attachments.cancelSubmission(); focusTerminal() }
                            .buttonStyle(.plain).font(.caption)
                    }
                }
            }
        }.padding(.horizontal, 12).frame(height: 76)
            .background(Color(white: 0.065))
    }
}

/// Draft text stays on this Mac while the upload occupies the terminal socket.
/// Reuses the chat editor's paste, IME and Return handling.
@MainActor
final class TerminalAttachmentComposer: NSView, NSTextViewDelegate {
    let input = MacChatTextView()
    var onChange: (() -> Void)?
    private let placeholder = NSTextField(labelWithString: "添加说明… 上传时也可输入")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        input.isRichText = false; input.isAutomaticQuoteSubstitutionEnabled = false
        input.isAutomaticDashSubstitutionEnabled = false; input.isAutomaticTextReplacementEnabled = false
        input.font = .systemFont(ofSize: 13); input.textColor = .labelColor
        input.backgroundColor = NSColor(white: 0.13, alpha: 1)
        input.insertionPointColor = .labelColor
        input.textContainerInset = NSSize(width: 8, height: 7)
        input.isVerticallyResizable = true; input.isHorizontallyResizable = false
        input.autoresizingMask = [.width]; input.textContainer?.widthTracksTextView = true
        input.delegate = self
        input.onCompositionEnd = { [weak self] in self?.onChange?() }
        input.setAccessibilityLabel("图片说明，上传时也可输入")
        scroll.documentView = input
        placeholder.textColor = .placeholderTextColor; placeholder.font = .systemFont(ofSize: 13)
        for v in [scroll, placeholder] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            placeholder.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 13),
            placeholder.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 7),
        ])
    }
    required init?(coder: NSCoder) { nil }
    func textDidChange(_ notification: Notification) {
        placeholder.isHidden = !input.string.isEmpty
        onChange?()
    }
    func sync(_ text: String) {
        if input.string != text, !input.hasMarkedText() { input.string = text }
        placeholder.isHidden = !input.string.isEmpty
    }
}
