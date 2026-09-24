# DSH Default Overrides

为 DeepSeek Harness（DSH）的 `standard` 预设配置 Bash / PowerShell 执行通道。支持一次性和持久化模式，分别配置 `bashPath` 与 `pwshPath`，复用宿主 DSH 的官方执行器与工具。

这是可通过 GitHub 或 npm 安装的 DSH **bundle 插件**。源码直接运行，无需编译或安装脚本；DSH 从 [package.json](package.json) 的 `dsh.bundle.patch` 读取[插件补丁](cordis.patch.yml)，自动接入插件和预设 ready 依赖。

## 功能范围

- 四种 Shell 模式，每次只向模型暴露所选方言的一个 Shell 工具。
- 两条可执行文件路径可以同时保留；显式路径会传给对应后端，路径无效直接报错。
- 模型说明与工具参数一致，补充当前方言及禁止套用其他 Shell 的操作规则。
- 通过 `disabledTools` 按行 ID 禁用 `standard` 中的任意插件行；不配置时不动官方预设。
- 通过内存补丁调整官方 `standard` 预设，保留 `minimal` 和其他预设。

未配置任何选项时，本插件不改变官方预设：既不切换 Shell，也不禁用任何工具行。

| `shellMode` | 使用的路径 | 模型工具 | 状态 |
|---|---|---|---|
| `bash` | `bashPath` | `bash` | 每次新 Shell |
| `persistent-bash` | `bashPath` | `bash` | 目录、变量、函数跨调用保留 |
| `pwsh` | `pwshPath` | `pwsh` | 每次新 Shell |
| `persistent-pwsh` | `pwshPath` | `pwsh` | 目录、变量、函数跨调用保留 |

一次性工具必填 `command`、`description`，支持 `workdir`、`timeoutMs`、`run_in_background`；持久化工具仅接受 `command`。

## 环境要求

- Node.js `>=24.15.0`，本机验证版本为 `24.15.0`。
- DSH `0.1.7-rc.1`，目标 profile 包含官方 `standard` 预设，例如 `web`。
- 安装插件的 DSH CLI 需要 PATH 中有 `pnpm`。
- 当前面向 `danger-full-access` 使用场景。

清单通过可选 peer 声明 DSH 精确版本，供宿主兼容性检查使用；可选标记避免包管理器自动安装另一套 DSH。升级宿主前需要重跑验证并更新此声明。源码通过宿主 Loader 解析官方包，没有独立运行依赖。

## 安装

以下远端安装命令在仓库或 npm 包发布后使用；当前代码改造本身不代表已经发布。`YOUR_GITHUB_USER` 是需要替换的 GitHub 所有者，`web` 要替换为实际使用的 profile。首次安装会将 bundle 自动加入该 profile 的 `dsh.profile.bundles`。

从 npm 安装：

```sh
dsh plugin --profile web add dsh-default-overrides@0.2.0
```

或从 GitHub 的版本标签安装：

```sh
dsh plugin --profile web add 'github:YOUR_GITHUB_USER/dsh-default-overrides#v0.2.0'
```

也可在 DSH 插件管理器中安装相同包规格。包内只有可直接加载的源码，没有 `prepare` / `postinstall` 脚本，无需批准本插件的依赖构建。

安装后完整重启 DSH，再新建 `standard` 会话。**默认不改变官方预设**：既不切换 Shell，也不禁用工具行，需要哪些行为就在 profile 补丁里显式配置。

自定义 profile 的 bundle 顺序必须让本插件位于提供 `preset-standard` 的 bundle 之后；正常 `web` profile 安装会自动追加。已有文件 URL 部署请先按[迁移说明](dsh-default-overrides-migration.md)移除旧插入行，避免重复实例。

## 配置

将以下内容合并到实际 profile 的 `cordis.patch.yml`（位置为 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`）。这里只覆盖 bundle 已创建的条目，不使用 `insert`。Windows 完整示例见 [examples/cordis.patch.yml](examples/cordis.patch.yml)。

macOS Bash 示例：

```yaml
- id: local-dsh-default-overrides
  config:
    shellMode: persistent-bash
    bashPath: /bin/bash
    timeoutMs: 300000
    envContext: true
    disabledTools:
      - tool-web
      - tool-workflow
```

Windows 可将 `bashPath` 设置为 `'C:/Program Files/Git/bin/bash.exe'`，并同时保留 `pwshPath: 'C:/Program Files/PowerShell/7/pwsh.exe'`。切换时只修改 `shellMode`。DSH 对匹配行的 `config` 做整体替换，因此要保留仍需使用的配置字段。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `shellMode` | 未设置 | 四种取值见上表；不设置时保留官方 Shell 选择 |
| `disabledTools` | `[]` | `standard` 预设中要禁用的行 ID 数组；ID 不存在时直接报错。不设置时不禁用任何行 |
| `bashPath` | 未设置 | Bash 两模式必填，必须是存在的绝对文件路径 |
| `pwshPath` | 未设置 | 建议显式填写以固定版本；未填写时委托官方 PowerShell 探测 |
| `timeoutMs` | `300000` | 正整数。持久化模式为命令截止时间；一次性模式沿用官方等待、后台处理与上限 |
| `envContext` | `true` | 是否向模型添加模式、配置路径和会话工作区；关闭后仍保留工具操作规则 |

`disabledTools` 按 `standard` 预设的行 ID 生效，包含分组内的行。常用 ID 有 `tool-web`、`tool-workflow`、`tool-ralph`、`skill-filesystem`；完整列表见安装中 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 的 `config.plugins`。本插件只做 `disabled: true`，不改变这些行的其他配置。

只验证和使用当前模式对应的路径。一次性工具的前台等待超时可能将命令转为后台任务，并不等于杀死进程。配置后使用新会话验收，旧会话可能保留旧预设和 Shell 状态。

bundle 已为 `preset-standard` 添加 `dshDefaultOverridesReady`。如果用户层或其他 bundle 覆盖了该行的 `inject`，必须把这个信号与其他依赖一起保留；不能把它加在 `agent-preset-registry` 上。插件暂未导出设置表单 schema，使用上述 YAML 配置。

旧 `shellPath` 和 `blockNestedShells: true` 的迁移见[迁移说明](dsh-default-overrides-migration.md)。插件不修改宿主 PATH，也不强制阻断任意脚本启动其他 Shell。

## 更新、停用与文件部署

- 更新时对同一 profile 执行 `add`，指定新 npm 版本或 GitHub 标签，然后完整重启 DSH。
- 在插件管理器中以**整个 bundle**为单位停用；仅禁用主插件行会让 `standard` 等不到 ready。卸载可执行 `dsh plugin --profile web remove dsh-default-overrides`。
- 停用或卸载时，删除用户层针对 `local-dsh-default-overrides` 的配置；若旧部署手工添加过 ready 依赖，也要仅移除该依赖并保留其他依赖。
- 仍支持直接文件部署，使用 [examples/file.cordis.patch.yml](examples/file.cordis.patch.yml)，同时部署[主插件](scripts/dsh-default-overrides.mjs)和同目录[适配器](scripts/gitbash-executor.mjs)。文件入口与 bundle 二选一。

## 验证

无须在本仓库安装依赖。先运行语法检查：

```sh
npm run check
```

分发验证指定已安装 DSH 的主包目录和实际 Bash 路径；该主包目录应包含 DSH 自身的清单：

```sh
npm run verify:package -- \
  '/absolute/path/to/node_modules/@deepseek-ai/dsh' \
  '/bin/bash'
```

[分发验证脚本](scripts/verify-package.mjs)打出真实 npm tarball，在临时 `DSH_HOME` 中调用 DSH CLI 离线安装，检查 bundle 自动选择、profile 覆盖、包导入与 ready 顺序，然后从安装产物运行[现有运行验证](scripts/verify-dsh-default-overrides.mjs)。不启动完整宿主，也不修改现用 profile。

只验证工作树中的运行源码时使用 `npm run verify -- <DSH-installation> <bash-path> [pwsh-path]`。两个验证命令都可追加真实 PowerShell 路径，例如：

```powershell
npm run verify:package -- `
  'C:/actual/node_modules/@deepseek-ai/dsh' `
  'C:/Program Files/Git/bin/bash.exe' `
  'C:/Program Files/PowerShell/7/pwsh.exe'
```

运行验证覆盖四模式注册与路径传递、工具参数与提示、预设范围、ready 重载、Bash 真进程、持久化 PTY、状态/退出码、后台失败与取消。未提供 PowerShell 路径时只检查 Pwsh 注册与启动参数，并明确跳过实跑。

### 已验证边界

本机验证环境为 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1。该 DSH 安装含既有 Bash marker 修复，本仓库不附带或修改宿主补丁，详见[运行契约记录](.agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md)。

Windows Git Bash/ConPTY、PowerShell 真进程与完整 GUI/模型会话未在此环境实测。声明精确版本也不构成对未修改 DSH 安装的完整兼容证明。实际 GitHub 拉取及 npm registry 安装须在发布后验证。

## 发布

1. 在自己的 GitHub 账号下创建仓库，设置 Git 远端。确定地址后，在 [package.json](package.json) 中补充 `repository`、`homepage`、`bugs`；当前没有预设他人账号。npm 名称默认为 `dsh-default-overrides`，发布前确认可用性和所有权；如果改名，同时修改 bundle 补丁中的 `name` 及文档命令。
2. 运行上面的分发验证，然后执行 `npm pack --dry-run` 检查文件清单。白名单包含运行/验证脚本、补丁、示例和说明，不包含本地依赖及编辑器配置。
3. 提交源码并创建与包版本一致的标签，例如 `git tag v0.2.0`，自行推送提交和标签到 GitHub。GitHub 用户可以直接安装该标签，不需要先发布 npm。
4. 需要 npm 分发时，使用有权限的 npm 账号登录后执行 `npm publish`。`prepack` 会运行语法检查，发布不依赖本机 DSH 路径。

本地也可运行 `npm pack`，再用 `dsh plugin --profile web add ./dsh-default-overrides-0.2.0.tgz` 安装产物。打出的压缩包不必提交到 Git。

分发设计见[bundle 决定](.agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md)，迁入依据见[独立仓库决定](.agents/notes/implemented/architecture/2026-09-24-standalone-plugin-repository.md)。实现参考 [router-standard](https://github.com/yjh051108/dsh-routing-suite/tree/main/preset/router-standard) 和 [dsh-win32](https://github.com/sjh9714/dsh-win32/blob/00a9e0023883ffa4014203ba3932a1e697f52324/src/verify.ts)，执行契约以实际安装的 DSH 为准。

## 许可证

本仓库代码采用 [MIT License](LICENSE)。DSH 及其他外部项目遵循各自的许可证。
