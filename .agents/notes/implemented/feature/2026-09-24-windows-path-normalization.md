# Agent Note: Windows 反斜杠路径的命令归一化

Status: implemented

## Problem

在 Windows 上启用 Bash 通道后，模型会写出未加引号且使用反斜杠的路径，例如 `cd C:\Users\chenwei\xwfintech\xwfintech-components\packages\h5-business-components\docs && pwd`。bash 把反斜杠当转义符，命令**解析成功**（退出码 0）但路径已变成 `C:Userschenweixwfintech...`，错误发生在 `cd` 找不到目录这一步。

本机实测确认这是 bash 自身的行为、与平台无关：`printf '%s\n' C:\Users\chenwei\docs` 输出 `C:Userschenweidocs`，加双引号才保留反斜杠。因此**任何在 shell 内部的事后补救都拿不到原始文本**，改写必须发生在命令进入 bash 解析之前。

## Decision

新增布尔配置项 `normalizeWindowsPaths`，默认 `false`，只对 `bash` 与 `persistent-bash` 有效；用于其他模式或未设置 `shellMode` 时直接报错，避免静默无效的配置。

归一化逻辑集中在 [command-paths.mjs](../../../../scripts/command-paths.mjs)：只改写盘符开头的路径段（`X:\…`），引号内允许空格一路改写到配对引号，正则与转义里的反斜杠（`sed 's/\\d//'`、`"a\tb"`）保持原样。该模块同时带一个 stdin→stdout 的 CLI 入口。

两条链路的接入点不同：

- **一次性 `bash`**：[gitbash-executor.mjs](../../../../scripts/gitbash-executor.mjs) 本来就覆写了 `execute(spec)` 并在 `-lc` 前拿到命令原文，直接改写后再交给 `executeArgv`。
- **持久化 `bash`**：命令由官方工具包成 `eval -- $'<原始命令>'`（`dsh-tool-bash-persistent/lib/index.js:87-91`）后写进 PTY；该包只导出 `apply/name/inject/Config`，没有可子类化的类，真正写 PTY 的 session 类也未导出，插件在 Node 侧够不到命令原文。因此改为给 `dsh-terminal-bash` 行传官方 `shellArgs`，用 `--rcfile` 加载生成的垫片；垫片把 `eval` 定义成函数，它收到的正是**已剥离引用的原始命令**，调用同一个归一化模块后再 `builtin eval`。垫片只在命令里出现 `X:\` 时才 spawn node，其余情况原样透传 `builtin eval "$@"`。

提示词层同时强化：工具说明里给出反例与改写式（`cd C:\Users\me` 会变成 `cd C:Usersme`），并把同样的规则追加到 `command` 参数说明上，紧挨模型实际填写的位置。

垫片写在 `os.tmpdir()/dsh-default-overrides-bashrc.sh`，每次 DSH 启动重新生成，只在启用该选项时落盘。

## Alternatives considered

- **只做提示词强化。** 零风险、零侵入；但 Windows 上模型仍会写出反斜杠路径，属概率性缓解，不能保证。
- **在 Node 侧解析官方包装串。** 子类化已导出的 `TerminalSessionService` 并在 `startSend` 里改写 `$'…'` payload，可复用同一个 JS 实现；但要把 ANSI-C 转义的 payload 反解再重编码，比"依赖官方调用 eval"更深地耦合宿主内部格式，还要替换宿主服务。
- **子类化 BashTerminalBackend。** 该类确实导出（`dsh-terminal-bash/lib/index.js:1075`），但发送命令的 session 类没有导出，拿不到写入点。
- **每条命令都调用 node 归一化。** 实现统一、语义一致；但每条命令都要付一次进程启动成本，因此在垫片里先用 bash 判断命令是否含 `X:\`，只对可能的路径命令付这个代价。
- **默认开启。** Windows 用户无需配置；但改写是启发式的：转正斜杠对 bash 内建与 MSYS 程序正确，对少数只认反斜杠的原生程序（如 `robocopy`）可能反而出错，因此默认关闭。
- **在 shell 里用纯 bash/sed 改写。** 省掉 node 进程与路径依赖；但要么第二套实现（与 JS 语义漂移），要么处理不了引号内的空格路径，且 sed 多次回溯更绕。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1 下通过（17 项断言全绿）：

- 归一化规则针对 10 组输入逐个核对：未加引号的盘符路径、引号内含空格的路径、单引号路径、已是正斜杠的路径、`sed 's/\\d//'` 与 `"a\tb"` 保持不变、`git status` 无改动。
- 配置层：未启用时不落垫片文件；`bash` 模式把该开关传到适配器行；`persistent-bash` 模式把 `--noprofile --rcfile <shim> -i` 传给 `terminal-shell` 行；默认（关闭）时持久化 argv 仍是 `--noprofile --norc -i`。
- 错误用例：非布尔值、配到 `pwsh`、未设置 `shellMode` 三种情况都在注册阶段报错。
- 真实执行：关闭选项时一次性与持久化两种模式都复现 `C:Userschenweidocs`（证明失败机理）；开启后两种模式都输出 `C:/Users/chenwei/docs`，其中持久化是经真实 PTY 与官方工具的 `eval` 包装链路的端到端结果。
- 提示词：bash 方言的工具说明与 `command` 参数说明都带上反斜杠规则，且重复组装不累积。

未验证：Windows 上 Git Bash 是否接受 `C:/…`、`--rcfile` 在 Git Bash 中的行为、以及真实 Windows 会话里的模型行为，本机（macOS）无法覆盖。

## Consequences

Windows 上只要开启该选项，模型写出的反斜杠路径会在进入 bash 前被改写，`cd`/`ls`/`cat` 这类内建与 MSYS 程序可以正常工作；同一份归一化实现服务一次性与持久化两条链路，避免两套语义漂移。

代价与缺口：改写是启发式的，只认盘符开头的路径段（UNC 路径如 `\\server\share` 不在覆盖范围），且可能改变把 Windows 路径当字面量传给原生程序的命令语义；持久化链路依赖官方工具继续用 `eval --` 包装，若宿主改版，垫片会静默失效（命令仍可执行，只是不再改写）。启用该选项后，含 `X:\` 的命令会多一次 node 进程启动。

## Related notes audit

[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：同样作用于 Shell 通道，但那条定的是执行器 argv 与生命周期，本次只在命令文本进入 bash 前改写，互链。[可配置禁用清单](2026-09-24-configurable-disabled-tools.md)与[可配置 persona](2026-09-24-configurable-persona.md)部分重叠：同为可配置项，沿用"配置错就报错"的取向。没有其他活跃提案需要拒绝或归档。
