# 升级、文件部署与回退

首次安装和日常配置见 [README](README.md)。本页适用于升级旧版本、迁移文件部署，或使用自建预设的用户。

## 升级前

备份正在使用的 profile 配置。文件部署还要备份同一版本的完整插件文件；曾自行修改源码时，合并变更时保留自己的修改。

更新后完整重启 DSH，并新建会话确认设置。旧会话可能保留原来的配置和终端状态。

## 升级到 0.4.0

Windows 的 `bash` 和 `persistent-bash` 现在都使用以下规则：

1. 配置了 `bashPath`，就使用这个入口。
2. 未配置时，选择启动 DSH 的进程 PATH 中首个 `bash.exe`。
3. 检查环境与路径转换能力；失败时报告实际入口和失败阶段，需要修正配置后再使用。

如果希望使用 Git Bash，建议明确填写实际路径：

```yaml
- id: local-dsh-default-overrides
  config:
    shellMode: persistent-bash
    bashPath: 'C:/Program Files/Git/bin/bash.exe'
```

旧版在 Windows 上的一次性 Bash 无路径配置可能沿用 PowerShell；这种回退已取消。需要 PowerShell 时，显式选择 `pwsh` 或 `persistent-pwsh`。

Windows 后端当前接受 Git Bash / MSYS2 所属的 MSYS 家族，不接受 Cygwin 或 WSL / Linux 启动入口。非 Windows 的执行规则保持原样。`normalizeWindowsPaths` 仍默认关闭，升级无需开启它。当前实机验证范围见 [使用前说明](README.md#使用前)。

通过插件包安装时，更新包即可。使用文件部署时，需要补齐下文列出的五个运行模块，不能只替换旧入口。

## 从 0.1.0 升级

0.1.0 会无条件禁用 `tool-web` 和 `tool-workflow`；从 0.2.0 起默认保留全部工具。需要继续禁用它们时，将以下内容并入现有 `config`：

```yaml
disabledTools:
  - tool-web
  - tool-workflow
```

人设和框架身份提示都是可选项，按需配置，未填写时保留 DSH 当前设置。选项说明见 [配置速查](README.md#配置速查)。

## 从文件部署迁移到插件包

1. 备份旧配置，保存 `local-dsh-default-overrides` 中全部仍需要的 `config` 字段。
2. 删除旧的 `insert` 文件入口及旧命名的重复入口。
3. 按 [安装步骤](README.md#安装)安装插件包。
4. 将原配置改为 [配置示例](examples/cordis.patch.yml)的形式：保留 `id` 和 `config`，去掉旧的 `name: file://...` 与 `insert`。
5. 包已经提供内置预设及系统提示词的等待依赖。原先仅用于添加 `dshDefaultOverridesReady` 的对应用户补丁可删除；若还有其他依赖，保留完整列表和该等待项。
6. 完整重启 DSH，新建会话检查。确认可用后，再移除不再使用的旧文件副本。

同一个 profile 只保留一个活动入口。文件部署与插件包不能同时启用。

## 保留文件部署

将以下五个模块放在同一个目录，即使关闭路径改写或不使用 Windows，也要完整保留：

- [主插件](scripts/dsh-default-overrides.mjs)
- [一次性 Bash 适配器](scripts/gitbash-executor.mjs)
- [路径处理模块](scripts/command-paths.mjs)
- [Bash 环境模块](scripts/bash-runtime.mjs)
- [Windows 终端适配器](scripts/windows-bash-terminal.mjs)

按照 [文件部署示例](examples/file.cordis.patch.yml)修改实际入口 URL 和可执行文件路径，然后合并到 profile 配置。直接引用本仓库时，入口在 `scripts/` 目录。

示例同时配置了内置预设和系统提示词的 `dshDefaultOverridesReady` 等待项。保留这些条目及已有的其他 `inject` 依赖，不要把等待项加到 `agent-preset-registry` 上。

完整重启后新建 `standard` 会话检查。文件 URL、五个模块文件和配置应始终属于同一版本。

## 自建预设与已有配置

Shell 选择和工具禁用仍只影响 `standard`。将自建预设加入 `personaPresets`，只会让它接收人设配置。

名单填写预设标识（预设配置中的 `id`）；对应预设条目的 `inject` 还需要包含 `dshDefaultOverridesReady`。例如条目 ID 为 `preset-my-assistant` 时：

```yaml
- id: preset-my-assistant
  inject:
    # 在这里同时保留原有的其他依赖
    - dshDefaultOverridesReady
```

该示例只展示需要加入的等待项，请与原列表合并。内置的 `standard`、`ptc`、`cordis`、`minimal` 已由插件包配置好。

如果用户配置覆盖了内置预设或全局 `system-prompt` 的 `inject`，也要保留该等待项。自定义 profile 中，本插件包应位于提供 `standard` 预设的包之后；使用内置 `web` profile 时，正常安装会自动追加。

## 旧配置对照

| 旧配置或部署方式 | 处理方式 |
|---|---|
| `standard-persistent-git-bash` 旧入口 | 按当前示例改用 `local-dsh-default-overrides`，只保留一个活动入口 |
| `standardPersistentGitBashReady` | 在旧配置中统一改为 `dshDefaultOverridesReady` |
| `shellPath` | 根据所选模式改为 `bashPath` 或 `pwshPath`，并明确设置 `shellMode` |
| Bash 与 PowerShell 路径只能二选一 | 现在可同时保留，切换 `shellMode` 即可 |
| 只复制一至三个旧模块 | 按文件部署步骤补齐五个运行模块 |
| `blockNestedShells: true` | 删除该配置；当前版本会拒绝旧启用项，`false` 也可直接删除 |
| 曾使用全局 PATH 垫片 | 如曾手动把旧目录加入系统 PATH，请移除该项，并从新终端重新启动 DSH |

旧的 `DSH_HOME/plugins/.dsh-shell-shims` 目录不会被插件自动删除；文件留在磁盘上不会自行修改 PATH。插件的 Shell 选择和模型提示不替代 DSH 的执行权限控制。

## 更新后检查

在 DSH 的新会话中检查实际工具行为：

1. `standard` 使用预期的 Bash 或 PowerShell。
2. 分两次调用设置并读取目录或变量：持久化模式保留，一次性模式重置。
3. 配置的人设应用到名单中的预设，未选中的预设保持原样。
4. 工具禁用、框架身份提示与其他原有配置符合预期。

出现问题时，先记录 DSH / Node 版本、操作系统、模式和完整错误，再按 [常见问题](README.md#常见问题)排查。

## 停用与回退

插件包以整体为单位停用或卸载，并删除对应的用户配置。仅禁用主插件条目、同时留下等待依赖，可能使 DSH 无法完成启动；旧文件部署手工加入的等待项也需要清理，并保留其他依赖。

回退时重新安装原版本或备份包，恢复对应配置，再完整重启 DSH。文件部署恢复同一版本的全部模块和配置。升级后已有其他修改时，按差异撤回本次内容，避免覆盖后续配置。
