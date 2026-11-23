import SwiftUI

/// Native graph of the relay's authenticated live sockets; never inferred from IP addresses.
struct RelayTopologyView: View {
    let topology: RelayTopology
    var localHostID: String? = nil
    var onSelectHost: ((String) -> Void)? = nil
    @State private var expanded = false
    private var clients: [RelayTopology.Node] { topology.nodes.filter { $0.role == .client } }
    private var hosts: [RelayTopology.Node] { topology.nodes.filter { $0.role == .host } }
    private var relay: RelayTopology.Node? { topology.nodes.first { $0.role == .relay } }
    private var limit: Int { expanded ? 128 : 6 }
    private var height: CGFloat { CGFloat(max(1, min(limit, max(clients.count, hosts.count)))) * 74 }
    private func isLocal(_ node: RelayTopology.Node) -> Bool {
        node.id == topology.selfNodeId || (node.role == .host && node.hostId != nil && node.hostId == localHostID)
    }
    private func isPath(_ node: RelayTopology.Node) -> Bool {
        isLocal(node) || node.id == topology.relayId || (node.role == .host && node.hostId == topology.selectedHostId)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(hosts.count) 台电脑 · \(clients.count) 个客户端").font(.caption).foregroundStyle(.secondary)
            GeometryReader { geometry in
                let width = geometry.size.width
                let card = max(88, (width - 52) / 3)
                let middle = CGPoint(x: width / 2, y: height / 2)
                ZStack {
                    Canvas { context, _ in
                        for (items, x, direction) in [(Array(clients.prefix(limit)), card / 2, -1.0), (Array(hosts.prefix(limit)), width - card / 2, 1.0)] {
                            for (index, node) in items.enumerated() {
                                let y = position(index, count: items.count)
                                let start = CGPoint(x: x - direction * card / 2, y: y)
                                let end = CGPoint(x: middle.x + direction * card / 2, y: middle.y)
                                var path = Path(); path.move(to: start)
                                let bend = (start.x + end.x) / 2
                                path.addCurve(to: end, control1: CGPoint(x: bend, y: y), control2: CGPoint(x: bend, y: middle.y))
                                context.stroke(path, with: .color(isPath(node) ? .accentColor : .secondary.opacity(0.35)), lineWidth: isPath(node) ? 2 : 1)
                            }
                        }
                    }.accessibilityHidden(true)
                    if let relay { nodeCard(relay).frame(width: card, height: 62).position(middle) }
                    ForEach(Array(clients.prefix(limit).enumerated()), id: \.element.id) { index, node in
                        nodeCard(node).frame(width: card, height: 62).position(x: card / 2, y: position(index, count: min(limit, clients.count)))
                    }
                    ForEach(Array(hosts.prefix(limit).enumerated()), id: \.element.id) { index, node in
                        nodeCard(node).frame(width: card, height: 62).position(x: width - card / 2, y: position(index, count: min(limit, hosts.count)))
                    }
                }
            }.frame(height: height)
            if clients.isEmpty && hosts.isEmpty { Text("中转正在运行，等待电脑或客户端接入。").foregroundStyle(.secondary) }
            if max(clients.count, hosts.count) > 6 {
                Button(expanded ? "收起设备" : "显示所有设备") { expanded.toggle() }.font(.caption)
            }
            if topology.truncated { Text("连接较多，已优先显示本机与当前目标；部分设备未展开。").font(.caption).foregroundStyle(.secondary) }
            Text("本机以蓝色描边标记，蓝线表示当前连接路径。").font(.caption).foregroundStyle(.secondary)
        }.accessibilityElement(children: .contain).accessibilityIdentifier("relay-topology")
    }
    private func position(_ index: Int, count: Int) -> CGFloat { height / CGFloat(count + 1) * CGFloat(index + 1) }
    @ViewBuilder private func nodeCard(_ node: RelayTopology.Node) -> some View {
        let local = isLocal(node)
        let content = VStack(spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: node.role == .relay ? "network" : node.role == .host ? "desktopcomputer" : "display")
                Text(local ? "本机" : node.role == .relay ? "中转" : node.role == .host ? "电脑" : "客户端")
                if node.hostId != nil && node.hostId == topology.selectedHostId { Image(systemName: "checkmark.circle.fill") }
            }.font(.caption2).foregroundStyle(local ? Color.accentColor : .secondary)
            Text(node.name).font(.caption).lineLimit(1).truncationMode(.middle)
            if node.connections > 1 { Text("\(node.connections) 条连接").font(.caption2).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(local ? Color.accentColor.opacity(0.09) : Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(local ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: local ? 2 : 1))
        if let host = node.hostId, let onSelectHost {
            Button { onSelectHost(host) } label: { content }.buttonStyle(.plain)
                .help("查看 \(node.name) 的会话").accessibilityLabel("\(local ? "本机，" : "")\(node.name)，电脑")
        } else { content.accessibilityLabel("\(local ? "本机，" : "")\(node.name)，\(node.role == .relay ? "中转机" : node.role == .host ? "电脑" : "客户端")") }
    }
}
