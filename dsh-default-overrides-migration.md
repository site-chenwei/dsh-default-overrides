# 部署与旧版本迁移

当前使用方式、配置项和验证命令见 [README](README.md)。本页说明旧版插件的升级接线及回退，运行时决定见 [修复记录](.agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md)。

## 从 0.1.0 升级到 0.2.0

0.1.0 无条件禁用 `tool-web` 与 `tool-workflow`；0.2.0 改为配置项，不配置就保持官方预设原样。要保留原行为，在 profile 补丁的 `config` 中补上：

```yaml
    disabledTools:
      - tool-web
      - tool-workflow
```

`disabledTools` 取值为 `standard` 预设的行 ID。原本被禁用但现在不想保留的行直接从此列表删除即可；ID 写错会在启动时直接报错，不会静默失效。详细取舍见[可配置禁用清单决定](.agents/notes/implemented/feature/2026-09-24-configurable-disabled-tools.md)。

## 从文件部署迁移到 bundle

1. 备份现用 profile 补丁，保存旧入口的 `config`。从补丁中删除插入 `local-dsh-default-overrides` 的旧 `insert` 行；若旧命名仍在使用，也要移除对应活动入口。
2. 按 [README 的安装步骤](README.md#安装)安装 GitHub/npm bundle。bundle 使用相同的 `local-dsh-default-overrides` ID，负责插入入口和 ready 接线。
3. 将保存的配置改成[配置覆盖示例](examples/cordis.patch.yml)的形式：只有 `id` 和 `config`，去掉旧 `name: file://...`。`config` 整体替换，保留全部仍需使用的字段。
4. 如果旧 profile 的 `preset-standard.inject` 只有 `dshDefaultOverridesReady`，可以删除这条用户层补丁，交给 bundle；若还有其他依赖，则保留完整依赖列表。ready 必须保留在最终合成结果中。
5. 完整重启 DSH，新建 `standard` 会话。稳定后再移除不再使用的旧插件副本。

不要同时启用文件入口与 bundle。停用或卸载时以整个 bundle 为单位，并清理对应用户层配置及手工 ready 依赖；仅禁用主插件行会让标准预设等不到 ready。回退到文件部署时，先停用 bundle，再恢复备份的两文件和用户补丁。

## 保留文件部署

同时部署 [主插件](scripts/dsh-default-overrides.mjs) 和 [Git Bash 适配器](scripts/gitbash-executor.mjs)，保持同目录。可以直接引用本仓库 `scripts/` 中的文件，也可以将两者复制到 DSH 的本地插件目录。一次性 `bash` 模式会按主插件位置加载适配器。

如果宿主配置此前直接引用仓库根目录的入口，将文件 URL 改为 `.../scripts/dsh-default-overrides.mjs`；复制到独立插件目录的部署仍只需保证两个插件文件同目录。

备份实际使用的插件文件和 profile 配置。若旧文件已合并其他定制，在原文件上合并差异，不用基础版本整份覆盖。运行中的 DSH 可能监视配置修改，因此完成修改后仍需完整重启；若模型正在被修改的 DSH 中工作，先保存修改与重启交接信息，再从独立终端重启。

将[文件部署示例](examples/file.cordis.patch.yml)合并到宿主 profile：

- 只保留一个 `local-dsh-default-overrides` 活动入口；已有该条目时修改原条目。
- `preset-standard.inject` 必须包含 `dshDefaultOverridesReady`，并保留它已有的其他依赖。
- 不要把 ready 依赖加在 `agent-preset-registry` 上；仅改变 YAML 行顺序不能保证异步钩子已注册。
- 两条路径可同时保留，选择哪个模式就使用对应路径。当前路径无效直接报错，不跨家族回退。

完整重启后新建 `standard` 会话验收。热加载可触发预设重新注册，但旧会话可能保留旧预设版本和已有 Shell 状态。

## 配置迁移

| 旧项 | 处理方式 |
|---|---|
| `standard-persistent-git-bash` 模块/条目名称 | 统一为 `dsh-default-overrides`；宿主条目为 `local-dsh-default-overrides` |
| `standardPersistentGitBashReady` | 发布方和 `preset-standard.inject` 一起改为 `dshDefaultOverridesReady` |
| 公共 `shellPath` | Bash 家族改为 `bashPath`，Pwsh 家族改为 `pwshPath`，显式配置 `shellMode`；旧键会报告迁移错误 |
| 两路径互斥 | 现在允许并存，仅使用和验证当前家族的路径 |
| 只部署主插件 | 补齐同目录的 [Git Bash 适配器](scripts/gitbash-executor.mjs) |
| `blockNestedShells: true` | 删除此配置；本版本明确拒绝旧启用项，`false` 可作为无操作的旧配置保留 |
| 全局 PATH shim | 本版本不再创建或注入；完整重启旧 DSH，清除旧进程内存中的 PATH 前缀 |

旧目录 `DSH_HOME/plugins/.dsh-shell-shims` 不会被新插件自动删除；静置在磁盘上本身不会修改 PATH。如果曾手动把它加入系统 PATH，需要撤回对应配置。不要从仍继承旧 shim PATH 的子终端重新启动 DSH。

模型规则要求直接使用所选 Shell 的语法和原生程序，避免以另一 Shell 包装或重试命令。这是操作规则，不是对任意脚本或绝对路径的强制拦截。

本仓库不包含旧版 marker 后端或安装包补丁。当前组合复用宿主的官方后端；已有相关定制应按目标 DSH 的实际版本单独判断，不能把它们的私有 ready 与本插件的宿主 ready 混用。

## 验收

先运行 `npm run check`，再按 [README 的验证命令](README.md#验证) 执行 [针对性脚本](scripts/verify-dsh-default-overrides.mjs)。这些命令不安装新依赖、不修改宿主 profile；测试使用临时 home/workspace 和已安装 DSH 的组件。

目标机重启后，从 DSH 的实际模型工具入口核对：

1. `standard` 只出现当前模式对应的 `bash` 或 `pwsh`；一次性模式必填 `command`/`description`，持久化模式仅 `command`。
2. 分两次调用设置和读取变量、目录：持久模式保留，一次性模式重置。
3. 非零命令后再执行成功命令，退出状态正确恢复。
4. 一次性 Bash 的后台启动失败能显示错误原因，不被当作零退出。
5. `minimal` 和其他预设维持自身组合，原有其他定制仍然生效。

外部终端直接运行命令不能代替 DSH 工具验收。未提供真实 PowerShell 路径时，脚本会明确跳过 PowerShell 实跑，不把启动参数记录当作 Windows ConPTY 通过。

## 回退

同步恢复备份的主插件、适配器与宿主配置，然后完整重启。涉及旧命名时，文件 URL、条目 ID、ready 发布方与等待方一起恢复。如果升级后又有其他修改，按差异撤回本批内容；保留当前 DSH 版本必需的接口适配，不混装已删除的旧包接口。
