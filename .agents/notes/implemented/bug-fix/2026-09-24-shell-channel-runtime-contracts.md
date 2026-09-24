# Agent Note: 修复四模式 Shell 的加载与执行契约

Status: implemented

## Problem

四模式配置测试通过，但真实链路存在缺陷：入口不发布 dshDefaultOverridesReady；一次性 Bash 未声明 subprocess 注入；自研句柄把启动失败转成 completed/null，后台显示 exit code 0；全局 PATH shim 被 PowerShell 探测误选；applyEntryPatches 缺 warn 回调导致 minimal 报错；一次性工具忽略 description 配置，环境段又错误声称仅接收 command。路径互斥妨碍只改 shellMode 切换，执行器未纳入提交。

这些事实推翻了早期四模式实现中自研生命周期、省略 subprocess 依赖及全局 shim 的理由。四模式、分开的路径和私有 realm 继续成立。

## Decision

[主插件](../../../../scripts/dsh-default-overrides.mjs)恢复标准预设对 dshDefaultOverridesReady 的依赖，钩子就绪后才发布服务。仅覆盖 standard，传入 warn 回调，保留其他预设和延迟表达式。

[Git Bash 适配器](../../../../scripts/gitbash-executor.mjs)继承官方 LocalBashExecutor，仅把 argv 改为配置路径与 -lc；超时、取消、输出、后台观察和失败传播使用官方 executeArgv。适配器声明 loader/subprocess 依赖；一次性 Pwsh 与持久化两模式继续使用官方实现。

bashPath/pwshPath 可以并存，严格选择当前家族的路径，仅校验当前路径。显式路径错误直接失败，不跨家族或静默探测替换。Bash 路径必填，Pwsh 仅在未配置路径时委托官方探测；下游各自的 shellPath/pwshPath 配置键不改变。

删除全局 PATH shim，不修改宿主环境或写 DSH_HOME。旧 blockNestedShells: true 明确提示迁移，false 作为无操作的旧配置保留；旧进程需完整重启。禁套壳通过准确工具说明表达，不宣称阻断绝对路径或任意脚本。

保留官方工具说明与 schema，通过 system-prompt/assemble 复制目标工具并追加 Shell 操作规则；环境段区分持久化 command-only 和一次性 command/description/workdir。路径和工作区通过变量渲染。[部署说明](../../../../dsh-default-overrides-migration.md)要求完整重启、新会话，并给出两文件交付和 ready 的完整接线。

## References

- [router-standard 组合](https://github.com/yjh051108/dsh-routing-suite/blob/main/preset/router-standard/agent.cordis.yml)及[执行器](https://github.com/yjh051108/dsh-routing-suite/blob/main/preset/router-standard/gitbash-executor.mjs)：采用私有 shell realm 和显式 Git Bash argv；其旧 run/start 协议不能照搬到当前 execute/result。
- [dsh-win32 当前验证实现](https://github.com/sjh9714/dsh-win32/blob/00a9e0023883ffa4014203ba3932a1e697f52324/src/verify.ts)：复用官方终端及 persistent Pwsh，用同一 agent 经工具入口验证状态和退出码。已检查版本没有独立 legacy persistent Pwsh 实现，不把其 Git Bash/busybox 旧后端误引为 PowerShell 来源。
- 本机 DSH 0.1.7-rc.1 的 dsh-bash-local、dsh-pwsh-local、dsh-terminal-bash 和持久化工具是实际执行契约来源。保留官方 Pwsh 交互启动参数、prompt readiness 和命令 nonce 标记的分工，不复制旧私有接口。

## Alternatives considered

- **不做/复用原测试。** 改动最少，但真实注册与进程链已复现启动失败和假成功，不能据配置断言接受。
- **继续修补自研执行器。** 保留内部字段，但重复官方取消/输出/错误状态机；executeArgv 已提供所需扩展点。
- **复制参考项目旧版执行器。** 有 Windows 使用依据，但协议与当前安装不同，只采用组合和验收方式。
- **将 shim 缩到子进程。** 可保留部分名称遮蔽，但 Bash/Pwsh 解析不同且绝对路径仍可绕过；删除环境侵入，保留单工具通道与操作规则。
- **保留路径互斥。** 提前报误配，但阻止两条正确配置共存；按模式选择字段即可防止路径串用。

## Testing

[验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)在隔离的临时 home/workspace 使用本机安装组件通过以下针对性检查，没有新增测试依赖：

- 真实 AgentPreset.register 收到已覆盖声明；standard 先声明仍等 ready；配置重载只插入一组；minimal/custom 原样；可选目标缺失不崩溃；官方文件字节保持。
- 实际预设注册表挂载 Shell 子树、绑定 agent，真实工具注册表/SystemPrompt 验证四模式工具名、必填参数、准确方言说明与环境段。两路径共存，所选路径逐一到达 subprocess spawn 接口；宿主环境不变。
- 一次性 Bash 经真实 subprocess 和官方工具验证成功、非零、目录/变量重置、错误 cwd 前台报错与后台启动失败报告、输出游标、超时转后台、执行器截止时间与取消。
- 持久化 Bash 经真实 PTY 和模型工具入口验证目录/变量跨调用保留、非零退出及后续成功。安装中先前的 marker 修复保持原样，不将其算作本次源码改动。
- Pwsh 两模式通过真实注册、提示与准确 spawn 参数检查，spawn 记录后主动中止。未提供实际 Pwsh 路径，因此没有声称 PowerShell 运行通过。脚本可传第三个路径参数在目标机执行两种 Pwsh 模式和状态检查。

工具夹具使用 agent 对象自身作为 scope key，与真实 dispatch 一致；没有手工重放 internal/config 或复制持久化命令 wrapper。Shell 子树之外的标准工具未完整启动，这些结果不代表完整 GUI/模型会话验收。

## Consequences

修复启动顺序、依赖声明与假成功，减少自研生命周期代码；配置只需切换模式即可复用两条路径。模型接收的参数和方言事实与实际工具一致，minimal 不再受本插件影响。

部署必须保留 ready 等待、同时交付适配器，并移除旧启用 shim 的配置、完整重启。操作规则不强制阻断任意脚本；旧会话可保留旧版本和 Shell 状态，配置切换使用新会话验收。

本机是 macOS，Windows Git Bash/ConPTY、PowerShell 真进程与内网定制组合仍需目标机验收。官方扩展接口升级后需重跑针对性脚本。本次不改安装包、运行中 profile 或内网主机。

## Related notes audit

本记录从来源项目提交 `bb56fb6` 迁入，与[独立仓库决定](../architecture/2026-09-24-standalone-plugin-repository.md)部分重叠：运行决定和验证边界保持，源码/部署链接指向本仓库。来源中的首次四模式、声明式迁移、统一入口和标准上下文笔记留在原项目，当前部署不依赖那些文档或路径。Codegraph、persona、搜索工具及安装包 marker 修复属于其他范围，没有迁入；无完全吸收或需要拒绝、归档的提案。
