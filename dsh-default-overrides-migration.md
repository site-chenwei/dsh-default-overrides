# 升级、文件部署与回退

首次安装和日常配置见 [README](README.md)。本页适用于升级旧版本、迁移文件部署，或使用自建预设的用户。

## 升级前

备份正在使用的 profile 配置。文件部署还要备份同一版本的完整插件文件；曾自行修改源码时，合并变更时保留自己的修改。

更新后完整重启 DSH，并新建会话确认设置。旧会话可能保留原来的配置。

## 升级到 0.7.0

0.7.0 移除了 Shell 覆盖，改为只保留系统提示词、人设和工具开关。以下字段不再生效：

| 旧字段 | 处理方式 |
|---|---|
| `shellMode` | 删除；Shell 由 DSH 官方通道提供 |
| `bashPath` / `pwshPath` | 删除；如仍需指定 Shell，请使用 DSH 自身的 Shell 配置 |
| `timeoutMs` | 删除；使用官方工具的默认超时 |
| `envContext` | 删除；插件不再注入环境事实段 |
| `normalizeWindowsPaths` | 删除；插件不再改写命令路径 |
| `shellPath` / `blockNestedShells` | 删除；旧兼容选项已移除 |

保留这些字段会得到明确的启动错误，而不是静默改变行为。删除后，其余配置项（`includeHarnessIdentity`、`surfaceContext`、`persona`、`personaPresets`、`disabledTools`、`autoCompaction`）保持原语义。

同时，0.7.0 不再随包提供 Bash / PowerShell 适配器和验证脚本，npm 包只包含单个运行入口 `scripts/dsh-default-overrides.mjs`。

## 升级到 0.5.0

宿主配置行的 ID 从 `local-dsh-default-overrides` 改成与包名一致的 `dsh-default-overrides`。升级后必须同步改 profile 里的这一行：

```yaml
- id: dsh-default-overrides
  config:
    includeHarnessIdentity: false
```

不改名的后果不是启动报错：补丁匹配不到任何行时，DSH 只发出警告并跳过，插件以空配置激活。**升级后如果发现“包装上了但什么都不生效”，先检查这一行是不是还在用旧 ID。**

**升级时写清版本号。** 安装走 pnpm，而 pnpm 从 11 起默认开启发布冷却期（`minimumReleaseAge`，1440 分钟）：版本发布后 24 小时内不参与解析。所以刚发布时用不带版本号的命令，装回来的其实是更早的版本。用固定版本安装，并确认实际装的版本：

```sh
dsh plugin --profile <profile> add dsh-default-overrides@0.7.0
cat ~/.dsh/profiles/<profile>/node_modules/dsh-default-overrides/package.json | grep '"version"'
```

同一个 profile 只保留一个 `dsh-default-overrides` 条目，改名后删掉旧的那行。

## 文件部署

0.7.0 的文件部署只需要主入口和一个补丁文件：

- [主插件](scripts/dsh-default-overrides.mjs)
- [补丁文件](cordis.patch.yml)

按照 [文件部署示例](examples/file.cordis.patch.yml)修改实际入口 URL，然后合并到 profile 配置。直接引用本仓库时，入口在 `scripts/` 目录。

示例同时配置了内置预设、全局系统提示词和 Web 运行行的 `dshDefaultOverridesReady` 等待项。保留这些条目及已有的其他 `inject` 依赖（`web-runtime` 行还必须保留 `webStartup`），不要把等待项加到 `agent-preset-registry` 上。

完整重启后新建会话检查。文件 URL 和主入口应始终属于同一版本。

## 自建预设与已有配置

`disabledTools` 仍只影响 `standard`。将自建预设加入 `personaPresets`，只会让它接收人设配置。

`autoCompaction` 是例外：它作用于任何自带 `compaction-basic` 行的预设，不需要名单，也不需要自建预设做额外配置。自建预设若删掉了该行，插件会原样放行。

名单填写预设标识（预设配置中的 `id`）；对应预设条目的 `inject` 还需要包含 `dshDefaultOverridesReady`。例如条目 ID 为 `preset-my-assistant` 时：

```yaml
- id: preset-my-assistant
  inject:
    # 在这里同时保留原有的其他依赖
    - dshDefaultOverridesReady
```

该示例只展示需要加入的等待项，请与原列表合并。内置的 `standard`、`ptc`、`cordis`、`minimal` 已由插件包配置好。

如果用户配置覆盖了内置预设、全局 `system-prompt` 或 `web-runtime` 行的 `inject`，也要保留该等待项；`web-runtime` 行原有的 `webStartup` 同样必须保留，它承载 launcher 的 host、port、浏览器与可信主机参数。

## 停用与回退

插件包以整体为单位停用或卸载，并删除对应的用户配置。仅禁用主插件条目、同时留下等待依赖，可能使 DSH 无法完成启动。

回退时重新安装原版本或备份包，恢复对应配置，再完整重启 DSH。升级后已有其他修改时，按差异撤回本次内容，避免覆盖后续配置。
