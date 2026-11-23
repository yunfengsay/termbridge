import Foundation
import Darwin

/// Owner-only local RPC. Service mutations still belong to MacLANServices.
/// Each accepted fd remains owned until its read/handler/write task completes;
/// shutdown interrupts I/O without racing a close against another descriptor.
@MainActor final class MacAppControl {
    static let shared = MacAppControl()
    nonisolated static var socketURL: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/app-control.sock") }
    private var source: DispatchSourceRead?
    private var connections: [UUID: (Int32, Task<Void, Never>)] = [:]
    private var path: String?
    var handler: (([String: Any]) async throws -> [String: Any])?

    func start(at url: URL = MacAppControl.socketURL) throws {
        guard source == nil else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(url.path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw MacPeerFailure("App 控制路径过长。") }
        withUnsafeMutableBytes(of: &address.sun_path) { dest in bytes.withUnsafeBytes { dest.copyBytes(from: $0) } }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw MacPeerFailure("无法创建 App 控制接口。") }
        var listening = false
        defer { if !listening { Darwin.close(fd) } }
        if fm.fileExists(atPath: url.path) {
            var metadata = stat()
            guard lstat(url.path, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFSOCK else {
                throw MacPeerFailure("App 控制路径已被其他文件占用。")
            }
            let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard probe >= 0 else { throw MacPeerFailure("无法检查已有 App。") }
            _ = fcntl(probe, F_SETFL, O_NONBLOCK)
            let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            let reason = errno; Darwin.close(probe)
            guard result < 0, reason == ECONNREFUSED else { throw MacPeerFailure("另一份 App 已提供控制接口。") }
            try fm.removeItem(at: url)
        }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0 else { throw MacPeerFailure("无法绑定 App 控制接口。") }
        guard chmod(url.path, 0o600) == 0, listen(fd, 8) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
            unlink(url.path); throw MacPeerFailure("无法保护 App 控制接口。")
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.accept(fd) } }
        source.setCancelHandler { Darwin.close(fd) }
        self.source = source; path = url.path; listening = true; source.resume()
    }
    func stop() {
        source?.cancel(); source = nil
        if let path { unlink(path) }; path = nil
        for (_, (fd, task)) in connections { task.cancel(); shutdown(fd, SHUT_RDWR) }
    }
    private func accept(_ listener: Int32) {
        while true {
            let fd = Darwin.accept(listener, nil, nil)
            guard fd >= 0 else { return }
            var uid: uid_t = 0, gid: gid_t = 0
            guard connections.count < 8, getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { Darwin.close(fd); continue }
            var timeout = timeval(tv_sec: 5, tv_usec: 0), noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            let id = UUID()
            let task = Task { [self] in
                defer { connections.removeValue(forKey: id); Darwin.close(fd) }
                let data = await Task.detached(priority: .utility) { Self.readRequest(fd) }.value
                guard !Task.isCancelled, let data else { return }
                let response: [String: Any]
                do {
                    guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], request["version"] as? Int == 1,
                          let handler else { throw MacPeerFailure("Unsupported App control request") }
                    response = ["ok": true, "data": try await handler(request)]
                } catch { response = ["ok": false, "error": error.localizedDescription] }
                guard !Task.isCancelled, var output = try? JSONSerialization.data(withJSONObject: response) else { return }
                output.append(10)
                await Task.detached(priority: .utility) { Self.writeResponse(fd, output) }.value
            }
            connections[id] = (fd, task)
        }
    }
    nonisolated private static func readRequest(_ fd: Int32) -> Data? {
        var data = Data(), buffer = [UInt8](repeating: 0, count: 2048)
        while data.count <= 8192 {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count > 0 else { return nil }
            data.append(contentsOf: buffer.prefix(count))
            if let end = data.firstIndex(of: 10) { return end <= 8192 ? data.prefix(upTo: end) : nil }
        }
        return nil
    }
    nonisolated private static func writeResponse(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count <= 0 { return }; offset += count
            }
        }
    }
}
