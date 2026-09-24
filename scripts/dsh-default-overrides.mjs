import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Note: 包根导出与 bundle 共用此入口，安装接线由补丁提供 — 见 .agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md。
export const name = 'dsh-default-overrides';
export const inject = ['loader', 'agentPresets'];

const SHIPPED_SHELL_ROWS = [
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
];
const SHELL_MODES = ['persistent-bash', 'persistent-pwsh', 'bash', 'pwsh'];
const SHELL_GROUP_ID = 'local-standard-persistent-shell';
const ENVIRONMENT_SECTION = 'local:dsh-default-overrides:environment';
const PERSONA_ROW = { id: 'persona', name: '@deepseek-ai/dsh-persona' };
const PERSONA_KEYS = ['prefix', 'suffix', 'complete', 'includeRuntimeContext'];

/** 校验 persona 覆盖项；键名或类型写错时直接报错，避免静默不生效。 */
function verifyPersonaOption(persona) {
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error(`dsh-default-overrides: persona must be an object using ${PERSONA_KEYS.join(', ')}`);
  }
  const keys = Object.keys(persona);
  const unknown = keys.filter(key => !PERSONA_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`dsh-default-overrides: persona has unsupported keys ${unknown.map(key => JSON.stringify(key)).join(', ')}; allowed: ${PERSONA_KEYS.join(', ')}`);
  }
  if (keys.length === 0) {
    throw new Error(`dsh-default-overrides: persona needs at least one of ${PERSONA_KEYS.join(', ')}`);
  }
  for (const key of ['prefix', 'suffix']) {
    if (persona[key] !== undefined && typeof persona[key] !== 'string') {
      throw new Error(`dsh-default-overrides: persona.${key} must be a string`);
    }
  }
  for (const key of ['complete', 'includeRuntimeContext']) {
    if (persona[key] !== undefined && typeof persona[key] !== 'boolean') {
      throw new Error(`dsh-default-overrides: persona.${key} must be a boolean`);
    }
  }
}

/** 操作规则补充官方说明；不声称 PATH 遮蔽或系统级 Shell 隔离。 */
function shellGuidance(dialect) {
  return dialect === 'bash'
    ? [
      'Use Bash syntax with the configured Bash executable (Git Bash / MSYS2 on Windows).',
      'This is the selected shell channel. Do not invoke cmd, powershell or pwsh (including .exe or absolute paths) to wrap a command or retry a failure. Run native programs directly; if a different shell is required, explain the need to the user.',
      "In Bash, quote Windows paths and use forward slashes, e.g. cd -- 'C:/Users/name/project'. Backslashes are escapes.",
    ].join(' ')
    : [
      'Use PowerShell syntax with the configured PowerShell executable.',
      'This is the selected shell channel. Do not invoke cmd, bash or sh (including .exe or absolute paths) to wrap a command or retry a failure. Run native programs directly; if a different shell is required, explain the need to the user.',
      'Quote paths containing spaces; PowerShell uses a backtick as the escape character. Read environment variables with $env:NAME.',
    ].join(' ');
}

function environmentContext(mode, persistent, timeoutMs, hasWorkspace) {
  return [
    `Host platform: ${process.platform}. Shell mode: ${mode}. Executable: {{dsh_overrides_shell_path}}.`,
    persistent
      ? `Arguments: command only. Working directory, variables and functions persist while the shell stays alive. The command deadline is ${timeoutMs} ms; exit, timeout, cancellation or restart resets shell state.`
      : 'Required arguments: command and description. Each call starts a fresh shell; use workdir for the working directory. Follow the tool schema for timeoutMs and background execution; a foreground wait timeout may promote the command to a background job.',
    ...(hasWorkspace ? [
      'Session workspace: {{dsh_overrides_workspace}}. File tools resolve relative paths from this workspace; a persistent shell may have changed its own directory.',
    ] : []),
  ].join('\n');
}

/** 拍平预设行，group 行自身也在结果中。 */
function flattenRows(rows) {
  const flat = [];
  function visit(entries) {
    for (const row of entries) {
      flat.push(row);
      if (row.group === true) visit(row.config);
    }
  }
  visit(rows);
  return flat;
}

/** 校验 standard 的 Shell 替换目标；上游改结构时明确报错。 */
function verifyShellRows(flat) {
  for (const row of SHIPPED_SHELL_ROWS) {
    const matches = flat.filter(candidate => candidate.id === row.id);
    if (matches.length !== 1 || matches[0].name !== row.name) {
      throw new Error(`dsh-default-overrides: shipped preset changed at ${row.id}; review shell compatibility`);
    }
  }
  if (flat.some(row => row.id === SHELL_GROUP_ID)) {
    throw new Error('dsh-default-overrides: the shipped preset already contains the local shell group');
  }
}

// Note: ready 保证钩子先于预设注册，禁止修改宿主 PATH — 见 .agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md。
export async function apply(ctx, options = {}) {
  const mode = options.shellMode;
  const shellEnabled = mode !== undefined;
  if (shellEnabled && !SHELL_MODES.includes(mode)) {
    throw new Error(`dsh-default-overrides: shellMode must be one of ${SHELL_MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  }
  if (options.shellPath !== undefined) {
    throw new Error('dsh-default-overrides: shellPath was split into bashPath and pwshPath; rename the configured path');
  }
  if (options.blockNestedShells === true) {
    throw new Error('dsh-default-overrides: blockNestedShells PATH shims were removed; remove this option and fully restart DSH');
  }
  // Note: 禁用清单改由配置提供，默认不触碰官方工具行 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-disabled-tools.md。
  const disabledTools = options.disabledTools ?? [];
  if (!Array.isArray(disabledTools) || disabledTools.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('dsh-default-overrides: disabledTools must be an array of standard preset row ids');
  }
  const persona = options.persona;
  if (persona !== undefined) verifyPersonaOption(persona);
  const persistent = shellEnabled && mode.startsWith('persistent-');
  const dialect = mode === 'bash' || mode === 'persistent-bash' ? 'bash' : 'pwsh';
  const pathKey = dialect === 'bash' ? 'bashPath' : 'pwshPath';
  // 两路径可以并存；仅当前家族的配置影响加载，不回退到另一家族的路径。
  const shellPath = shellEnabled ? options[pathKey] : undefined;
  if (shellEnabled && dialect === 'bash' && shellPath === undefined) {
    throw new Error(`dsh-default-overrides: shellMode '${mode}' requires bashPath (absolute path to Git Bash bash.exe)`);
  }
  if (shellPath !== undefined && (typeof shellPath !== 'string' || !isAbsolute(shellPath) || !existsSync(shellPath) || !statSync(shellPath).isFile())) {
    throw new Error(`dsh-default-overrides: ${pathKey} must name an existing absolute executable`);
  }
  const timeoutMs = options.timeoutMs ?? 300000;
  if (shellEnabled && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('dsh-default-overrides: timeoutMs must be a positive safe integer');
  }
  const [{ default: AgentPreset }, { applyEntryPatches }] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-agent-preset'),
    ctx.loader.import('@deepseek-ai/cordis-plugin-include'),
  ]);
  const patched = new WeakMap();

  function shellPatches() {
    const backendRows = persistent ? [
      { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
      {
        id: 'terminal-shell',
        name: '@deepseek-ai/dsh-terminal-bash',
        config: {
          shellDialect: dialect,
          ...(shellPath === undefined ? {} : { shellPath }),
          timeoutMs,
        },
      },
    ] : [dialect === 'bash' ? {
      id: 'gitbash-executor',
      name: new URL('./gitbash-executor.mjs', import.meta.url).href,
      config: { shellPath, timeoutMs },
    } : {
      id: 'pwsh-executor',
      name: '@deepseek-ai/dsh-pwsh-local',
      config: { ...(shellPath === undefined ? {} : { pwshPath: shellPath }), timeoutMs },
    }];
    return [
      ...SHIPPED_SHELL_ROWS.map(row => ({ ...row, disabled: true })),
      { insert: [{
        id: SHELL_GROUP_ID,
        name: 'cordis:group',
        group: true,
        isolate: persistent ? { terminals: true } : { shell: true },
        config: [
          ...backendRows,
          {
            id: persistent ? 'persistent-shell' : 'one-shot-shell',
            name: `@deepseek-ai/dsh-tool-${dialect}${persistent ? '-persistent' : ''}`,
            ...(persistent ? { config: { timeoutMs } } : {}),
          },
        ],
      }] },
    ];
  }

  // Note: 仅固定 persona 行，保留完整标准指引 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-persona.md。
  function personaPatch(rows) {
    const matches = rows.filter(row => row.id === PERSONA_ROW.id);
    if (matches.length !== 1 || matches[0].name !== PERSONA_ROW.name || typeof matches[0].config?.prefix !== 'string') {
      throw new Error(`dsh-default-overrides: expected one standard ${PERSONA_ROW.id} row named ${PERSONA_ROW.name} with a string config.prefix; review preset compatibility`);
    }
    // 行补丁整体替换 config，因此先展开当前有效值；complete 与运行时上下文按方案默认，可显式覆盖。
    return {
      id: PERSONA_ROW.id,
      name: PERSONA_ROW.name,
      config: {
        ...matches[0].config,
        ...persona,
        complete: persona.complete ?? false,
        includeRuntimeContext: persona.includeRuntimeContext ?? true,
      },
    };
  }

  ctx.on('internal/config', function (_raw, next) {
    const config = next();
    if (this.runtime?.callback !== AgentPreset || config.id !== 'standard') return config;
    if (patched.has(config)) return patched.get(config);
    if (!shellEnabled && disabledTools.length === 0 && persona === undefined) return config;
    const rows = flattenRows(config.plugins);
    if (shellEnabled) verifyShellRows(rows);
    // 上游行 ID 变化时明确报错，避免 applyEntryPatches 只留一条 warning 后静默不生效。
    for (const id of disabledTools) {
      if (!rows.some(row => row.id === id)) {
        throw new Error(`dsh-default-overrides: disabledTools names ${JSON.stringify(id)}, which is not a row of the standard preset`);
      }
    }
    const patches = [
      ...disabledTools.map(id => ({ id, disabled: true })),
      ...(persona === undefined ? [] : [personaPatch(rows)]),
      ...(shellEnabled ? shellPatches() : []),
    ];
    const result = {
      ...config,
      plugins: applyEntryPatches(config.plugins, patches, (message, ...args) => ctx.logger.warn(message, ...args)),
    };
    patched.set(config, result);
    patched.set(result, result);
    return result;
  }, { global: true });

  if (shellEnabled) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      const agent = context.agent;
      if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== 'standard') return assembly;
      const workspace = agent.session.header.cwd;
      const tools = assembly.tools.map(tool => tool.name === dialect
        ? { ...tool, description: `${tool.description}\n\n${shellGuidance(dialect)}` }
        : tool);
      if (options.envContext === false) return { ...assembly, tools };
      return {
        ...assembly,
        tools,
        variables: {
          ...assembly.variables,
          dsh_overrides_shell_path: shellPath ?? 'auto-detected by the official PowerShell executor (pwshPath unset)',
          ...(workspace === undefined ? {} : { dsh_overrides_workspace: workspace }),
        },
        contexts: [
          ...assembly.contexts.filter(section => section.name !== ENVIRONMENT_SECTION),
          { name: ENVIRONMENT_SECTION, text: environmentContext(mode, persistent, timeoutMs, workspace !== undefined) },
        ],
      };
    }, { global: true });
  }

  // 宿主 preset-standard 的 inject 必须包含本信号；不要把它加在 agentPresets 注册表上。
  ctx.provide('dshDefaultOverridesReady', true);
}
