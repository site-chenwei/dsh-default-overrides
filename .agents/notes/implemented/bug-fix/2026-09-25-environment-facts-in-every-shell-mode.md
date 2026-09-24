# Agent Note: 环境事实段与 Shell 补丁解耦

Status: implemented

## Problem

`envContext`（默认 `true`，README 承诺"向模型添加模式、配置路径和会话工作区"）在两种长期可用的配置下**静默失效**：`shellMode: bash` 省略 `bashPath`（`officialBashFallback`），以及完全不配置 `shellMode`。原因是唯一那条提示词钩子挂在 `if (shellEnabled && !officialBashFallback)` 上——这个条件本来是给 Shell 行补丁用的，却连带停掉了环境段、`dsh_overrides_*` 变量和工具说明补充。

失败模式是"用户以为配置生效了"：不报错、不告警、README 的 `envContext` 条目没有这个例外，`verify` 里唯一相关夹具还特意传了 `bashPath` 绕开 fallback，提示词平面零覆盖。这与仓库自己的取向相反——`persona` 选项的校验就是为了"键名写错直接报错，避免静默不生效"。

同一段文本在回退与未托管时还有两处不成立：fallback 下 `timeoutMs` 不参与执行（README：一次性模式沿用官方等待与上限），却在托管分支之外仍可被读成生效；"persistent shell may have changed its own directory" 对一次性模式（每次新 Shell）也不适用。

同一处提示词钩子还把平面锁死在一个预设上：`composedPreset(agent.ctx) !== 'standard'` 让 `minimal`、`ptc` 与自定义预设的会话拿不到平台与工作区事实——而平台是这些会话里唯一无法从别处得到的带内事实（宿主自己的 runtime context 只有文件策略与审批策略）。

## Decision

提示词平面与 Shell 行补丁解耦，环境段按"插件是否真的接管了这个方言通道"分支：

- `managedShell = shellEnabled && !officialBashFallback`：决定**工具说明补充**（方言操作规则 + `command` 参数提示）与**Shell 通道声明**。只有接管通道时才声明 `Shell mode` / `Executable` / 参数语义 / 截止时间；未接管时只写 `Shell channel: supplied by the active preset or the host default; this plugin configured no shell.`——因为 Windows 上该回退实际给的是官方 pwsh，冒充 bash 方言会直接写错。
- `environmentEnabled = envContext ?? shellEnabled`：显式配置说了算；未配置时只在选了 `shellMode` 才贡献，空配置仍是零影响（README 的既有承诺）。钩子注册条件因此是 `managedShell || environmentEnabled`。
- **提示词平面不按预设名放行也不按预设名拦截**：门禁是 `ownsChannel = managedShell && configuredPresets.has(composedPreset(agent.ctx))`——`configuredPresets` 记录 `internal/config` 钩子真正打过行补丁的预设 id。行补丁仍只作用于官方 `standard`（它是本插件声明兼容的结构基线），所以实际效果是：环境事实（平台 + 工作区）对 profile 内每个预设的 agent 都贡献，而 Shell 通道声明与工具说明改写只发生在被行补丁配置过的预设上。
- 平台与会话工作区**任何组合下都给出**；`dsh_overrides_shell_path` 只在本段真的引用它（即 `ownsChannel`）时注册，避免留下无载体的变量。
- cwd 分叉提醒只在 `ownsChannel && persistent` 时出现：只有持久化通道的 shell 目录可能与文件工具的相对路径基准分叉。
- `envContext` 补上布尔类型校验（此前写 `envContext: 'yes'` 会被当作真值静默生效）。

## 组合矩阵

| 预设 | `shellMode` | 环境段内容 |
|---|---|---|
| 任意预设 | 未配置 | 不贡献（空配置零影响）；显式 `envContext: true` 时给平台 + 工作区 |
| `standard`（行补丁生效） | `bash` 无路径（回退） | 平台 + 当前预设或宿主默认通道 + 工作区 |
| `standard`（行补丁生效） | `pwsh` 无路径 / 任意模式有路径 | 平台 + 方言 + 可执行文件 + 参数语义 + 工作区 |
| `standard`（行补丁生效） | `persistent-*` | 上面各项 + 截止时间 + cwd 分叉提醒 |
| `minimal` / `ptc` / 自定义 | 任意取值 | 平台 + 工作区 + "由当前预设或宿主默认提供、本插件未配置"；不声明方言、不声明截止时间、不改写工具说明 |

`envContext: false` 在任何模式下都不贡献该段，工具说明补充照旧（保持既有文档语义）。

## Alternatives considered

- **不做，只在 README 加一行 fallback 例外。** 改动最小、零回归风险；但用户显式写了 `envContext: true` 却拿不到东西，仍然要靠读文档才知道，与"配置错就报错、不静默失效"的既有取向冲突。
- **保留现状，仅在显式配置时打 warning。** 三行改动、不动行为；但只是把静默变成可见，用户仍然拿不到平台与工作区，且 warning 对默认值 `true` 会变成噪音（默认 true + fallback 是常见组合）。
- **fallback 直接复用托管分支的文本（照抄 `Shell mode: bash` 与截止时间）。** 最省代码；但那是错的：Windows 上该回退给出官方 pwsh，`timeoutMs` 也不参与执行，等于用提示词编造运行事实。
- **把 `envContext` 默认改成 `false`，让用户显式开启。** 能把"零影响"做大；但会改变既有默认（README 表格写 `true`），并把一次修缺陷变成一次行为翻转。
- **行补丁也作用于所有预设（连 `composedPreset` 与 `config.id` 门禁一起删掉）。** 语义最统一，环境段在所有预设上都走托管分支；但实测会破坏预设：`minimal` 的 persona 行是 `complete: true`（会被本插件按默认写成 `false`，单句提示词设计失效），它的 Shell 是自定义 `persistent-shell` 组、没有 `tool-bash`/`tool-pwsh` 行（`verifyShellRows` 直接抛错），`disabledTools` 里 `tool-web` 这类 ID 在它那里也不存在。要这么做必须同时把"目标缺失就报错"降级成"跳过 + 告警"，并把 `complete`/`includeRuntimeContext` 改成"未写就保留该预设当前值"——那是另一个决定，不在本次范围。
- **提示词钩子干脆对所有预设都走托管分支（`ownsChannel = managedShell`）。** 一行改动；但会在 `ptc`/`minimal` 会话里声明本插件并未配置的方言与可执行文件（Windows 上这些预设给的是 pwsh），正是本次要消灭的"编造运行事实"。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 与 `npm run verify -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.2 下通过（12 条 PASS）。

- 新增组合断言（[运行验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)）：未配置 `shellMode` 时不贡献环境段；显式 `envContext: true` 时给平台 + 工作区且不声明方言/截止时间；fallback 下环境段存在、包含工作区、出现"宿主默认通道"、**不出现** `Shell mode: bash` 与 `command deadline`，且工具表与基线逐字段相同（证明未改写官方工具说明）；fallback + `envContext: false` 不贡献；托管持久化给出截止时间与 cwd 分叉提醒；托管一次性给出可执行文件、不声明截止时间与分叉提醒、工具表与基线不同。
- 新增错误用例：`envContext: 'yes'` 在注册阶段报 `envContext must be a boolean`。
- 新增跨预设断言：夹具 `runtime(config, { presetId })` 可挂一个非 `standard` 预设（该预设的行补丁不生效，夹具直接在声明里禁用依赖未挂服务的行）。断言该预设下：未配置 `shellMode` 时不贡献环境段；`shellMode` 为 `bash`（回退）与 `persistent-bash`（本插件以为已托管）两种情况下**都**拿到环境段与工作区、**都不出现** `Shell mode:` 与 `command deadline`、工具表与基线逐字段相同。
- 新增预设级抑制断言：预设的 persona 行写 `complete: true` + `includeRuntimeContext: false`（`minimal` 的策略）时，本插件的环境段与运行时快照都必须被抑制为空，系统提示词仍然只有那一句——**预设自己的策略优先于本插件的 `envContext: true`**，这也解释了为什么 `minimal` 会话拿不到平台事实。
- 夹具限制：官方 `tool-bash` 在夹具中没有 `shell` 提供者（真实宿主由 `bash-sandbox` 提供），因此组合夹具统一禁用 `tool-web` / `tool-bash`，用"工具表与基线相同"代替"官方描述字符串相同"；系统提示词渲染按需惰性触发（官方 persona 前缀含 `{{model}}`，夹具未注册该变量）。

未验证：Windows 上 fallback 实际给出 pwsh 时的模型侧观感（本机为 macOS），以及完整 GUI 会话；`minimal`/`ptc` 真实预设（而非夹具里的 `other`）下的渲染未实跑。

## Consequences

`envContext` 在四种 `shellMode`、所有预设与"什么都不配"的组合下都有确定语义；平台与工作区不再依赖 Shell 是否被接管、也不再依赖会话用的是哪个预设；回退与非托管预设都不冒充方言、不声称未生效的截止时间；`envContext` 拼错类型会在启动时报错。

代价是环境段的文本分支从 1 处变 3 处（托管持久化 / 托管一次性 / 未托管），新增 `managedShell` 与 `configuredPresets` 两个概念需要与 `officialBashFallback` 一起理解；"是否声明 Shell 通道"从预设名判断变成"是否打过行补丁"判断，读代码时多一跳。`envContext` 的语义也从"模式、配置路径、工作区"扩展为"环境事实"，README 与选项表都随之改写。

## Related notes audit

[Shell 路径配置改为可选](../feature/2026-09-24-optional-shell-paths.md)部分重叠：那篇决定"fallback 不产生 Shell 补丁"，本次不改那个结论，只把提示词平面从同一条 `if` 里摘出来，双方互链。[路径归一化](../feature/2026-09-24-windows-path-normalization.md)与[运行契约修复](2026-09-24-shell-channel-runtime-contracts.md)无冲突：都只作用于托管通道。[可配置 persona](../feature/2026-09-24-configurable-persona.md)在同一提示词平面上，但改的是 persona 行，不涉及环境段。没有其他活跃提案需要拒绝或归档。
