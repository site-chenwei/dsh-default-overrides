# DSH Default Overrides

为 DeepSeek Harness（DSH）配置 Shell、助手人设和工具开关。你可以选择 Bash 或 PowerShell，使用保留目录与变量的持久化终端，并为指定预设设置人设。

**安装后默认不改变现有行为。** 按需添加配置即可，不需要修改 DSH 安装文件。

## 使用前

- 已安装并能正常启动 DSH；建议使用自带的 `web` profile。
- 目标 profile 包含官方 `standard` 预设。Shell 选择和工具禁用只作用于这个预设。
- 安装所需的 `pnpm` 能从 PATH 中找到。
- 使用 Bash 或 PowerShell 前，先在机器上安装相应程序。Windows 的 Git Bash 来自 Git for Windows。
- 当前面向 DSH 的 `danger-full-access` 权限模式使用；执行权限仍由 DSH 管理。

当前本机验证基线为 macOS、Node.js 24.21.0、DSH 0.2.0-rc.2（npm 安装的宿主，不含任何本地宿主修补）。**Windows Git Bash / MSYS2 的接入已实现，Windows 实机与 ConPTY 验收尚未完成；PowerShell 真进程也尚未在此环境验收。** 插件不限制安装版本，其他 DSH / Node 版本的兼容性需要实际确认。

## 安装

以下以 `web` profile 为例；使用其他 profile 时替换名称：

```sh
dsh plugin --profile web add dsh-default-overrides
```

也可以在 DSH 插件管理器中安装 `dsh-default-overrides`。需要固定版本时使用 `dsh-default-overrides@版本号`。

安装后完整重启 DSH。接着编辑目标 profile 的配置文件：

```text
~/.dsh/profiles/web/cordis.patch.yml
```

`~` 表示当前用户目录；自定义了 DSH 数据目录时，使用该目录下的 `profiles/web/cordis.patch.yml`。

## 快速配置

在 profile 配置中添加或修改**同一个** `dsh-default-overrides` 条目：这一行的 `id` 与包名相同。通过插件管理器或上述命令安装后，不需要再添加 `insert`、`name` 或文件入口。

### Windows：使用 Git Bash

将路径换成实际安装位置：

```yaml
- id: dsh-default-overrides
  config:
    shellMode: persistent-bash
    bashPath: 'C:/Program Files/Git/bin/bash.exe'
```

### macOS / Linux：使用 Bash

```yaml
- id: dsh-default-overrides
  config:
    shellMode: persistent-bash
    bashPath: /bin/bash
```

保存配置、完整重启 DSH，再新建 `standard` 会话。持久化模式会在连续的工具调用之间保留目录、变量和函数。

**多个示例请合并到同一份 `config` 中。** DSH 会整体替换这份配置，修改时保留仍需使用的字段。完整配置示例见 [配置示例](examples/cordis.patch.yml)。

## 选择 Shell

| `shellMode` | 使用的 Shell | 目录、变量、函数是否跨调用保留 |
|---|---|---|
| `bash` | Bash | 否，每次新建 Shell |
| `persistent-bash` | Bash | 是 |
| `pwsh` | PowerShell | 否，每次新建 Shell |
| `persistent-pwsh` | PowerShell | 是 |

需要连续执行 `cd`、设置环境变量或定义函数时，选择持久化模式。终端退出或因超时被重置后，这些状态不会保留。

Bash 与 PowerShell 的路径可以同时保存；切换时只修改 `shellMode`：

```yaml
- id: dsh-default-overrides
  config:
    shellMode: persistent-pwsh
    bashPath: 'C:/Program Files/Git/bin/bash.exe'
    pwshPath: 'C:/Program Files/PowerShell/7/pwsh.exe'
```

只使用当前模式对应的路径。未使用的路径可以预先填写。

**路径可以省略，但显式填写更容易固定所用版本：**

- Windows Bash：优先使用 `bashPath`；省略时选择启动 DSH 的进程 PATH 中首个 `bash.exe`。找不到或不兼容会报错，需要修正路径；不会继续猜测安装位置或改用 PowerShell。
- macOS / Linux Bash：持久化模式省略路径时使用 `/bin/bash`；一次性模式省略路径且未开启路径改写时沿用 DSH 原有 Shell 配置。
- PowerShell：省略 `pwshPath` 时由 DSH 自动查找。

## 常用配置

### 设置助手人设

下面的配置将同一人设应用于 `standard`、`ptc` 和 `cordis`：

```yaml
- id: dsh-default-overrides
  config:
    personaPresets:
      - standard
      - ptc
      - cordis
    persona:
      prefix: |
        你是一名软件工程师。先核对项目现状，再做必要的修改。
        使用中文回答，明确说明验证结果和未验证的部分。
```

省略 `personaPresets` 时只修改 `standard`；写 `[]` 可停用人设覆盖而保留正文。名单只控制人设，不会把 Shell 设置或工具禁用扩展到其他预设。

`persona` 可用字段：

| 字段 | 默认行为 | 用途 |
|---|---|---|
| `prefix` | 保留原值 | 助手身份与工作方式说明 |
| `suffix` | 保留原值 | 人设后缀；DSH 通常在这里提供工作目录 |
| `complete` | `false` | `true` 时将 `prefix` 作为整个系统提示词，省略其他提示段 |
| `includeRuntimeContext` | `true` | 是否提供该助手的运行时上下文 |

一般只需要设置 `prefix`。文本中的 `{{...}}` 会被当作 DSH 变量，变量不存在时会报错。`minimal` 原本采用精简提示词；将它加入名单前，应明确设置想保留的 `complete` 和 `includeRuntimeContext` 行为。自建预设的配置要求见 [迁移与高级配置](dsh-default-overrides-migration.md#自建预设与已有配置)。

### 禁用指定工具

```yaml
- id: dsh-default-overrides
  config:
    disabledTools:
      - tool-web
      - tool-workflow
```

只影响 `standard` 预设。这里填写的是预设中的配置 ID，不是界面显示名称；常见 ID 还有 `tool-ralph`、`skill-filesystem`，实际可用项随 DSH 版本而定。ID 不存在时会明确报错；写 `[]` 或省略该项即可保留全部工具。

### 调整身份提示和环境说明

```yaml
- id: dsh-default-overrides
  config:
    includeHarnessIdentity: false
    envContext: true
```

`includeHarnessIdentity: false` 隐藏 DSH 提供的框架身份提示句，影响整个 profile；不会更换所用模型或 API。

`envContext: true` 向模型补充平台和工作区信息。只有本插件实际配置过 Shell 的预设，才附带对应 Shell 说明。设为 `false` 会关闭这段环境说明，Shell 工具自身的操作提示仍然保留。

## 配置速查

| 选项 | 默认值 | 说明 |
|---|---|---|
| `shellMode` | 未设置 | 不设置时保留 DSH 原有 Shell；四种取值见上表 |
| `bashPath` | 未设置 | Bash 可执行文件的绝对路径，仅 Bash 模式使用 |
| `pwshPath` | 未设置 | PowerShell 可执行文件的绝对路径，仅 PowerShell 模式使用 |
| `timeoutMs` | `300000` | 插件配置的 Shell 通道使用的超时设置，单位毫秒，必须是正整数 |
| `disabledTools` | `[]` | 禁用 `standard` 中指定的配置 ID |
| `persona` | 未设置 | 不设置时保留原有人设 |
| `personaPresets` | `['standard']` | 接受人设覆盖的预设名单；仅在配置 `persona` 时生效 |
| `includeHarnessIdentity` | 未设置 | 保留 DSH 当前设置；`false` 隐藏框架身份提示句 |
| `envContext` | 选择 Shell 时开启，否则关闭 | 可显式开启或关闭环境说明 |
| `normalizeWindowsPaths` | `false` | 可选的 Bash 路径改写辅助，见下文 |

只有适用的配置参与校验。例如 PowerShell 模式会忽略 `normalizeWindowsPaths`；没有由插件配置 Shell 时，`timeoutMs` 不参与执行。一次性命令等待超时可能转入后台，并不等于进程已终止，请以工具返回结果为准。

## Windows Bash 的路径与检查

Git Bash 和独立 MSYS2 Bash 属于当前接入的 MSYS 家族。**DSH 在 Windows 上运行时，本插件的 Bash 后端不接受 Cygwin 或 WSL / Linux 入口。** 这项限制不改变 DSH 在 Linux 环境中运行时的 Bash 行为。

首次使用时会检查所选 Bash 的环境和 Windows 路径转换能力，检查上限为 30 秒。失败信息会指出所用入口和出错阶段，可据此修正 `bashPath` 或 Bash 的初始化配置。

日常使用优先采用相对路径；需要 Windows 绝对路径时，可写成 `'C:/Users/me/project'`，含空格的路径要正确引用。Git Bash 可能转换传给原生 Windows 程序的路径参数；容器和远端路径需要按用途处理。

`normalizeWindowsPaths: true` 可辅助把简单路径参数中的 `C:\a\b` 改成 `C:/a/b`，但它不是使用 Git Bash 的前提，建议先保持默认关闭。复杂命令、正则、程序代码和格式串应使用正确的引用；网络共享路径（如 `\\server\share`）不在此辅助功能的处理范围内。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 修改配置后没有变化 | 确认修改的是正在使用的 profile，完整重启 DSH 并新建会话；Shell 配置还要求使用 `standard` 预设 |
| 升级到 0.5.0 后配置全部失效 | 配置行 ID 已改为 `dsh-default-overrides`，见[迁移说明](dsh-default-overrides-migration.md)；沿用旧 ID 的行只会收到警告并被跳过 |
| Windows 提示 Bash 不兼容或找不到入口 | 显式填写 Git Bash / MSYS2 的实际路径，检查报错中的入口是否选到了 WSL 启动器或其他 Bash |
| Windows 路径检查失败 | 检查所选 Bash 能否找到 `cygpath`，以及初始化配置是否改变了 PATH；保留完整的错误阶段信息 |
| 环境检查超时 | 检查 Bash 启动配置中是否有耗时操作或等待输入的命令 |
| 连续调用没有保留目录或变量 | 改用 `persistent-bash` / `persistent-pwsh`，并确认终端没有退出或被重置 |
| 人设没有生效 | 检查当前预设是否在 `personaPresets` 中；自建预设还需完成高级配置中的等待依赖设置 |
| 禁用工具时报 ID 不存在 | 按当前 DSH 版本核对配置 ID，或先删除该项恢复启动 |

反馈问题时，请提供 DSH / Node 版本、操作系统、所选模式及错误文本。

## 更新与卸载

更新到指定版本后，完整重启 DSH 并新建会话：

```sh
dsh plugin --profile web add dsh-default-overrides@版本号
```

卸载：

```sh
dsh plugin --profile web remove dsh-default-overrides
```

然后删除 profile 中针对 `dsh-default-overrides` 的配置，再完整重启 DSH。需要暂时停用时，在插件管理器中停用整个插件包。不要仅禁用主条目；旧文件部署还需清理手工添加的等待依赖。

旧版本升级、文件部署和回退步骤见 [迁移说明](dsh-default-overrides-migration.md)。

## 许可证

[MIT License](LICENSE)。
