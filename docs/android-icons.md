# Android 操作图标

通用操作使用原生 VectorDrawable：24 × 24 坐标、1.7 线宽、圆角端点和连接；默认内在尺寸 22dp，目录/文件列表维持 18dp。图标变小不缩小触控区域。

默认颜色跟随 colorOnSurface；主色按钮跟随 colorOnPrimary，红色挂断按钮为白色。调用处的 iconTint/tint 仍负责选中、禁用和通话面板的颜色。

Claude / Codex 官方 Logo、语言文件类型图标、启动器和通知品牌标识不改造为操作图标。Shell、普通文件和文件夹采用同一套线性造型，目录颜色保留分类作用。

ActionIconStyleTest 防止通用图标混入旧粗线、实心填充或不同坐标尺寸。Android lint/build 校验资源引用；真实设备视觉表现仍需验收。
