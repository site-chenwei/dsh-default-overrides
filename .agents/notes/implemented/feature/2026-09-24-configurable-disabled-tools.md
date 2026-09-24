# Agent Note: 把默认工具禁用清单改为配置项

Status: implemented

## Problem

插件把 `tool-web` 与 `tool-workflow` 硬编码为始终禁用：只要插件加载，`standard` 预设的这两行在任何 profile 里都回不来，使用者无法只取用 Shell 通道。清单写在源码常量 `DISABLED_TOOLS` 里，换一个要禁用的工具就得改代码并重新发包。

## Decision

新增配置项 `disabledTools`：`standard` 预设的行 ID 数组，默认 `[]`。未配置时插件完全不修改预设——既不切 Shell，也不禁用任何行；只有显式配置才生成 `{ id, disabled: true }` 补丁。源码删除 `DISABLED_TOOLS` 常量。

补丁只下发 `id` 与 `disabled`：`applyEntryPatches` 按 ID 匹配，`name` 仅在提供时用于一致性校验，因此无需让使用者抄写包名。

配置的 ID 必须在传入的预设行中存在，否则 `apply` 直接报错。理由是该函数对未命中的补丁只发一条 warning 后跳过，会把"配置写错了"表现成"配置不生效"，与本插件其他配置错误的处理方式不一致。

`flattenRows` 从原 Shell 校验中提取出来，同时服务于 Shell 目标校验和 ID 存在性校验；两者都按分组递归，因此 `delegation` 组内的 `tool-workflow` 这类嵌套行同样可被禁用。

## Alternatives considered

- **不做/保留硬编码默认禁用。** 零改动，对 0.1.0 使用者无感；但把一种个人偏好固化成所有使用者的默认，想恢复官方工具面的人只能改源码，与本插件"可配置覆盖"的定位相反。
- **保留默认 `['tool-web', 'tool-workflow']`，仅把常量改成可覆写的配置。** 升级零成本，兼容性最好；但仍然默认改动官方预设，与"而非默认禁用"的要求直接冲突。
- **配置项接受 `{ id, name }` 对象，复刻原有的包名校验。** 校验更强，能发现"ID 复用但换了包"的情况；代价是使用者要抄写包名，而按 ID 匹配本就是 `applyEntryPatches` 的真实语义，存在性校验已覆盖会真实发生的错误。
- **支持为其他预设或任意层配置禁用。** 适用范围更广；但插件当前只作用于 `standard`，扩大作用域没有真实用例支撑。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1 下通过：打包、隔离 `DSH_HOME` 中安装、真实 Loader 加载后，profile 配置 `{ shellMode: 'bash', bashPath, disabledTools: ['tool-web'] }` 使 `tool-web` 变为禁用，且该行 `config` 完整送达。

[运行验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)新增断言：

- `{}` 与 `{ bashPath, pwshPath }` 注册结果与官方预设 `deepEqual`，证明默认零改动；
- `disabledTools: ['tool-web', 'tool-workflow']` 让这两行 `disabled`，同一分组内的 `tool-workflow` 可达，且 `tool-bash`、`tool-pwsh`、`skill-filesystem` 保持官方原值；
- 错误用例：非数组、含非字符串元素、不存在的行 ID 都在注册阶段抛错。

原有四模式路径映射、ready 重载、预设隔离，以及 Bash 一次性与持久化真进程验证继续通过。Windows Git Bash/ConPTY、PowerShell 真进程与完整 GUI 会话仍未实测。

## Consequences

升级插件不再改变工具面，使用者可按需选择禁用哪些行，包括分组内的行；写错 ID 会立即失败而不是静默不生效。

代价是 0.1.0 的使用者升级到 0.2.0 后 `tool-web`/`tool-workflow` 会重新出现，必须显式补上 `disabledTools` 才能保持原样；[迁移说明](../../../../dsh-default-overrides-migration.md)给出了这一步。配置项、示例和 README 表格同步增加了一个维度。

## Related notes audit

[bundle 分发决定](../architecture/2026-09-24-distributable-dsh-bundle.md)部分重叠：该笔记描述了空默认配置的行为，本次变更使其失效，已就地把默认语义改为"不改动预设"并互链。[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：本次沿用同一条 `internal/config` 内存补丁链路，禁用清单只是其中一个数据来源。没有其他活跃提案需要拒绝或归档。
