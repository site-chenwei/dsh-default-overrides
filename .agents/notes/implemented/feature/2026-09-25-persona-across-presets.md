# Agent Note: persona 覆盖可选地作用于多个预设

Status: implemented

## Problem

`persona` 行补丁只作用于官方 `standard`：这是插件声明兼容的结构基线。但 `ptc` 与 `cordis` 的 `persona` 行与 `standard` 同构（同一行 id、同一包名、`prefix` 为字符串），使用者在这些预设下拿不到自己配置的人设，只能退回官方默认的 `You are a coding agent powered by the {{model}} model.`。实际后果是同一套工作规则在 `standard` 由系统提示词承载、在其他预设只剩 `AGENTS.md`（首个用户轮注入，权威更低），而 `minimal` 连 `agent-instructions` 行都没有，规则完全缺失。

## Decision

新增配置项 `personaPresets`（默认 `['standard']`）：在 `internal/config` 钩子里，凡 `config.id` 命中该列表且已配置 `persona` 的预设，追加同一条 persona 行补丁；结构校验、`complete`/`includeRuntimeContext` 的默认填充与 `standard` 走同一段代码，报错信息带上预设 id。

- **只放宽 persona 行**：Shell 替换、工具行改写、`disabledTools` 仍只作用于 `standard`；非 standard 预设的补丁列表里只有 persona 一项。
- **被列出的预设行必须先等到本插件就绪**：persona 行补丁在 `internal/config` 阶段生效，预设行的 config 一旦先解析完，补丁就静默丢失。bundle 补丁因此为 `preset-standard`（原有）、`preset-ptc`、`preset-cordis`、`preset-minimal` 各加一条 `dshDefaultOverridesReady`；用户自建预设行若列进 `personaPresets`，必须自己补这条 inject。
- **`personaPresets` 必须与 `persona` 同时存在**：非空字符串数组；只写 `personaPresets` 而没写 `persona` 直接报错，避免一个不产生任何补丁的配置项静默生效。
- **默认值不变**：不写 `personaPresets` 时行为与之前逐字节一致，现有 profile 零影响。
- **`configuredPresets` 更名 `configuredShellPresets`**：该集合只有真的打过 Shell/工具行补丁的预设才加入，提示词平面据此判断"本插件是否配置了该预设的 Shell 通道"。persona 行补丁不进这个集合，否则 `ptc`/`cordis` 会被误判成已托管通道，环境事实段与工具说明会跟着说谎。
- **`minimal` 不在默认范围内**：它的 persona 行是 `complete: true` + `includeRuntimeContext: false`，而 persona 补丁会显式写入 `complete: false` + `includeRuntimeContext: true`，注入等于把它从"单句提示词"改回普通会话——要这么做必须由使用者显式列进 `personaPresets`。

## ready 接线的载荷性（上线实测）

第一版只改了插件逻辑、没有动 bundle 补丁，`ptc` 会话实测**没有生效**：会话头部 `agentPreset: standard`，随后 `agent-preset/selected: ptc`，系统提示词仍是官方的 `You are a coding agent powered by the … model.`。原因是 bundle 补丁当时只给 `preset-standard` 和全局 `system-prompt` 行加了 `dshDefaultOverridesReady`，`preset-ptc`/`preset-cordis`/`preset-minimal` 的 config 在本插件的 `internal/config` 钩子注册之前就解析完了。

判别实验（同一套夹具、同一份配置，只切换预设行的 inject）：有 inject → 拿到配置的前缀；去掉 inject → 前缀仍是官方的 `You are a coding agent powered by the {{model}} model.`。这条实验现在留在 [运行验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)里当回归用例。

## Testing

`npm run verify -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.2 下 16 项全 PASS；`npm run verify:package` 18 项全 PASS。

- 新增用例：`personaPresets: ['standard', 'other']` 时**非 standard** 预设的段落里出现配置的前缀；不写该选项时同一预设保留自己的 `You are a coding agent powered by the {{model}} model.` 且拿不到配置的前缀。
- ready 接线回归用例：同一个非 standard 预设去掉 inject 后拿不到前缀（复现上线缺口），保证"预设行必须等就绪"这条耦合不被无声改掉。
- 打包验证增加接线断言：`preset-standard`/`preset-ptc`/`preset-cordis`/`preset-minimal` 四条行都必须带 `dshDefaultOverridesReady`。把 bundle 补丁退回第一版后该断言以 `the bundle patch must gate preset-ptc` 失败——断言确实卡住了这次的真实缺口，而不是同义反复。
- 断言按段落文本而不是渲染后的提示词：夹具继承的官方前缀含未注册的 `{{model}}`，渲染会抛错——这一点与 [环境事实段](../bug-fix/2026-09-25-environment-facts-in-every-shell-mode.md)当时踩的坑同源。
- 错误用例：空数组、含非字符串项、只写 `personaPresets` 不写 `persona` 都在启动时报错。
- 既有用例回归：非 standard 预设未配置 `shellMode` 时不贡献环境段、配置了也不声明通道与截止时间、工具表与基线逐字段相同——证明 persona 放宽没有连带放宽 Shell 与工具行。
- 未覆盖：真实 GUI 会话里 `ptc`/`cordis` 的系统提示词，需要在这两个预设下各起一个会话才能看到（夹具用的是 standard 声明改 id 的组件级替代）。

## Alternatives considered

- **不做，只作用 `standard`。** 改动为零，插件继续只依赖一个预设的结构；代价是同一套规则在 `ptc`/`cordis` 下只剩 `AGENTS.md` 这一层，而它比系统提示词弱一级，`minimal` 下干脆没有。
- **在 profile 里按行 id 覆盖 `preset-ptc`/`preset-cordis` 的 `config.plugins`。** web 预设补丁自己说明"Web 编辑器保存的修改会按行 id 覆盖 profile 补丁"，所以这条路可行且不用发包；代价是同一份 persona 正文要在 profile 里出现三份（除非用 YAML 锚点，而 profile 加载器是否支持锚点未验证），并且绕过了插件的结构校验与 `complete`/`includeRuntimeContext` 默认填充——上游改 persona 行结构时不会有任何报错。
- **对每个预设各挂一份本插件实例。** 不用新选项；但 `internal/config` 钩子会对同一个预设被多条补丁链重复处理，`patched` 弱表与 ready 时序都要重新论证，收益只是省一个字符串数组。
- **改 `system-prompt/assemble`，按列表往所有预设注入 persona 前缀段落。** 一处生效、不必关心预设行结构；但那是在渲染层伪造"部署方身份说明"，绕过官方 persona 扩展点与 `complete`/`includeRuntimeContext` 语义（`minimal` 的单句提示词会被顶回多段），与上游机制正面冲突。

## Consequences

同一份人设可以用一个数组覆盖多个同构预设，`AGENTS.md` 里那些只因"非 standard 没有系统提示词人设"而保留的重复段落可以逐步撤掉。

代价是 persona 行的结构依赖从 1 个预设扩散到被列出的每个预设：上游若只改了 `ptc` 或 `cordis` 的 persona 行，启动时会直接报错（这是有意的，报错好过静默不生效）。列表里写错预设 id 不会报错——与 `disabledTools` 不同，本插件无法枚举宿主有哪些预设——所以写错的后果是"那个预设静默拿不到人设"。同一类静默缺口还剩一个：**用户自建的预设行**（不在四条 shipped 行里）被列进 `personaPresets` 时，必须自己给它加 `dshDefaultOverridesReady`，否则同样静默不生效——bundle 只能给已知行接线。

## Related notes audit

[可配置 persona](2026-09-24-configurable-persona.md)被本次部分取代：选项语义、行补丁做法、字段默认值全部沿用，只有作用范围从固定 `standard` 放宽为可配置列表，两篇互链。[环境事实段](../bug-fix/2026-09-25-environment-facts-in-every-shell-mode.md)部分重叠：都坚持"按预设 id 判断本插件是否真的配置过"，本次沿用 `configuredShellPresets` 这一口径。[可配置禁用清单](2026-09-24-configurable-disabled-tools.md)与[bundle 分发决定](../architecture/2026-09-24-distributable-dsh-bundle.md)无冲突：`disabledTools` 与空配置零影响两个结论继续成立。没有其他活跃提案需要拒绝或归档。
