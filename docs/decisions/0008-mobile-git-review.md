# ADR-0008: 独立的手机 Git Diff 与项目源码浏览能力

- 状态: 采纳
- 日期: 2026-08-30

## 背景

Terminal 适合实时控制 Agent，但窄屏上直接运行 `git diff` 或 `find` 不适合逐文件阅读：桌面终端宽度
造成换行，文件导航、增删统计和分支基准也不明确。手机需要一个独立的只读界面，既能审核改动，也能在
仓库没有改动时浏览项目结构和源码，同时允许用户在明确确认后切换当前仓库的本地分支。

## 决策

1. 新建独立的 `packages/review` 领域包。Host 只把 Session ID 交给它；客户端不能指定任意主机路径。
   Host 从 PTY 启动 cwd 或 Herdr snapshot 的 `foreground_cwd` 定位仓库，再通过
   `git rev-parse --show-toplevel` 得到权威 Git root。
2. 使用 [`parse-diff`](https://github.com/sergeyt/parse-diff) 0.12.0（MIT）在 Host 解析 Git/unified
   diff。它体积约 34 KB、无运行时依赖，只负责结构化解析；不引入约 2 MB 且偏桌面 HTML 输出的
   `diff2html`。Android 不接收 HTML，也不执行 Git 命令。
3. Working tree 模式使用 `git diff HEAD`，合并 staged 与 unstaged，并通过 `git diff --no-index`
   纳入安全限额内的 untracked 文本文件。Branch diff 模式使用所选本地基准分支的 `base...HEAD`，不
   自动 fetch，也不改变工作区。
4. Android 的 `review/` 目录持有独立 Activity、presentation model、RecyclerView adapter 和 UI
   测试。Terminal 通过轻量 `review_probe` 在 Session 位于 Git 仓库时显示入口；有改动时优先进入对应
   diff，没有改动时进入项目文件。Review 默认先显示可折叠目录树，也可切换为平铺文件列表；选中文件后
   显示单文件 diff 或源码，导航可随时收起/重开，不复用 xterm 或嵌入 WebView。 iOS 的 `Review/` 与 `Views/ReviewScreen`
   复刻同一套 presentation 规则和 `review_probe` 入口门槛；窄屏沿用"选中文件即取代列表"，iPad 宽屏
   把导航器与文件并排显示，因此重连或刷新必须按当前选中文件重新取内容，而不是按导航器是否展开判断。
5. 协议返回有界的结构化数据：最多 80 个文件、每个文件最多 800 行、总计最多 4,000 行、每行最多
   1,000 字符。仓库首屏限制为 4,000 行；用户选中文件后按需优先加载该文件，最多 20,000 行，其他文件只保留导航统计。超限时明确标记 truncated；二进制和超过 8 MiB 的 untracked 文件只显示文件级提示。
6. 项目文件模式通过 `git ls-files --cached --others --exclude-standard` 枚举最多 20,000 个已跟踪及
   未忽略的未跟踪文件，不暴露 `.git`、构建缓存或其他 ignored 文件。首屏只返回路径元数据；用户选择
   文件后才读取内容，最多 8 MiB / 20,000 行。Host 只接受刚才枚举出的安全相对路径，拒绝目录穿越、
   符号链接、仓库外 realpath 和二进制内容。
7. “选择对比分支”和“切换工作分支”是两个动作。前者只读；后者只允许 Host 已枚举的本地分支，必须
   二次确认，并在 worktree 完全干净时执行 `git switch --no-guess`。不提供 force、discard、stash、
   fetch、pull、commit 或 push。

## 后果

- 用户可以从当前 Agent 详情查看完整项目目录、未提交改动或相对基准分支的改动，并在手机窄屏连续阅读。
- Git/文件系统权限留在已配对 Host；Relay 只转发既有加密/鉴权边界内的结构化消息。
- 大型 diff 会被主动截断，完整内容仍需返回 Terminal 或桌面工具查看。
- 当前能力是“查看与安全切换”，不是完整的代码托管平台 Review：不包含行评论、approve、commit、PR
  或远端分支管理；这些能力若加入应使用新的显式协议和权限边界。
