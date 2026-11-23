# ADR-0010: 手机作为受限原生 Action Peer

- 状态: 采纳
- 日期: 2026-09-03

## 背景

Global Brain 需要让手机充当可授权的“手脚”：创建闹钟、读取或修改日历、记录待办，以及把用户
明确选择的照片交给执行 Agent。直接暴露 ADB、任意 Intent、整个相册或手机文件系统都会把自然语言
误判放大成高风险设备权限，也无法在 Android 后台启动限制下可靠工作。

## 决策

1. Android 的常驻 Agent monitor 继续注册为 app-level manager Peer，只新增固定白名单
   `phone.action`、`phone.asset.read` 和 `phone.asset.delete`；不开放 shell 或任意文件路径。
2. Host 给文字 Global 与实时 Voice 注册同一个 `phone_action` 工具。动作名和参数由协议枚举，模型
   不能提供 Intent、Content URI、SQL 或文件路径。
3. Android 对每个具体 action 独立保存四档应用审批策略：每次审批、单次 Global 对话审批一次、
   免审批、禁止。策略与随机会话 grant 只存在应用私有存储；Host 为当前 Global 对话签发随机
   `conversationId`，新建、清空、恢复/切换对话或 Host 重启都会换 ID，因此旧 grant 不可复用。
   需要审批时，Android 前台打开 TermBridge 自己的统一确认页，后台只发可点入该页的通知，不使用
   `MaterialAlertDialog` 反复打断。免审批的 Calendar/Todo 先立即返回 `running`，再通过 durable
   `phone_action_event` 返回 `completed/failed`，避免慢 `ContentResolver` 查询阻塞 Peer RPC。
4. 闹钟使用系统 `AlarmClock.ACTION_SET_ALARM` 并保留系统确认页。日历只访问用户授权的
   Calendar Provider，列表必须有时间窗，更新和删除必须使用先前返回的精确事件 ID。待办第一版仅存
   TermBridge 私有数据，不冒充三星提醒或 Google Tasks。
5. 照片拆成三个固定能力。`photo.count` 在手机本地按最长 31 天的时间窗统计，只返回数量、范围和
   `full/selected` 授权范围，不返回图片、路径、MediaStore ID、EXIF 或位置。`photo.fetch` 只把时间窗内
   最新的最多 3 张复制成随机、24 小时有效的 `assetId`，自动内容授权间隔至少 60 秒、滚动一小时最多
   12 张。`photo.edit` 仍使用 Android Photo Picker，由用户挑选最多 3 张，不消耗自动读取预算。
   Agent 只能凭这些随机句柄分块读取；输入和输出继续使用临时 P-256 ECDH + AES-256-GCM，Worker
   完成整批输出后 Android 才写入 `Pictures/TermBridge`，不覆盖原图。
6. Android 系统运行时权限与 TermBridge 工具审批分层。Calendar 和照片库权限只从 Global 设置的
   授权中心提前申请/撤销；动作执行阶段缺权限就返回明确拒绝，不临时弹系统授权页。Android 14 的
   “选定照片”只会得到 `selected` 范围，统计结果不能冒充完整图库。Photo Picker 是 `photo.edit` 的
   输入边界，不属于动作审批，即使该动作免审批仍必须由用户明确选择图片。
7. 每次执行从开始就暴露稳定 ID。Global 的 `cancel_execution` 接收 task/action/session ID：待审批动作
   和正在读取的 `calendar.list` 可真取消；TermBridge-owned Worker 会结束 PTY；Herdr Worker 收到中断
   信号但 pane 仍由 Herdr 管理。已经落盘的系统日历/闹钟操作不可撤销，返回 `not_cancellable`。

Android 权限边界参考官方文档：[Photo Picker](https://developer.android.com/training/data-storage/shared/photopicker)
和 [Android 14 selected photos access](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)。

## 后果

- 用户可以提前配置每个工具；每次/每对话审批的异步结果仍会在 Peer 重连后继续上报。
- 多台手机在线时 Host 必须按 `deviceId` 精确选择，否则拒绝猜测。
- 图片的具体生成式编辑由被派发的 Worker 完成；Phone Peer 只负责受限输入、加密传输、校验和写回，
  Voice 模型不能虚报完成。
- iOS 以后可实现相同 `phone_action` 语义，但必须使用其原生权限与 picker，不能照搬 Android 实现。
