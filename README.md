# DSH Default Overrides

为 DeepSeek Harness（DSH）调整系统提示词和工具开关。插件只改 DSH 的公开配置项，不接管 Shell，也不修改 DSH 安装文件。

**安装后默认不改变现有行为。** 按需添加配置即可。

## 使用前

- 已安装并能正常启动 DSH；建议使用自带的 `web` profile。
- 目标 profile 包含官方 `standard` 预设；`disabledTools` 只作用于这个预设。
- 安装所需的 `pnpm` 能从 PATH 中找到。
- 当前验证基线为 macOS、Node.js 26.13.1、DSH 0.2.3-alpha.2。其他 DSH 版本的兼容性需要实际确认。

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

```yaml
- id: dsh-default-overrides
  config:
    includeHarnessIdentity: false
    surfaceContext: false
    disabledTools:
      - tool-web
      - tool-workflow
```

保存配置、完整重启 DSH，再新建会话确认。**多个示例请合并到同一份 `config` 中。** DSH 会整体替换这份配置，修改时保留仍需使用的字段。完整配置示例见 [配置示例](examples/cordis.patch.yml)。

## 配置项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `includeHarnessIdentity` | 未设置 | 保留 DSH 当前设置；`false` 隐藏框架身份提示句 |
| `surfaceContext` | 未设置 | 保留 DSH 当前设置；`false` 关闭 Web 表层提示段与 `DSH_WEB_URL` |
| `disabledTools` | `[]` | 禁用 `standard` 中指定的配置 ID |

### 身份提示与环境说明

```yaml
- id: dsh-default-overrides
  config:
    includeHarnessIdentity: false
    surfaceContext: false
```

`includeHarnessIdentity: false` 隐藏 DSH 提供的框架身份提示句，影响整个 profile；不会更换所用模型或 API。

`surfaceContext: false` 关闭 Web 表层提示：系统提示词里不再出现 DSH 实现源码 checkout 的路径说明和 Web GUI 的定位说明，shell 命令也不再收到 `DSH_WEB_URL`。它只影响这两段文本和这个变量，不影响 Web 界面本身的启动、URL 打印或浏览器打开；没有 Web 界面的 profile（例如 headless）本来就没有这两段。

### 禁用指定工具

```yaml
- id: dsh-default-overrides
  config:
    disabledTools:
      - tool-web
      - tool-workflow
```

只影响 `standard` 预设。这里填写的是预设中的配置 ID，不是界面显示名称；常见 ID 还有 `tool-ralph`、`skill-filesystem`，实际可用项随 DSH 版本而定。ID 不存在时会明确报错；写 `[]` 或省略该项即可保留全部工具。

## 从 0.9.x 升级到 0.10.0

0.10.0 移除了 `reverseProxyMode`、`persona` 和 `personaPresets`：插件不再套用反向代理场景默认值，也不再覆盖助手人设。配置中保留这些字段会得到明确的启动错误，请删除它们；系统提示词和工具开关的其余配置不变。

## 从 0.8.x 升级

0.9.0 移除了 `autoCompaction` 配置项：插件不再修改 DSH 的自动压缩行为。配置中保留该字段会得到明确的启动错误，请删除它；自动压缩继续由 DSH 自身控制。

## 从 0.6.x 升级

0.7.0 移除了 Shell 覆盖：`shellMode`、`bashPath`、`pwshPath`、`timeoutMs`、`envContext`、`normalizeWindowsPaths`、`shellPath` 和 `blockNestedShells` 不再生效。插件现在完全交给 DSH 的官方 Shell 通道。

升级后请从配置中删除这些字段。保留它们会得到明确的启动错误，而不是静默换回官方 Shell。其余配置项不变。完整迁移步骤见 [迁移说明](dsh-default-overrides-migration.md)。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 修改配置后没有变化 | 确认修改的是正在使用的 profile，完整重启 DSH 并新建会话 |
| 升级到 0.7.0 后插件报 Shell 选项已移除 | 删除 `shellMode`、`bashPath`、`pwshPath`、`timeoutMs`、`envContext`、`normalizeWindowsPaths` 等旧字段；Shell 由 DSH 官方通道提供 |
| 同时安装 billion-context 等会写 preset inject 的插件后禁用工具仍不生效 | DSH 的 bundle patch 会整体替换 preset 行上的 `inject`，后安装的 bundle 可能覆盖 `dshDefaultOverridesReady`；0.9.1 起运行时会自动重刷未拿到该信号的 `preset-standard`。若仍不生效，在 profile 的 `cordis.patch.yml` 末尾按 `examples/cordis.patch.yml` 给 `preset-standard` 行追加 `inject: [biliBasicCompactionPolicy, dshDefaultOverridesReady]`（保留对方原有依赖） |
| 系统提示词里仍有 checkout 路径或 GUI 说明 | 用 `surfaceContext: false` 关闭；0.9.2 起还会在 `systemPrompt.assemble` 层过滤，即使 profile HMR 重新启用 `harness-dev-context` 也不会输出这两段。固定开场白 `You are an AI agent, powered by DeepSeek Harness.` 由 `includeHarnessIdentity` 控制 |
| 禁用工具时报 ID 不存在 | 按当前 DSH 版本核对配置 ID，或先删除该项恢复启动 |

## 更新与卸载

更新到指定版本后，完整重启 DSH 并新建会话：

```sh
dsh plugin --profile web add dsh-default-overrides@版本号
```

版本号不只是为了固定：安装走 pnpm，pnpm 从 11 起默认有 24 小时的发布冷却期（`minimumReleaseAge`），刚发布的版本不带版本号时解析不到，会装回更早的版本。

卸载：

```sh
dsh plugin --profile web remove dsh-default-overrides
```

然后删除 profile 中针对 `dsh-default-overrides` 的配置，再完整重启 DSH。需要暂时停用时，在插件管理器中停用整个插件包。

## 许可证

[MIT License](LICENSE)。
