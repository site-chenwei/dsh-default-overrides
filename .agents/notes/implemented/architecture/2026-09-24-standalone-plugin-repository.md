# Agent Note: 将 DSH 默认覆盖插件独立成仓库

Status: implemented

## Problem

插件原先放在个人站点项目中，运行源码、验证脚本和部署资料混在其他交付旁边。用户要求建立专门仓库，后续自行开源到 GitHub；直接发布原项目会带入无关文件和历史。

## Decision

本仓库采用独立 Git 历史，源码迁入基线为来源项目提交 `bb56fb6`。[主插件](../../../../scripts/dsh-default-overrides.mjs)、[Git Bash 适配器](../../../../scripts/gitbash-executor.mjs)和[针对性验证脚本](../../../../scripts/verify-dsh-default-overrides.mjs)统一放在 `scripts/`，保持文件名、运行逻辑和同目录相对导入。npm 命令仍从仓库根目录调用，宿主示例直接引用 `scripts/` 下的入口。原项目保留已有文件，后续维护以本仓库为准，不做双向同步。

[README](../../../../README.md)、[宿主示例](../../../../examples/cordis.patch.yml)与[迁移说明](../../../../dsh-default-overrides-migration.md)提供独立部署入口。文档使用通用示例路径，不依赖原工作区绝对路径或其他项目文档。只迁入本插件所需交付，不附带原项目的站点、个人资料、宿主配置或安装包补丁。

仓库默认采用 [MIT 许可证](../../../../LICENSE)。独立迁入阶段的 [package.json](../../../../package.json)仅提供无依赖的语法检查与验证命令，使用 private 字段避免误发 npm。用户新增分发要求后，[bundle 分发决定](2026-09-24-distributable-dsh-bundle.md)接管包清单与安装接线；独立历史、源码布局和不自动设置远端的决定继续成立。

当前[运行契约修复笔记](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)迁入并保留问题、决定、备选方案与验证边界，仅调整出处及仓内链接。原项目其他历史笔记不整批导入。

## Alternatives considered

- **不做/继续在原项目维护。** 零迁移成本，已有提交可追溯；但不能满足用户要求的独立维护与公开发布边界。
- **导入原项目全部 Git 历史。** 保留每次旧修改，但也带入个人站点和无关交付；当前插件规模小，以来源提交和修复记录保留依据即可。
- **同时打包为 npm 插件并加入 CI。** 可提前准备发布自动化，但尚无 npm 发布要求和确定的 Windows 验证环境；保持已验证的相对导入和本地文件部署。脚本统一存放在 `scripts/` 不需要新增打包流程。
- **移动并删除原文件。** 避免出现两个副本，但会破坏原项目现有文档和交付引用；保留原快照，在新仓库声明后续维护位置。

## Testing

在本仓库运行 `npm run check` 和 `npm run verify -- <DSH-installation> /bin/bash`，语法与已有真实组件集成验证通过。执行器在新位置通过相对导入加载，真实 Bash 进程、后台处理和持久化 PTY 状态验证通过。未提供 PowerShell 运行路径，Pwsh 只验证注册、提示和准确启动参数。

迁入时三个运行/验证文件的字节内容与来源提交一致。统一到 `scripts/` 后，两个插件正文保持不变，验证脚本仅更新命令用法说明；交付检查覆盖这些内容差异、示例 YAML 与 README 一致性、Markdown 相对链接和笔记格式。仓库不含原工作区绝对路径及无关交付，Git 历史从本地初始提交开始，不推送远端。

## Consequences

插件获得独立维护和公开发布边界，现有执行逻辑不因迁移变化。原项目保留的是迁移时快照，后续修复不自动同步回去。用户可在发布前调整默认许可证和 GitHub 仓库名称，再自行配置远端。

验证仍使用 macOS、Node.js 24.15.0、本机 DSH 0.1.7-rc.1；该安装含既有 Bash marker 修复，不构成对原版或其他版本的完整兼容证明。Windows Git Bash/ConPTY、PowerShell 真进程与完整模型会话保持未验证状态。迁移不修改运行中的 DSH 安装或 profile。

## Related notes audit

来源项目的运行契约修复与本次部分重叠，迁入后互链说明独立维护关系。统一入口与声明式迁移笔记只提供已稳定的命名/ready 背景，当前修复记录和部署文档已覆盖这些契约，不迁入旧部署路径。首次四模式笔记含已被修复取代的理由，保留在来源历史。Codegraph、persona、搜索工具和安装包 marker 修改不属于本仓库；无需要拒绝或归档的提案。
