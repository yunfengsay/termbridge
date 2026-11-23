import SwiftUI

struct ConnectionTopologyView: View {
    @ObservedObject var model: ControlCenterModel
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let topology = model.topology {
                ScrollView {
                    RelayTopologyView(topology: topology) { host in
                        guard let profile = model.activeProfile else { return }
                        do { try model.connectTopologyHost(host, using: profile, topology: topology); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                }.frame(maxHeight: 460)
            } else if model.activeProfile == nil {
                Label("本机 · 尚未连接中转", systemImage: "desktopcomputer")
                Text("在「内网服务」配置共享或中转；连接远端后，这里会显示本机在网络中的位置。")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Label(model.phoneHubStatus, systemImage: "network")
                Text("尚未收到拓扑。连接断开时会清除旧图；旧版中转需要升级才能显示。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
