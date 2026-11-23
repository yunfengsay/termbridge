# Android 全局设置与应用更新

入口：首页右上角更多 → 全局设置；Global 对话更多 → 全局设置。统一页面保留连接编辑、语音与系统授权、手机动作审批和手表设置入口。连接编辑仍需显式保存；从设置页返回首页会应用已保存的连接变更。

## 更新流程

设置页点击检查更新 → 官网清单 → 比较 `versionCode` 和 `minSdk` → 用户点击下载 → 有界流式 SHA-256 校验 → 包名/版本/当前签名证书核验 → 用户点击安装 → Android 系统安装确认。

- 清单：`https://termbridge-a0k.pages.dev/downloads/manifest.json`，复用下载站现有 schema 1。
- APK 仅接受同一 HTTPS 域名下 `/download/*.apk`；禁止重定向。文件最大 200 MiB，清单最大 256 KiB。
- 不依赖 Host、Relay 或语音模型；不包含服务端密钥，不自动后台检查或下载。
- 下载进度与任务通过 ViewModel 保留至设置页面生命周期结束；退出时取消网络和线程任务。部分文件删除，只在应用私有缓存 `app-updates/` 保存通过验证的 APK。
- 无未知来源安装授权时打开 Android 的本应用安装权限页，回来后再次点击安装。不绕过系统确认，不支持静默安装。
- 安装复用 `PeerApkInstaller` / `PeerApkInstallReceiver` 回执。安装失败/取消通过现有回执刷新设置页。不会清空连接和会话数据。
- **每次发布递增 `versionCode`**。相同或更低编号不提示更新，也不会凭不同文件哈希把旧公开构建覆盖到较新的开发构建上。
- 签名必须与当前 APK 一致；签名变更/轮换目前按不兼容拒绝，不引导卸载来绕过。下载站目前是 debug 签名测试通道，正式发布需固定安全的发布签名。

安全校验入口：`update/UpdateArtifact.kt`、`UpdateRepository.kt`；设置与状态入口：`GlobalSettingsActivity.kt`、`AppUpdateModel.kt`。Android [安装权限说明](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls())。

## 验证边界

单测覆盖版本比较、SDK 门槛、恶意 URL、大小限制、完整哈希、截断、篡改、取消与临时文件清理。构建/lint 不等于真机更新成功。需使用同签名、更高 `versionCode` 的真实发布 APK 验收：下载 → 授权 → 系统确认 → 升级后版本与原连接保留。第一次安装含本功能的客户端仍需现有 ADB/官网安装方式。
