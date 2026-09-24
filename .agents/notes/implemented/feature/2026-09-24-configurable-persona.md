# Agent Note: 新增可配置的 persona 覆盖

Status: implemented

## Problem

`standard` 预设的 persona 前缀是部署方身份说明（`You are a coding agent powered by the {{model}} model.`），使用者在 profile 层只能整体替换 `preset-standard.config.plugins`，或再挂一个 bundle 才能固定人设。内网使用需要把前缀固定为一句确定的中文/英文身份说明，同时保住官方 suffix、工具说明、计划模式约束和运行时上下文。

## Decision

新增配置项 `persona`，在 `internal/config` 钩子中对 `standard` 的 `persona` 行追加一条 `{ id, name, config }` 补丁；行补丁整体替换 `config`，所以先展开当前有效配置再覆盖写出的字段：

- `prefix`、`suffix`：只覆盖写出的字段，未写的沿用当前值（官方 suffix `Your working directory is {{cwd}}.` 因此保留）。
- `complete`：未写时报文写入 `false`，避免上游或前序补丁把整个系统提示词锁成单句。
- `includeRuntimeContext`：未写时报文写入 `true`，本次不抑制运行时上下文。
- 未设置 `persona` 时不产生任何补丁，`standard` 原样放行。

行结构在挂载前校验：必须恰好一行 `persona`、包名为 `@deepseek-ai/dsh-persona`、`config.prefix` 为字符串，否则报错。这既拦住上游改结构，也拦住把字段写成旧示例里的 `text`。

选项本身在 `apply` 阶段校验：必须是对象、至少一个字段、键名限定在 `prefix`/`suffix`/`complete`/`includeRuntimeContext`、字符串与布尔类型分明。未知键直接报错，避免 `preifx` 这类拼写错误静默不生效。

本插件不复制官方预设、不改 DSH 安装包、不引入 router-standard 的首轮精简或阶段机制，也不支持子代理人设（`dsh-subagent` 各自的人设不受影响）。

## Alternatives considered

- **不做/继续在 profile 层整体覆盖 `preset-standard.config.plugins`。** 不需要新代码；但使用者必须抄写整份官方条目树，上游一改就整块过期，且 ready 顺序与 Shell 覆盖都要自己维护。
- **把前缀硬编码成一句话（内网方案原文）。** 改动最小，直接满足单个内网场景；但换一句话就要改代码重新发包，与其他选项"可配置"的取向不一致。
- **复用官方 `persona` 行以外的机制，例如在 `system-prompt/assemble` 里改写段落文本。** 能绕开行补丁；但那是在渲染阶段改文本，会与 `dsh-system-prompt` 的段落注册和图谱变量插值打架，而官方本就提供了 `persona` 行这一扩展点。
- **配置项直接接受 persona 插件的完整 config 对象并整体替换。** 语义最简单；但会丢掉官方 suffix 等未写字段，使用者必须自己抄一份当前值，正是本次要避免的。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1 下通过。

- [分发验证脚本](../../../../scripts/verify-package.mjs)在打包产物与真实 Loader 上确认 persona 行被替换成配置的前缀。
- [运行验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)在真实注册链路上断言：`persona: { prefix }` 得到 `{ ...官方 config, prefix, complete: false, includeRuntimeContext: true }`，官方 suffix 模板保留；除该行外整棵条目树与官方预设逐字段一致；只写 `suffix` 时前缀保留；四个字段全写时原样落盘；preset 缺少 persona 行时报错。
- 运行夹具挂载真实 `dsh-persona` 行后调用 `renderPrompt`，断言四模式下渲染出的系统提示词都包含配置的前缀与后缀，且长度大于两者之和，证明 `complete: false` 下其他段落仍在。
- 错误用例覆盖非对象、`null`、空对象、未知键、字符串/布尔类型不符。

夹具原先没有注册 `{{cwd}}`，挂载真实 persona 行后官方 suffix 模板无法渲染，因此夹具显式给了字面 suffix；真实宿主注册该变量，不受影响。

## Consequences

固定人设变成一次配置，升级插件或 DSH 不再需要改代码；未写字段沿用当前值，官方 suffix、工具说明与运行时上下文默认保留。

代价是插件多了一处对官方行结构的依赖：上游若重命名 `persona` 行或把 `prefix` 换成别的字段，插件会在启动时明确报错而不是静默失效。`{{...}}` 仍是宿主的严格插值，写错变量名会让组装失败。

## Related notes audit

[可配置禁用清单](2026-09-24-configurable-disabled-tools.md)部分重叠：同一个 `internal/config` 补丁列表与同一套"配置错就报错"的取向，本次只是新增一类补丁。[bundle 分发决定](../architecture/2026-09-24-distributable-dsh-bundle.md)部分重叠：空默认配置下插件不改变预设的结论继续成立，本次新增选项属于同一配置面。[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：沿用同一钩子和 ready 时序。没有其他活跃提案需要拒绝或归档。
