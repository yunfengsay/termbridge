import Darwin
import Foundation

/// Descriptor-relative access: each component is opened without following
/// symlinks. No FIFO/device reads, path traversal or whole-file buffering.
enum MacPeerFiles {
    static let limit = 1024 * 1024

    static func execute(_ op: String, args: [String: MessagePackValue], permission: MacPeerPermission) throws -> MessagePackValue {
        guard permission.files != .off else { throw MacPeerFailure("文件访问未授权，请在 Mac 设置 → Peer 中开启。") }
        if op == "fs.write" && permission.files != .rw { throw MacPeerFailure("仅允许读取，文件写入未授权。") }
        let defaultRoot = permission.root
        guard defaultRoot.hasPrefix("/"), defaultRoot != "/" else { throw MacPeerFailure("尚未选择开放目录。") }
        let requested = args["path"]?.stringValue ?? "."
        guard !requested.contains("\0") else { throw MacPeerFailure("无效文件路径。") }
        let candidate = try MacPeerPath.resolve(requested.hasPrefix("/") ? requested : defaultRoot + "/" + requested)
        guard let root = permission.roots.filter({ $0.hasPrefix("/") && $0 != "/" && (candidate == $0 || candidate.hasPrefix($0 + "/")) })
            .max(by: { $0.count < $1.count }) else { throw MacPeerFailure("路径超出已授权目录。") }
        let relative = candidate == root ? [] : candidate.dropFirst(root.count + 1).split(separator: "/").map(String.init)
        let base = try directory(root.split(separator: "/").map(String.init), from: open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
        defer { close(base) }
        if op == "fs.ls" {
            let fd = try directory(relative, from: dup(base)); defer { close(fd) }
            let listing = dup(fd)
            guard let stream = fdopendir(listing) else { close(listing); throw MacPeerFailure("无法列出目录。") }
            defer { closedir(stream) }
            var entries: [MessagePackValue] = []
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: &entry.pointee.d_name) { ptr in
                    ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." { continue }
                guard entries.count < 1000 else { throw MacPeerFailure("目录超过 1000 项，请选择子目录。") }
                var info = stat()
                guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
                entries.append(.map(["name": .string(name), "type": .string(kind(info)), "size": .double(Double(info.st_size)), "mtime": .double(modified(info))]))
            }
            return .array(entries)
        }
        let parent = try directory(Array(relative.dropLast()), from: dup(base), create: op == "fs.write" && args["mkdirp"]?.boolValue == true)
        defer { close(parent) }
        let name = relative.last ?? "."
        if op == "fs.stat" {
            var info = stat()
            guard fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw MacPeerFailure("文件不存在或无权访问。") }
            return .map(["path": .string(candidate), "type": .string(kind(info)), "size": .double(Double(info.st_size)),
                    "mtime": .double(modified(info)), "mode": .int(Int64(info.st_mode))])
        }
        if op == "fs.write" {
            guard let content = args["content"]?.stringValue ?? args["data"]?.stringValue else { throw MacPeerFailure("缺少文件内容。") }
            let data: Data
            if args["encoding"]?.stringValue == "base64" {
                guard let decoded = Data(base64Encoded: content) else { throw MacPeerFailure("无效 base64 内容。") }
                data = decoded
            } else { data = Data(content.utf8) }
            guard data.count <= limit else { throw MacPeerFailure("单次写入限制为 1 MiB。") }
            // O_NOFOLLOW + fstat before truncation avoids symlink/hardlink escapes.
            let fd = openat(parent, name, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw MacPeerFailure("无法写入文件。") }; defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, kind(info) == "file", info.st_nlink == 1 else { throw MacPeerFailure("只能写入普通文件，不支持设备或硬链接。") }
            guard ftruncate(fd, 0) == 0 else { throw MacPeerFailure("无法更新文件。") }
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw MacPeerFailure("文件写入未完成。") }
                    offset += count
                }
            }
            return .map(["path": .string(candidate), "bytes": .int(Int64(data.count))])
        }
        guard op == "fs.read" else { throw MacPeerFailure("不支持的文件操作。") }
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw MacPeerFailure("文件不存在或无权访问。") }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, kind(info) == "file", info.st_nlink == 1 else { throw MacPeerFailure("只能读取普通文件，不支持硬链接。") }
        let maxBytes = min(limit, max(1, args["maxBytes"]?.intValue ?? limit))
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let data = try handle.read(upToCount: maxBytes) ?? Data()
        let text = String(data: data, encoding: .utf8)
        let binary = data.contains(0) || text == nil
        return .map(["content": .string(binary ? data.base64EncodedString() : text!), "encoding": .string(binary ? "base64" : "utf8"),
                "bytes": .double(Double(info.st_size)), "truncated": .bool(info.st_size > data.count)])
    }

    private static func directory(_ parts: [String], from initial: Int32, create: Bool = false) throws -> Int32 {
        guard initial >= 0 else { throw MacPeerFailure("无法访问目录。") }
        var fd = initial
        do {
            for part in parts {
                guard part != "..", part != "." else { throw MacPeerFailure("无效目录。") }
                if create && mkdirat(fd, part, 0o700) != 0 && errno != EEXIST { throw MacPeerFailure("无法创建子目录。") }
                let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard next >= 0 else { throw MacPeerFailure("目录不存在、含符号链接或无权访问。") }
                close(fd); fd = next
            }
            return fd
        } catch { close(fd); throw error }
    }
    private static func kind(_ info: stat) -> String {
        switch info.st_mode & S_IFMT {
        case S_IFREG: return "file"
        case S_IFDIR: return "dir"
        case S_IFLNK: return "symlink"
        default: return "other"
        }
    }
    private static func modified(_ info: stat) -> Double {
        Double(info.st_mtimespec.tv_sec) * 1000 + Double(info.st_mtimespec.tv_nsec) / 1_000_000
    }
}
