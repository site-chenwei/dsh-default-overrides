# Agent Note: Shell 路径配置改为可选

Status: implemented

## Problem

`bashPath` 此前是 Bash 两模式的必填项；缺失时 `apply` 直接抛错。真实 profile 只写 `shellMode: persistent-bash`（未写 `bashPath`）时，DSH 启动失败：

```text
dsh: startup failed: 1 required plugin did not activate
  local-dsh-default-overrides
    Error: shellMode 'persistent-bash' requires bashPath (absolute path to Git Bash bash.exe)
```

同时 `persistent-bash` 的 ready 等待让 `system-prompt` 与 `preset-standard` 一起挂起，整个 profile 都起不来。对只想切默认 Shell 的用户来说，这个必填项没有存在理由：官方后端本来就有默认值。

## Decision

`bashPath` 与 `pwshPath` 都改为可选；省略时不再报错，按模式分别回退到官方默认：

- `persistent-bash` / `persistent-pwsh`：继续挂官方 `dsh-terminal-bash`，只是不写 `shellPath`。该后端自带默认值——bash 用 `DEFAULT_BASH_SHELL`（`/bin/bash`），pwsh 用 `resolvePwshPath()` 探测。
- `bash`（一次性）省略 `bashPath` 且未开启 `normalizeWindowsPaths`：插件**不产生任何 Shell 补丁**，官方 `tool-bash` 行与其宿主级沙箱执行器保持原样，等于官方默认行为（Windows 上官方默认给出 pwsh，因为官方 `tool-bash` 行在该平台被禁用）。该回退只涉及 Shell 行与工具说明补充；提示词平面的环境事实段仍照常给出，见[环境事实段与 Shell 补丁解耦](../bug-fix/2026-09-25-environment-facts-in-every-shell-mode.md)。
- `bash` 省略 `bashPath` 但开启 `normalizeWindowsPaths`：仍挂本插件的适配器（改写只在适配器里），适配器在 `shellPath` 未配置时不再猜路径，改为调用官方 `LocalBashExecutor.execute`，即官方默认 argv `["bash", "-c", command]`（`dsh-bash-local/lib/index.js:141`）。
- `pwsh`（一次性）：沿用官方 `dsh-pwsh-local`，未配置路径时由该插件探测。

显式配置的当前家族路径仍按原样校验：不是存在的绝对文件时直接报错，不会静默回退到默认。其他家族路径与无接管时的 timeoutMs 不参与校验，见[配置适用范围与命令安全](2026-09-25-option-applicability-and-command-safety.md)。

## Alternatives considered

- **保持必填，只改进报错文案。** 改动最小；但用户仍要为"切到默认 Shell"抄一个本机路径，Windows 上还得先找到 Git Bash 的安装位置，正是本次暴露的摩擦。
- **省略路径时一律挂本插件适配器，用 `/bin/bash` 兜底。** 行为统一；但会用一个硬编码路径取代官方的平台判断（`DEFAULT_BASH_SHELL`），并在 Windows 上给出必然不存在的 `/bin/bash`。
- **省略路径时一律不产生补丁（含持久化模式）。** 最贴近"官方默认"；但持久化模式本来就是本插件插入的终端组，不产生补丁等于该模式失效，用户选了 `persistent-bash` 却什么都得不到。
- **在插件里自行探测 Git Bash 路径。** 免去用户配置；但 Windows 上 Git Bash 的安装位置没有权威来源，猜测失败时的报错比"未配置"更难解释。官方 `dsh-pwsh-local` 有 `resolvePwshPath()`，bash 侧没有对应函数，也不宜自造。

## Testing

`npm run verify:package -- <DSH-installation> /bin/bash` 在 macOS、Node.js 24.15.0、DSH 0.1.7-rc.1 下通过：

- 注册层：`persistent-bash` 与 `persistent-pwsh` 在未配置路径时 `terminal-shell` 行不含 `shellPath`、`shellDialect` 正确、无 `shellArgs`；`shellMode: 'bash'` 且无路径时注册结果与官方预设逐字段一致（证明完全不改官方行）；`bash` + `normalizeWindowsPaths` 时适配器行存在且 `shellPath` 为空。
- 错误用例保留：显式给出不存在的 `bashPath`/`pwshPath` 仍在注册阶段报错；原"requires bashPath"用例已删除。
- 真实执行：`persistent-bash` 未配置路径时用官方 `/bin/bash` 终端跑通跨调用状态保留（本次故障配置的正向回归）；`bash` 未配置路径 + 开启改写时，官方 `bash -c` 收到的是改写后的命令。
- 既有的四模式路径映射、显式路径 spawn 断言、Bash/Pwsh 与 PTY 用例继续通过。

未验证：Windows 上省略 `bashPath` 的实际表现（官方默认在 Windows 是 pwsh），以及真实 GUI 会话。

## Consequences

只写 `shellMode` 就能启动：持久化模式用官方默认终端，一次性模式回到官方实现。配置面变小，故障面也变小——不会再因为缺少一个本机路径而让整个 profile 起不来。

代价是省略路径时行为随平台与官方默认而变：Windows 上 `shellMode: bash` 省略 `bashPath` 会得到官方默认的 pwsh 工具而不是 Bash；需要 Git Bash 时必须显式配置路径。持久化模式省略路径时也不再保证是本插件验证过的那条执行链。

## Related notes audit

[运行契约修复](../bug-fix/2026-09-24-shell-channel-runtime-contracts.md)部分重叠：那条定的是执行器 argv 与"显式路径错误直接失败"的取向，本次只放宽"未配置"这一种情况，显式路径的校验不变，互链。[路径归一化](2026-09-24-windows-path-normalization.md)部分重叠：该功能依赖本插件适配器，本次为其补上无路径时的官方 argv 回退，互链。没有其他活跃提案需要拒绝或归档。
