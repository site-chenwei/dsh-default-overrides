# Agent Note: Windows Bash 入口验证与执行环境指引

Status: implemented

## Problem

Windows 的一次性 Bash 无路径分支保留官方 PowerShell，持久化 Bash 却默认 /bin/bash；配置相同方言并不保证选中同一入口。当前指引仅根据方言假设 Git Bash/MSYS，并把反斜杠描述成一律被 Bash 删除，无法处理引用语义和 MSYS 对原生程序参数的二次转换。继续扩大命令文本改写不能识别 printf 格式串等应用参数的含义。

## Decision

仅在 Windows 的 Bash 两模式中解析和固定实际入口，显式 bashPath 优先，否则按宿主 PATH 顺序找到首个 bash.exe。入口类型、路径和文件可用性由执行器初始化校验，不让缺少 Bash 阻断全局 ready。缺失或不兼容时明确诊断，不扫描安装目录、不跳过首个入口或切换方言。非 Windows 与 PowerShell 继续原有执行规则。

在预设的隔离执行上下文提供 dshBashRuntime。一次性后端继承官方 LocalBashExecutor，通过 executeArgv 的准备阶段保证直接工具调用也先验证；异步提示词装配读取同一服务。持久化后端薄封装公开的 BashTerminalBackend，在每个真实终端启动后探测，失败时先完成关闭再报告；初次装配用同一后端建立短暂 PTY，读取事实后关闭。保留官方会话管理、命令封装、超时、取消与后台生命周期。

固定探测命令输出 Bash 版本、uname、cygpath 路径及对宿主 Node 可执行文件的 Unix/Windows 往返转换。按执行语义区分 MSYS、Cygwin、Linux/WSL、其他，不以文件名或 MSYSTEM 代替运行结果。首版仅接受 MSYS 家族，其余类型明确说明未支持。探测使用宿主 PTY 默认 30 秒作为上限，并接受当前请求取消；成功事实由当前执行上下文复用，不保存请求信号控制后续调用。

工具说明、command 参数说明和环境段共享已验证事实，envContext false 仍保留工具规则，其他预设不继承该通道声明。保留 normalizeWindowsPaths 默认关闭及保守范围，不自动改变命令正文或全局 MSYS 转换变量。

## Source and runtime contracts

- [入口与事实](../../../../scripts/bash-runtime.mjs)：固定记录协议、30 秒探测上限、原生路径往返检查及请求取消隔离。成功事实复用，不保存取消信号支配后续请求。
- [一次性执行器](../../../../scripts/gitbash-executor.mjs)：持有子执行器实例并复用 executeArgv；Cordis 不允许父插件直接读取没有 inject 的 shell 服务，不能用 ctx.shell 替代实例引用。
- [PTY 适配器](../../../../scripts/windows-bash-terminal.mjs)：复用公开 Config 和 BashTerminalBackend，处理正常省略的 shellArgs。必须保留 TerminalBackendCleanupError，官方注册表据此保留未完成清理记录及 hasOwnerActivity，包装成普通 Error 会丢失该契约。
- [提示词接线](../../../../scripts/dsh-default-overrides.mjs)：隔离 dshBashRuntime，按实际预设版本读取服务，仍遵守原有通道所有权。
- 文件部署交付五个运行模块。两个入口静态导入事实模块，非 Windows 也必须交付；[分发检查](../../../../scripts/verify-package.mjs)覆盖该依赖闭包。

## Alternatives considered

- **不做/复用官方默认。** 改动最少且不增加启动探测；但 Windows 上无法保证选择 Bash 后真正执行 Bash，与本次目标冲突。
- **遍历常见 Git 安装目录。** Git 未进入 PATH 时也能找到；但多版本选择来源不明确，沿用旧决定对猜测安装位置的限制，只接受配置或 PATH 的明确来源。
- **仅在外部执行 bash --version。** 廉价且容易实现；但无法验证当前启动参数、路径转换能力与真实 PTY，不能据此生成已验证的执行指引。
- **复制持久化工具并提前创建正式终端。** 可以省掉一次临时 PTY；但官方持久化会话缓存是私有实现，复制会引入状态与生命周期维护，选择公开后端扩展点。
- **完整 Bash AST 或更多改写规则。** 可改善语法识别，仍不能判断任意程序参数的用途，保留改写为独立兼容选项。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 已通过，包含语法检查、真实安装产物及全部组件回归；笔记树、格式与归档检查也通过。

本机基线为 macOS、Node 24.15.0、DSH 0.1.7-rc.2。运行验证使用宿主实际组件，覆盖 PATH/显式入口、类型/路径往返失败、取消隔离、真实一次性和 PTY 对不支持 Bash 的拒绝及退出；既有工具回归覆盖状态、非零退出、后台、超时、取消和含空格/中文/单引号的工作目录。持久化工具还验证终端退出后的重建与状态重置。

分发验证使用真实 tarball、临时 DSH_HOME 离线安装及独立五模块文件部署，再从安装产物运行组件回归。独立只读审查用官方 TerminalSessionService 内存夹具复核清理异常保留；不将该夹具算成物理 Windows 通过。

Windows 专项入口为 npm run verify:windows，要求 Windows 主机，检查实际入口、MSYS 指引、诊断终端关闭及原生 Node 的文件/远端路径参数和环境变量；此主机不能执行该验收。

## Consequences

Windows Bash 的选择、实际执行入口和模型指引具备同一事实来源；探测失败能说明入口及失败步骤，配置和模式切换的试错依据更明确。代价是首次装配多一次启动，持久化正式终端也要验证，不支持的家族现在明确失败。

PATH 中没有兼容 Bash 的 Windows 部署需要配置 bashPath；这是有意替换保留 PowerShell 的旧行为。探测会读取与实际启动相同的初始化环境。Windows/MSYS/ConPTY 的物理验收不能由模拟结果替代，完成本地实现不等于已完成 Windows 实测；完整 GUI/模型会话和真实 PowerShell 也未在本机验收。安装更新后需完整重启 DSH 并新建会话。

## Related notes audit

- [可选 Shell 路径](../../implemented/feature/2026-09-24-optional-shell-paths.md)：部分取代 Windows Bash 回退，保留路径可选、显式错误失败与不猜安装目录的理由。
- [运行契约](../../implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md)：部分重叠，继续复用官方执行与清理。
- [环境事实](../../implemented/bug-fix/2026-09-25-environment-facts-in-every-shell-mode.md)：部分重叠，扩展事实来源，保留通道所有权与 envContext 边界。
- [配置适用范围与命令安全](../../implemented/feature/2026-09-25-option-applicability-and-command-safety.md)：无冲突，保留严格 persona 名单、无关配置忽略与保守改写。
- [命令归一化](2026-09-24-windows-path-normalization.md)：部分重叠，指引改为来自真实环境；改写模块、eval 垫片及默认关闭的理由不变。
- [bundle 分发](../../implemented/architecture/2026-09-24-distributable-dsh-bundle.md)：部分重叠，新增运行模块同步更新文件部署和真实安装验证。
- 其余记录无冲突；没有其他活跃 proposed/rejected 记录需要清理。
