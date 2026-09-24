# Agent Note: 将默认覆盖插件作为 DSH bundle 分发

Status: implemented

## Problem

原有插件仅支持文件路径接入，使用者需要手工插入插件并为标准预设添加 ready 依赖。包清单禁止 npm 发布，没有 DSH bundle 声明，不能满足用户要求的 GitHub/npm 分发。

## Decision

[包清单](../../../../package.json)把现有主插件作为包根导出，并声明 `dsh.bundle.patch`。[bundle 补丁](../../../../cordis.patch.yml)使用包名插入 `local-dsh-default-overrides`，为 `preset-standard` 添加 `dshDefaultOverridesReady`。保留旧行 ID，使迁移只改变部署方式；不修改四模式运行逻辑或相邻执行器的 URL 解析。

GitHub 标签与 npm 使用相同的已提交 `.mjs` 源码，无编译、prepare 或 postinstall。发布白名单包含完整运行/验证脚本、补丁、示例及文档；设计笔记也随包分发，保持文档和入口注释的相对链接有效。`prepack` 仅运行无依赖的语法检查。

DSH 的实际 bundle 契约与 CLI 安装行为依据本机 `0.1.7-rc.1` 的 `dsh-app-boot`、`dsh-plugin-manager` 和 Loader 实现。DSH 根据 `peerDependencies` 检查宿主版本，因此声明精确 `0.1.7-rc.1`；optional 标记避免安装第二套宿主，官方模块仍通过 `ctx.loader.import` 复用。Node 最低声明采用已验证的 `24.15.0` 基线，不声称这是源码语法的最低要求；扩大版本范围前重跑验证。

默认配置为空，保留现有“禁用 web/workflow、保留官方 Shell 选择”的行为。机器路径只放在用户 profile 补丁。bundle 必须位于提供 `preset-standard` 的层之后，文档和验证都使用官方 `web` profile；仅有 base 的新自定义 profile 不满足这一前提。

用户配置通过[覆盖示例](../../../../examples/cordis.patch.yml)修改现有行。停用以整个 bundle 为单位，让主插件与 ready 等待同时退出；后续用户层若覆盖 `preset-standard.inject`，必须自行保留完整依赖列表。文件部署仍由[独立示例](../../../../examples/file.cordis.patch.yml)支持，迁移后只保留一个活动入口。

## Alternatives considered

- **不做/复用文件部署。** 已经验证且零依赖，但无法满足标准包分发，仍需每位使用者手工接线。
- **只移除 private。** 可以发布源码，改动最少；但没有 bundle 声明，DSH 不会自动选择插件或加载 ready 接线。
- **增加构建和安装器。** 可输出单文件并自动写入配置；当前源码可直接运行，DSH 已有补丁合成，额外生命周期脚本增加构建审批和配置副作用。
- **直接启动完整 DSH 做验收。** 最接近完整产品行为，但默认宿主还可能迁移旧设置和加载无关插件。本次用真实安装器、profile 合成和 Loader 验证分发契约，再复用现有运行脚本，所有临时状态放入独立 home。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、npm 12.0.2、pnpm 11.9.0、DSH 0.1.7-rc.1 下通过。

[分发验证脚本](../../../../scripts/verify-package.mjs)运行语法检查、生成真实 tarball、用 DSH CLI 在临时 `DSH_HOME` 中离线安装。安装只新增本插件一个包，自动选择 bundle，真实 profile 合成没有缺失行告警，用户层成功覆盖配置。真实 Loader 从包名导入插件、等待 ready 后注册 standard，并成功导入安装产物中的相邻适配器。

脚本随后从安装产物运行[原有针对性验证](../../../../scripts/verify-dsh-default-overrides.mjs)：四模式路径、工具参数与提示、预设隔离和重载通过；Bash 一次性真进程、后台输出/失败/转后台、超时/取消，以及持久化 PTY 状态和退出恢复通过。Pwsh 只检查注册、提示与实际 spawn 参数，未实跑。临时 home 在 finally 清理，不修改现用 profile 或安装包。

验证脚本适配 npm 12 按包名索引的 pack JSON，也接受之前的数组格式。首次使用自定义空 profile 暴露缺失 `preset-standard` 的真实前提，因此正式验证使用文档所述的 `web` profile。

## Consequences

同一仓库可从 GitHub 标签和 npm 安装，无需手工复制两个文件或手工接入 ready。保留简单源码布局和宿主依赖，不新增运行依赖及发布自动化。

代价是安装与配置分层：用户需要配置本机 Shell 路径，并按 bundle 粒度启停；精确 peer 声明要求宿主升级时复验。仓库没有远端，GitHub 命令保留明确的所有者占位符，npm 包名所有权和真实远端下载留到发布阶段；本次不推送或公开发布。

本机 DSH 安装含既有 Bash marker 修复，本仓库不附带该补丁。Windows Git Bash/ConPTY、PowerShell 真进程、完整 GUI/模型会话、未修改宿主及其他 DSH/Node 版本不在本次验证结论内。

## Related notes audit

[独立仓库决定](2026-09-24-standalone-plugin-repository.md)部分重叠：独立历史、源码布局和迁入理由继续保留，本记录接管不提供 npm 分发的旧范围约束，双方互链。[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：ready 和执行契约复用，新增 bundle 接管安装接线，双方互链。没有其他活跃提案需要拒绝或归档。
