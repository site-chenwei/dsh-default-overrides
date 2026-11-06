# DSH Default Overrides

为 DeepSeek Harness（DSH）调整系统提示词、助手人设和工具开关。插件只改 DSH 的公开配置项，不接管 Shell，也不修改 DSH 安装文件。

**安装后默认不改变现有行为。** 按需添加配置即可。

## 使用前

- 已安装并能正常启动 DSH；建议使用自带的 `web` profile。
- 目标 profile 包含官方 `standard` 预设；`disabledTools` 只作用于这个预设。
- 安装所需的 `pnpm` 能从 PATH 中找到。
- 当前验证基线为 macOS、Node.js 26.12.0、DSH 0.2.2-rc.1。其他 DSH 版本的兼容性需要实际确认。

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
    personaPresets:
      - standard
    persona:
      prefix: |
        你是一名软件工程师。先核对项目现状，再做必要的修改。
        使用中文回答，明确说明验证结果和未验证的部分。
    disabledTools:
      - tool-web
      - tool-workflow
    autoCompaction: false
```

保存配置、完整重启 DSH，再新建会话确认。**多个示例请合并到同一份 `config` 中。** DSH 会整体替换这份配置，修改时保留仍需使用的字段。完整配置示例见 [配置示例](examples/cordis.patch.yml)。

## 配置项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `includeHarnessIdentity` | 未设置 | 保留 DSH 当前设置；`false` 隐藏框架身份提示句 |
| `surfaceContext` | 未设置 | 保留 DSH 当前设置；`false` 关闭 Web 表层提示段与 `DSH_WEB_URL` |
| `persona` | 未设置 | 不设置时保留原有人设 |
| `personaPresets` | `['standard']` | 接受人设覆盖的预设名单；仅在配置 `persona` 时生效 |
| `disabledTools` | `[]` | 禁用 `standard` 中指定的配置 ID |
| `autoCompaction` | 未设置 | 保留 DSH 当前设置；`false` 关闭原生自动压缩 |

### 身份提示与环境说明

```yaml
- id: dsh-default-overrides
  config:
    includeHarnessIdentity: false
    surfaceContext: false
```

`includeHarnessIdentity: false` 隐藏 DSH 提供的框架身份提示句，影响整个 profile；不会更换所用模型或 API。

`surfaceContext: false` 关闭 Web 表层提示：系统提示词里不再出现 DSH 实现源码 checkout 的路径说明和 Web GUI 的定位说明，shell 命令也不再收到 `DSH_WEB_URL`。它只影响这两段文本和这个变量，不影响 Web 界面本身的启动、URL 打印或浏览器打开；没有 Web 界面的 profile（例如 headless）本来就没有这两段。

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

省略 `personaPresets` 时只修改 `standard`；写 `[]` 可停用人设覆盖而保留正文。

`persona` 可用字段：

| 字段 | 默认行为 | 用途 |
|---|---|---|
| `prefix` | 保留原值 | 助手身份与工作方式说明 |
| `suffix` | 保留原值 | 人设后缀；DSH 通常在这里提供工作目录 |
| `complete` | `false` | `true` 时将 `prefix` 作为整个系统提示词，省略其他提示段 |
| `includeRuntimeContext` | `true` | 是否提供该助手的运行时上下文 |

一般只需要设置 `prefix`。文本中的 `{{...}}` 会被当作 DSH 变量，变量不存在时会报错。`minimal` 原本采用精简提示词；将它加入名单前，应明确设置想保留的 `complete` 和 `includeRuntimeContext` 行为。

### 禁用指定工具

```yaml
- id: dsh-default-overrides
  config:
    disabledTools:
      - tool-web
      - tool-workflow
```

只影响 `standard` 预设。这里填写的是预设中的配置 ID，不是界面显示名称；常见 ID 还有 `tool-ralph`、`skill-filesystem`，实际可用项随 DSH 版本而定。ID 不存在时会明确报错；写 `[]` 或省略该项即可保留全部工具。

### 关闭原生自动压缩

```yaml
- id: dsh-default-overrides
  config:
    autoCompaction: false
```

DSH 默认会在上下文接近上限时自动压缩历史。`autoCompaction: false` 关闭这个自动流程，上下文不再被自动改写，压缩时机完全由你控制。

- 只影响 `standard`、`ptc`、`cordis`、`minimal` 以及任何自带 `compaction-basic` 行的预设；没有这一行的预设原样保留。不需要像人设那样填写名单。
- 手动压缩不受影响：会话里执行 `/compact` 仍然可用，ACP 客户端的压缩行为也不变。
- **风险**：关闭后长会话不会再自动腾出空间，超出上下文上限时会直接报错，需要你自己及时执行 `/compact` 或开新会话。
- 省略该项即保留 DSH 原有行为；写 `true` 与省略等效，用于显式表达意图。

## 从 0.6.x 升级

0.7.0 移除了 Shell 覆盖：`shellMode`、`bashPath`、`pwshPath`、`timeoutMs`、`envContext`、`normalizeWindowsPaths`、`shellPath` 和 `blockNestedShells` 不再生效。插件现在完全交给 DSH 的官方 Shell 通道。

升级后请从配置中删除这些字段。保留它们会得到明确的启动错误，而不是静默换回官方 Shell。其余配置项不变。完整迁移步骤见 [迁移说明](dsh-default-overrides-migration.md)。

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 修改配置后没有变化 | 确认修改的是正在使用的 profile，完整重启 DSH 并新建会话 |
| 升级到 0.7.0 后插件报 Shell 选项已移除 | 删除 `shellMode`、`bashPath`、`pwshPath`、`timeoutMs`、`envContext`、`normalizeWindowsPaths` 等旧字段；Shell 由 DSH 官方通道提供 |
| 人设没有生效 | 检查当前预设是否在 `personaPresets` 中 |
| 系统提示词里仍有 checkout 路径或 GUI 说明 | 用 `surfaceContext: false` 关闭；固定开场白 `You are an AI agent powered by DeepSeek Harness.` 由 `includeHarnessIdentity` 控制 |
| 禁用工具时报 ID 不存在 | 按当前 DSH 版本核对配置 ID，或先删除该项恢复启动 |
| 长会话中途报上下文超限 | 若设置过 `autoCompaction: false`，改回省略该项，或手动执行 `/compact` |

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
