# DSH Default Overrides

为 DeepSeek Harness（DSH）的 `standard` 预设配置 Bash / PowerShell 执行通道。支持一次性和持久化模式，分别配置 `bashPath` 与 `pwshPath`，复用当前 DSH 安装中的官方执行器与工具。

这是通过文件路径加载的本地插件，不需要在本仓库运行 `npm install`。当前面向 `danger-full-access` 使用场景。

## 功能范围

- 四种 Shell 模式，每次只向模型暴露所选方言的一个 Shell 工具。
- 两条可执行文件路径可以同时保留；显式配置的路径会传给对应后端，路径无效直接报错。
- 模型说明与实际工具参数一致，补充当前方言和禁套壳操作规则。
- 默认禁用 `standard` 中的 `tool-web` 与 `tool-workflow` 行。
- 通过内存补丁调整当前官方预设，保留 `minimal` 和其他预设。

| `shellMode` | 使用的路径 | 模型工具 | 状态 |
|---|---|---|---|
| `bash` | `bashPath` | `bash` | 每次新 Shell |
| `persistent-bash` | `bashPath` | `bash` | 目录、变量、函数跨调用保留 |
| `pwsh` | `pwshPath` | `pwsh` | 每次新 Shell |
| `persistent-pwsh` | `pwshPath` | `pwsh` | 目录、变量、函数跨调用保留 |

一次性工具必填 `command`、`description`，支持 `workdir`、`timeoutMs`、`run_in_background`；持久化工具仅接受 `command`。

## 安装

1. 将仓库放到固定目录，或把 [主插件](scripts/dsh-default-overrides.mjs) 和 [Git Bash 适配器](scripts/gitbash-executor.mjs) 复制到同一目录。主插件按自身位置加载适配器。
2. 将下面的配置合并到实际 DSH profile 的宿主补丁中。已有本插件条目时修改原条目，已有 `inject` 依赖时合并保留。
3. 按实际位置修改文件 URL 和 Shell 路径，完整重启 DSH，再新建 `standard` 会话。

完整示例也保存在 [examples/cordis.patch.yml](examples/cordis.patch.yml)：

```yaml
- insert:
    - id: local-dsh-default-overrides
      name: 'file:///C:/Tools/dsh-default-overrides/scripts/dsh-default-overrides.mjs'
      config:
        shellMode: persistent-bash
        bashPath: 'C:/Program Files/Git/bin/bash.exe'
        pwshPath: 'C:/Program Files/PowerShell/7/pwsh.exe'
        timeoutMs: 300000
        envContext: true

- id: preset-standard
  inject:
    - dshDefaultOverridesReady
```

`preset-standard` 必须等待 `dshDefaultOverridesReady`。配置行的排列顺序不能替代这条依赖；不要把它加在 `agent-preset-registry` 上。

切换时只修改 `shellMode`，两条路径可继续保留。旧会话可能保留旧预设和 Shell 状态，需要用新会话验收。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `shellMode` | 未设置 | 四种取值见上表；不设置时保留官方 Shell 选择，仍禁用上述两个工具行 |
| `bashPath` | 未设置 | Bash 两模式必填，必须是存在的绝对文件路径 |
| `pwshPath` | 未设置 | 建议显式填写以固定版本；未填写时委托官方 PowerShell 探测 |
| `timeoutMs` | `300000` | 正整数。持久化模式为命令截止时间；一次性模式沿用官方等待、后台处理与上限 |
| `envContext` | `true` | 是否向模型添加模式、配置路径和会话工作区；关闭后仍保留工具操作规则 |

只验证和使用当前模式对应的路径，不会从另一类型的字段取值。一次性工具的前台等待超时可能将命令转为后台任务，并不等于杀死进程。

旧 `shellPath` 字段和 `blockNestedShells: true` 需要迁移，详见 [迁移说明](dsh-default-overrides-migration.md)。插件不再修改宿主 PATH，也不强制阻断任意脚本启动其他 Shell。

## 验证

在仓库根目录运行语法检查：

```sh
npm run check
```

随后指定已安装 DSH 的主包目录和实际 Shell 路径。主包目录中应包含 DSH 自身的 `package.json`；它不是本插件目录。

macOS 示例：

```sh
npm run verify -- \
  '/absolute/path/to/node_modules/@deepseek-ai/dsh' \
  '/bin/bash'
```

Windows PowerShell 示例：

```powershell
npm run verify -- `
  'C:/actual/node_modules/@deepseek-ai/dsh' `
  'C:/Program Files/Git/bin/bash.exe' `
  'C:/Program Files/PowerShell/7/pwsh.exe'
```

[验证脚本](scripts/verify-dsh-default-overrides.mjs)使用安装树中的真实 Cordis Loader、预设注册表、工具、提示组装、Jobs、Subprocess 和终端后端，在临时 home/workspace 中检查：

- ready 等待、重载、预设作用范围和四模式路径传递；
- 工具参数与环境说明、宿主环境保持不变；
- 一次性 Bash 的执行、退出状态、后台失败、输出、超时转后台与取消；
- 持久化 Bash 的真实 PTY、跨调用状态与错误恢复；
- 提供第三个路径参数时的 PowerShell 两模式运行与状态检查。

未提供 PowerShell 路径时，脚本仅验证 Pwsh 注册、提示与实际启动参数，并明确报告跳过实跑。

### 已验证边界

迁入版本在 macOS、Node.js 24.15.0、本机 DSH 0.1.7-rc.1 安装上通过针对性验证。该安装保留既有 Bash marker 修复，本仓库没有附带或修改该安装包补丁。源码和运行契约依据见 [修复记录](.agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md)。

Windows Git Bash/ConPTY、PowerShell 真进程与完整 GUI/模型会话尚未在此环境实测。这些结果也不构成对所有 DSH 版本的兼容承诺；升级 DSH 后应重跑针对性验证。

## 开发

- 所有 JavaScript 脚本集中在 `scripts/`，两个插件文件必须同目录部署；npm 命令仍从仓库根目录运行。
- 官方包通过宿主 Loader 解析；不在本仓库复制或另装一套 DSH 依赖。
- 本仓库是插件后续维护位置；迁移来源和取舍见 [独立仓库决定](.agents/notes/implemented/architecture/2026-09-24-standalone-plugin-repository.md)。
- [package.json](package.json) 的 `private: true` 仅避免误发 npm，不影响公开 GitHub 仓库。当前没有 npm 发布配置。

实现参考 [router-standard](https://github.com/yjh051108/dsh-routing-suite/tree/main/preset/router-standard)、[dsh-win32 的官方持久化 Pwsh 验证组合](https://github.com/sjh9714/dsh-win32/blob/00a9e0023883ffa4014203ba3932a1e697f52324/src/verify.ts)，并以实际安装的 DSH 接口为准。参考项目旧版接口没有直接照搬。

## 许可证

本仓库代码采用 [MIT License](LICENSE)。DSH 及其他外部项目遵循各自的许可证。
