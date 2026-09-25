# Agent Note: 配置按适用范围生效与保守路径改写

Status: implemented

[Windows Bash 入口验证](2026-09-25-verified-windows-bash.md)沿用本记录的选项适用范围、persona 精确名单与保守改写；只把 Windows Bash 入口校验放到其执行上下文，并将部署模块扩为五个。

## Problem

切换 PowerShell 时保留 `normalizeWindowsPaths: true` 会阻止插件加载；只预填 `personaPresets` 也会报错。`standard` 绕过名单判断，导致只选 ptc 仍修改 standard。路径改写把双引号内的转义引号改坏，已通过一次性 Bash 和真实 PTY 复现原字符串内容成为额外命令；含盘符的 sed 表达式同样被改坏。文件部署说明遗漏 command-paths 模块与全局 system-prompt 的 ready 接线。

## Decision

受支持的配置可以预先填写，只校验并使用当前适用字段。路径按方言选择，路径改写只在 Bash 家族生效，timeoutMs 只在实际配置 Shell 后端时生效。有效分支中的无效值、未知 shellMode 和废弃字段迁移错误继续报错。

persona 对所有预设使用同一名单判断。省略名单默认 standard，空名单停用覆盖，未配置 persona 时名单不生效；只在命中名单时校验正文。Shell 与禁用工具仍只修改 standard，环境上下文与框架身份开关保持独立。只有真实 Shell 行替换才记录通道所有权，persona 覆盖与工具禁用不影响它。

归一化只处理整个简单参数为盘符绝对路径的情况；扫描引用与转义，遇到展开、转义引号、heredoc、括号/花括号复合语法或不完整引用时整条原文透传。混合引用和 sed 等表达式保留原文，不扫描其内部盘符。完整扫描成功后才返回改写结果，一次性和持久化继续共用一个模块。

文件部署包含主插件、适配器、command-paths 三个模块，并让四个 shipped 预设和全局 system-prompt 等待 ready。用户 persona 在 profile 层明确一次审批、真实验证、任务提交和不确定性边界，不成为 npm 包默认值。

## Alternatives considered

- **复用现状，切换模式时删除冲突字段。** 无实现改动且错误暴露早；但违背用户的一份配置多模式切换要求，也不能解决预设越界和命令结构破坏。
- **取消所有校验。** 任意配置都能启动；但实际使用无效路径或类型会变成更晚、更难定位的执行失败，因此只放宽不适用分支。
- **只修引号，继续扫描任意片段。** 改动最小且保留识别范围；但 sed 与内嵌程序中的盘符不等于 Shell 路径参数，因此选择整个简单参数识别和复杂命令透传。
- **引入完整 Bash AST 解析器。** 覆盖丰富语法；当前修复只需要常见路径参数和明确退出条件，不增加依赖与跨平台解析契约。

## Testing

在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.2 上运行现有 `npm run verify -- <DSH-installation> /bin/bash` 通过：

- 非 Bash 模式保留 true 或不适用类型的改写值，注册配置与未开启一致；实际 Pwsh spawn 参数不变，无接管时负 timeout 不阻断。
- 只选 ptc 时 standard 逐字段原样，真实 ptc 声明获得 persona；空名单、默认名单、只有名单与 Shell 补丁独立性符合约定。
- 两条真实 Bash 工具链均转换简单引用/未引用路径；转义引号仍为字符串，未执行 SHOULD_NOT_RUN；sed 表达式正常执行。
- 展开、heredoc、未闭合引用与混合引用的针对性检查通过，原有后台失败、超时、取消和状态生命周期验证继续通过。

`npm run verify:package -- <DSH-installation> /bin/bash` 同样通过。分发验证覆盖 tarball 中的第三个模块和三文件部署示例：通过实际 Loader 检查 ptc persona、standard 排除、harness identity 隐藏和适配器导入；从安装产物重跑运行验证。

## Consequences

配置可跨模式保留，persona 作用范围由明确名单控制；路径扫描不再把转义引号变成 Shell 语法。保守透传意味着复杂命令中的反斜杠不会自动纠正，调用方应显式使用正斜杠；需要反斜杠字面量时应关闭选项。UNC 和任意应用层字符串语义不在自动纠正承诺内。

Windows/ConPTY、真实 PowerShell 仍需目标环境验证。persona 注入可以验证，质量提升需要独立对照实验。旧会话可能保留预设版本，以新进程和新会话验收运行版本。

## Related notes audit

- [路径归一化](2026-09-24-windows-path-normalization.md)：部分取代非 Bash 报错与片段改写决定，保留模块和垫片链路，双方互链。
- [跨预设 persona](2026-09-25-persona-across-presets.md)：部分取代非空名单与必须同时配置的约束，保留 ready 和隔离，双方互链。
- [可选路径](2026-09-24-optional-shell-paths.md)：部分重叠，保留官方默认和当前路径校验，补充 timeout 适用条件并互链。
- [环境事实](../bug-fix/2026-09-25-environment-facts-in-every-shell-mode.md)：无冲突，沿用未接管时不声明 Shell 的契约。
- [bundle 分发](../architecture/2026-09-24-distributable-dsh-bundle.md)：部分重叠，补齐文件部署与模块交付并互链。
- 其余实现记录无冲突，没有待清理的其他 proposed/rejected 记录。
