# 排错

## `Error: posix_spawnp failed` （node-pty 起不来）

`node-pty` 自带预编译的 `spawn-helper` 二进制；pnpm 从 store 抽取时**常丢掉它的可执行位**，
于是 `posix_spawnp` 失败。

```bash
# npm 安装版：检查并修复实际运行的 node-pty
tb host doctor --fix

# 仓库源码版：一次性修
node scripts/fix-pty-perms.mjs
# 它做的事等价于：
chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper
```

`pnpm install` 的 `postinstall` 已自动跑这个脚本——所以正常装完即可用；只有手动改动
node_modules 后才需要再跑。`tb host start/restart/enable` 也会在启动后台 Host 前自动执行
同一项检查和修复。

## `ERR_PNPM_IGNORED_BUILDS`（node-pty 没编译/没解包）

pnpm 默认不跑依赖的安装脚本。本仓库已在 `pnpm-workspace.yaml` 用 `onlyBuiltDependencies`
放行 `node-pty` / `esbuild` / `msgpackr-extract`：

```yaml
onlyBuiltDependencies:
  - esbuild
  - msgpackr-extract
  - node-pty
```

改完重跑 `pnpm install` 即可。

## `[error] host not found: <id>` / 空的 `[connection error]`

客户端连上了 relay，但目标 host 没注册（或还没注册完）。检查：

- host 进程在跑，且 `RELAY_URL` / `HOST_ID` 与客户端一致；
- `tb cloudflare pair` 修改配置后运行 `tb host restart`，让后台 Host 重新读取 room；
- 公司网络需要代理时，先在 shell 设置 `HTTP_PROXY` / `HTTPS_PROXY`，再运行
  `tb host restart`，并用 `tb host doctor` 确认代理变量已捕获；
- 不是上一次跑残留的孤儿进程占着端口。先清理：
  ```bash
  pkill -f 'packages/(relay|host|cli)/src' 2>/dev/null; true
  ```

## `Error: unknown frame type N`

线协议不变量被破坏（见 [protocol.md](./protocol.md)）：

- 每条 **relay → host** 消息都必须带信封 `[clientId][frame]`（含 `host_register_ok`，clientId 0）；
- 每条 **client ↔ relay** 消息都是**裸帧**。

一端套了信封而另一端没按信封解析（或反之），就会把字节切错位、撞上非法的 type byte。

## 全局 `termbridge` 命令找不到

```bash
which termbridge          # 应指向 ~/Library/pnpm/bin/termbridge
echo "$PATH" | tr ':' '\n' | grep pnpm   # pnpm 全局 bin 是否在 PATH
```

shim 是 `~/Library/pnpm/bin/termbridge`，内容是用 `tsx` 跑仓库源码
`packages/cli/src/cli.ts`。仓库换路径后需重写这个 shim（见 [README](../README.md#全局命令)）。

## 端口被占用 / relay 起不来

relay 默认 `PORT=7400`。集成测试用 `7400 + pid%1000` 规避冲突。手动起多个时显式指定
`PORT` / `RELAY_URL`。
