# Home Assistant：文字与语音共用家庭工具

Global Agent 和 Voice Agent 的 Execution Fork 共用 `home_assistant` 工具。
Host 通过 HA 官方 REST API 访问已授权实体；小米授权和设备导入由 HA Xiaomi Home 集成负责。
工具不直连小米云、不读取浏览器或 HA 认证存储。导入设备不等于 TermBridge 已认证接通。

## 工具

| action | 参数 | 结果 |
| --- | --- | --- |
| `inventory` | 可选 `room`、`query`、`offset` | 已授权实体、房间、设备用途、允许命令；每页20项 |
| `states` | 同上 | 这一页实体的实时状态、可用性、允许属性、读取时间；部分失败明确标记 |
| `state` | `entityId` | 一个实体的实时状态 |
| `control` | `entityId`、`command`、按命令填写 `value` | 单设备指令接受结果及随后读取的状态 |

`room` 精确匹配；`query` 搜索名称或实体 ID；`nextOffset` 分页。清单是 Host 配置，`live:false`，
不是自动扫描或连接证明。这里的列表单位是 HA 实体：一个实体代表一项能力，不把实体数量当成物理设备数量。
同名设备先列清单确认房间，禁止猜 ID。`states` 最多同时读取4个实体，不读取未经授权的全量状态。

| equipment | commands | value/附加限制 |
| --- | --- | --- |
| `light` | `on`、`off`、`brightness`、`color_temperature` | 亮度0–100%；色温2200–6500 K且在设备报告范围内 |
| `fan` | `on`、`off`、`percentage` | 风速0–100%；适用于普通风扇/净化器，须报告调速能力 |
| `air_conditioner` | `off`、`cool`、`temperature` | 制冷/调温18–30°C，且在设备范围内；校验 HA 摄氏单位；单独调温仅限已处于制冷模式 |
| `curtain` | `open`、`close`、`stop`、`position` | 位置0–100%；实体须报告 `device_class: curtain`及相应能力 |

开关、开闭、停止命令不接受 value；其余命令必须填写 value。每次控制只能指定一个精确实体。

```json
{"action":"inventory","room":"书房"}
{"action":"states","room":"书房"}
{"action":"state","entityId":"light.study"}
{"action":"control","entityId":"light.study","command":"brightness","value":45}
{"action":"control","entityId":"climate.study","command":"cool","value":26}
```

## Host 配置与授权

在 `~/.termbridge/settings.json`（或 `TB_SETTINGS` 指定文件）中仅合并 `homeAssistant` 字段，保留其他配置。
以下是示例 ID，不是真实设备：

```json
{
  "homeAssistant": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8123",
    "tokenEnv": "TB_HA_TOKEN",
    "entities": [
      {
        "entityId": "light.study", "name": "书房灯", "room": "书房", "purpose": "普通照明",
        "control": { "equipment": "light", "commands": ["on", "off", "brightness", "color_temperature"] }
      },
      { "entityId": "sensor.study_temperature", "name": "书房温度", "room": "书房", "purpose": "环境温度只读" }
    ]
  }
}
```

最多100个实体。缺省/未启用配置拒绝访问；实体不带 `control` 时保持只读。
`control` 是用户在 Host 上授予的持续授权，限定设备类型和命令；工具中的 `approval:none` 表示
在此授权内执行，不表示模型能批准自己。调用参数不接受 `approved`、URL、服务名、Token或任意 service data。
此前只读阶段的“所有写操作必须手机逐次审批”方案由这一明确配置的普通家电持续授权方案替代。

令牌由用户在 HA 个人资料创建，安全注入 **Host 服务进程环境** `TB_HA_TOKEN`，不在聊天中粘贴，
不写入仓库、APK、Relay或工具结果。建议使用专用非管理员账户；HA令牌本身不提供本工具的实体级边界。
HTTP只接受本机回环；其他地址必须HTTPS。禁止重定向。修改当前终端环境不影响已运行的服务。
策略和令牌在Host启动时读取；修改后需重新加载Host。撤销可移除控制命令/实体、禁用配置，或在HA撤销令牌。

## 执行与失败边界

- 执行端再次校验精确实体、设备类别、命令和值域；控制前读取可用性/能力，未报告相应能力时拒绝。
- 控制仅调用固定 `/api/services/{domain}/{service}`；不写 `/api/states`，不开放脚本、场景、自动化或通用服务。
- 不允许 toggle、相对增减、批量写、加热/烹饪、门锁/车库门/安防/摄像头/麦克风、未知负载插座及生命维持设备。
  配置拥有者必须正确识别设备用途；设备类别声明不是物理安全认证。拥有完整shell的外部Worker不属于本工具沙箱。
- Host用 `requestId + callId` 传入去重标识，模型不能填写；同一标识参数冲突拒绝。
  同一实体并发控制拒绝；24小时、最多1000个进程内回执，满额拒绝新写入。重启后去重记录不保留；不得把旧命令作为恢复任务重放。
- 请求8秒超时、响应64KiB上限。控制网络失败/超时/5xx返回 `outcome_unknown,retryable:false`，不自动重试；先查询状态。
- HA接受指令不等于状态已收敛，更不等于实物成功。回执 `status:accepted,physicalVerified:false`，独立返回 `observation`。
  设备更新可能延迟，后读失败也不能断言前面的指令没执行。灯光参数只读透传安全字段，不返回原始属性或服务响应中的其他实体。
- 工具/UI/History共用现有receipt协议，无需新增手机客户端协议或安装APK。

## 验证和启用顺序

运行 `pnpm test`、`pnpm build`。专项 `pnpm test:home`，共享入口测试位于 `voiceTools.test.ts`。
测试覆盖固定端点、授权、参数/能力、Celsius验证、危险设备拒绝、去重、超时不确定、字段脱敏、真实HTTP mock及文字/语音共享回执。

启用顺序：准备真实清单 → 用户安全配置专用令牌 → 加载新版Host → inventory/state只读验证 →
用户指定一个家电执行明确动作并核实实物 → 在手机Global文字和Call分别验收。
本轮代码验证使用mock；未向真实家电发送服务指令，不能据此声称手机控制已打通。

实现：`packages/settings/src/homeAssistant.ts`、`packages/host/src/homeActions.ts`、
`voiceTools.ts`、`voicePrompt.ts`、`index.ts`。

官方依据：[REST API](https://developers.home-assistant.io/docs/api/rest/)、
[Light](https://www.home-assistant.io/integrations/light/)、[Climate](https://www.home-assistant.io/integrations/climate/)、
[Fan](https://www.home-assistant.io/integrations/fan/)、[Cover](https://www.home-assistant.io/integrations/cover/)。

本轮验收：249项通用单测、17项HA专项测试、5项Cloudflare测试、27个隔离集成场景通过，构建通过。
本机真实44实体策略已生成并合入Host配置；37实体有受限控制权限、7实体只读。专用凭据未注入，运行中Host未重启，手机与实物验收待完成。

2026-09-07 接通验收：专用令牌在本机0600权限的Host LaunchAgent环境中保存，两个Host已加载并认证HA。44个实体实时读取成功；29可用、15不可用（当次快照）。真实Qwen Execution Fork调用inventory与state成功，结构化receipt生成成功；未执行真实控制、未验证手机麦克风/扬声器链路。

`tb host restart`会从当前启用的HA策略确定凭据变量名；当前启动环境显式值优先，否则保留现有活动LaunchAgent中的对应值。禁用HA策略时不保留；不从历史备份恢复已删除凭据。服务文件保持0600权限。不在CLI输出中显示凭据。
清单提供`countUnit:entity`及可控/只读数量；灯光状态提供`brightness_pct`，原始brightness范围为0–255。
