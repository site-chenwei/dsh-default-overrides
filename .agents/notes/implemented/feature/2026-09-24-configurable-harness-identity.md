# Agent Note: 可配置隐藏 harness:identity 段

Status: implemented

## Problem

`harness:identity` 段（`You are an AI agent powered by DeepSeek Harness.`）由**全局** `system-prompt` 行（`dsh-base` 声明）在构造函数里按 `config.includeHarnessIdentity` 注册。想让模型少收到这句框架身份说明，用户只能自己写 profile 行补丁，而 DSH 的行补丁整体替换 `config`，必须连带抄写该行的 `personaPrefix` 等字段。

## Decision

新增布尔配置项 `includeHarnessIdentity`：设置后本插件在 `internal/config` 钩子里把全局 `system-prompt` 行的配置改写为 `{ ...当前配置, includeHarnessIdentity }`，复用宿主官方开关，不新造隐藏机制。未设置时不改写该行。

识别该行用插件类身份（`ctx.loader.import('@deepseek-ai/dsh-system-prompt')` 的默认导出）而不是行 ID，因此自定义 profile 改行名也照样命中；这个判断放在预设分支之前，因为预设分支只处理 `config.id === 'standard'`。

**时序是该功能的实现前提。** 实测确认：`system-prompt` 行早于本插件解析配置时，钩子尚未注册，改写不会生效。因此 [bundle 补丁](../../../../cordis.patch.yml)给该行加了 `inject: [dshDefaultOverridesReady]`，与 `preset-standard` 用的是同一个 ready 信号。该行自身没有 `inject`（类没有静态 inject，YAML 行也只声明 id/name/config），所以这只是增加等待；`agent-preset-registry` 的 inject 是 `['loader','sessionProjections']`，不依赖 systemPrompt，因此与本插件的 `agentPresets` 依赖不构成环。

## Alternatives considered

- **不做/让用户自己在 profile 写行补丁。** 零代码；但每次都要连带抄写 `personaPrefix`、`personaSuffix`、`toolOrder` 等字段，上游一改就整块过期，且没有类型校验。
- **在 bundle 补丁里静态写死 `includeHarnessIdentity: false`。** 一行 YAML 就能生效、不依赖时序；但那是"默认隐藏"，与本次要求的可配置相反，也会把所有不使用该选项的人一起改掉。
- **在 agent 作用域注册同名空段落去遮蔽全局段。** 不依赖配置时序；但要在每个 agent 作用域注册段落，插件不再是纯配置改写，且只覆盖 `standard` 会话，与"整个 profile 一致"的语义不符。
- **改成监听 `system-prompt/change` 后动态增删段落。** 能绕开配置时序；但宿主没有公开的移除他人段落接口，只能靠遮蔽，复杂度高于收益。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1 下通过。

- 运行夹具改为经 Loader 条目挂载 `system-prompt`（与真实 profile 一致）并带上 ready 等待，因此走的是真实的 `internal/config` 拦截路径，而不是直接 `root.plugin()`。
- 四模式用例断言默认渲染出的提示词包含 `You are an AI agent powered by DeepSeek Harness.`；专门的用例断言 `includeHarnessIdentity: false` 时该句消失，而配置的 persona 前缀、persona 后缀、运行时上下文快照与工具操作规则仍在。
- 错误用例断言非布尔值报错；分发验证断言真实 profile 合成出的 `system-prompt` 行确实带上了 ready 等待。

首次实现时该用例失败（身份句没消失），正是它暴露了时序问题；加上 ready 等待后通过。

## Consequences

隐藏身份说明变成一次配置，且只影响这一句：模型与 API、工具注册、Shell、团队/Goal/Workflow、沙箱与审批都不经过该开关。作用域是整个 profile（全局行），不是 `standard` 预设，文档已注明。

代价是插件多了一条对所有 profile 生效的启动时序依赖：即使不使用该选项，全局 `system-prompt` 行也要等到本插件就绪才实例化。用户层若覆盖该行的 `inject`，必须保留 `dshDefaultOverridesReady`；不含该行的自定义 profile 会得到一条补丁未命中的 warning。

## Related notes audit

[可配置 persona](2026-09-24-configurable-persona.md)部分重叠：同样是改写提示词输入，但那条作用于预设内的 `persona` 作用域行，本条作用于全局 `system-prompt` 行，互链。[bundle 分发决定](../architecture/2026-09-24-distributable-dsh-bundle.md)部分重叠：ready 接线与补丁分层沿用该决定，本次新增一处等待。[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：同一条 `internal/config` 钩子。没有其他活跃提案需要拒绝或归档。
