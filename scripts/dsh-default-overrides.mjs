// Note: 包根导出与 bundle 共用此入口，安装接线由补丁提供 — 见 .agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md。
export const name = 'dsh-default-overrides';
export const inject = ['loader', 'agentPresets'];

const PERSONA_ROW = { id: 'persona', name: '@deepseek-ai/dsh-persona' };
const PERSONA_KEYS = ['prefix', 'suffix', 'complete', 'includeRuntimeContext'];
// persona 名单对所有预设一视同仁；省略时只覆盖 standard。
const DEFAULT_PERSONA_PRESETS = ['standard'];
const REMOVED_OPTIONS = ['shellMode', 'shellPath', 'bashPath', 'pwshPath', 'timeoutMs', 'envContext', 'normalizeWindowsPaths', 'blockNestedShells'];
// 反代模式只提供缺省值；显式写出的配置项始终优先。
const REVERSE_PROXY_DEFAULTS = Object.freeze({
  includeHarnessIdentity: false,
  surfaceContext: false,
  disabledTools: [],
});

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

// Note: ready 保证配置钩子先于预设注册，避免预设先解析完导致补丁静默丢失。
export async function apply(ctx, options = {}) {
  // Note: 0.7.0 起不再接管 Shell 通道；旧配置必须显式迁移，避免静默改变用户选择的 Shell。
  for (const key of REMOVED_OPTIONS) {
    if (options[key] !== undefined) {
      throw new Error(`dsh-default-overrides: ${key} was removed in 0.7.0; this package no longer overrides shell channels`);
    }
  }
  // Note: 反代模式用于 DSH 经反向代理/API 网关转发的场景；未显式配置的项套用反代默认值。
  const reverseProxyMode = options.reverseProxyMode;
  if (reverseProxyMode !== undefined && typeof reverseProxyMode !== 'boolean') {
    throw new Error('dsh-default-overrides: reverseProxyMode must be a boolean');
  }
  if (options.autoCompaction !== undefined) {
    throw new Error('dsh-default-overrides: autoCompaction was removed in 0.9.0; native compaction is controlled by DSH');
  }
  const modeDefaults = reverseProxyMode === true ? REVERSE_PROXY_DEFAULTS : {};
  // Note: 禁用清单改由配置提供，默认不触碰官方工具行 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-disabled-tools.md。
  const disabledTools = options.disabledTools ?? modeDefaults.disabledTools ?? [];
  if (!Array.isArray(disabledTools) || disabledTools.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('dsh-default-overrides: disabledTools must be an array of standard preset row ids');
  }
  const persona = options.persona;
  const personaPresets = persona === undefined ? [] : options.personaPresets ?? DEFAULT_PERSONA_PRESETS;
  if (!Array.isArray(personaPresets) || personaPresets.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('dsh-default-overrides: personaPresets must be an array of agent preset ids');
  }
  const includeHarnessIdentity = options.includeHarnessIdentity ?? modeDefaults.includeHarnessIdentity;
  if (includeHarnessIdentity !== undefined && typeof includeHarnessIdentity !== 'boolean') {
    throw new Error('dsh-default-overrides: includeHarnessIdentity must be a boolean');
  }
  const surfaceContext = options.surfaceContext ?? modeDefaults.surfaceContext;
  if (surfaceContext !== undefined && typeof surfaceContext !== 'boolean') {
    throw new Error('dsh-default-overrides: surfaceContext must be a boolean');
  }

  const [{ default: AgentPreset }, { applyEntryPatches }, { default: SystemPrompt }] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-agent-preset'),
    ctx.loader.import('@deepseek-ai/cordis-plugin-include'),
    ctx.loader.import('@deepseek-ai/dsh-system-prompt'),
  ]);
  // Note: 只有明确配置 surfaceContext 时才解析 web-app，未配置的 profile（含没有 web bundle 的 headless）不引入这条依赖
  // — 见 .agents/notes/implemented/feature/2026-10-08-configurable-surface-context.md。
  const webApp = surfaceContext === undefined ? undefined : await ctx.loader.import('@deepseek-ai/dsh-web-app').catch(() => undefined);
  const applyWebApp = webApp?.apply;
  if (surfaceContext !== undefined && applyWebApp === undefined) {
    ctx.logger.warn('dsh-default-overrides: surfaceContext is configured but @deepseek-ai/dsh-web-app is unavailable in this profile; DSH_WEB_URL cannot be registered here');
  }
  const patched = new WeakMap();

  // DSH 0.2.2 把 harness:source / app:web-surface 移到独立的 harness-dev-context 行；
  // surfaceContext:false 必须同时停用该行，否则只关掉了 DSH_WEB_URL。
  function disableHarnessDevContext(entry) {
    if (entry?.options?.id !== 'harness-dev-context' || entry.options.disabled === true) return;
    entry.update({ disabled: true }).catch(error => ctx.logger.warn('dsh-default-overrides: could not disable harness-dev-context: %s', error));
  }
  if (surfaceContext === false) {
    for (const entry of ctx.loader.entries()) disableHarnessDevContext(entry);
    ctx.on('loader/entry-init', disableHarnessDevContext);
  }

  // Note: 仅固定 persona 行，保留完整标准指引 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-persona.md。
  function personaPatch(rows, presetId) {
    const matches = rows.filter(row => row.id === PERSONA_ROW.id);
    if (matches.length !== 1 || matches[0].name !== PERSONA_ROW.name || typeof matches[0].config?.prefix !== 'string') {
      throw new Error(`dsh-default-overrides: expected one ${PERSONA_ROW.id} row named ${PERSONA_ROW.name} in preset ${presetId} with a string config.prefix; review preset compatibility`);
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

  ctx.on('internal/config', function (fiber, next) {
    const config = next();
    // Note: harness:identity 由全局 system-prompt 行注册，这里只改它的官方开关 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-harness-identity.md。
    if (fiber?.runtime?.callback === SystemPrompt) {
      return includeHarnessIdentity === undefined ? config : { ...config, includeHarnessIdentity };
    }
    // Note: DSH_WEB_URL 由 web-runtime 行的 surfaceContext 决定；harness:source / app:web-surface 在 0.2.2 移至 harness-dev-context，
    // 由上面的 surfaceContext:false 分支单独停用 — 见 .agents/notes/implemented/feature/2026-10-08-configurable-surface-context.md。
    if (applyWebApp !== undefined && fiber?.runtime?.callback === applyWebApp) {
      return surfaceContext === undefined ? config : { ...config, surfaceContext };
    }
    // 行补丁只作用于官方预设：standard 是工具禁用清单的结构基线，persona 按配置的预设名单生效。
    if (fiber?.runtime?.callback !== AgentPreset) return config;
    const structural = config.id === 'standard';
    const applyPersona = persona !== undefined && personaPresets.includes(config.id);
    if (!applyPersona && (!structural || disabledTools.length === 0)) return config;
    if (patched.has(config)) return patched.get(config);
    const rows = flattenRows(config.plugins);
    const patches = [];
    if (applyPersona) {
      verifyPersonaOption(persona);
      patches.push(personaPatch(rows, config.id));
    }
    if (structural) {
      // 上游行 ID 变化时明确报错，避免 applyEntryPatches 只留一条 warning 后静默不生效。
      for (const id of disabledTools) {
        if (!rows.some(row => row.id === id)) {
          throw new Error(`dsh-default-overrides: disabledTools names ${JSON.stringify(id)}, which is not a row of the standard preset`);
        }
      }
      patches.push(...disabledTools.map(id => ({ id, disabled: true })));
    }
    const result = {
      ...config,
      plugins: applyEntryPatches(config.plugins, patches, (message, ...args) => ctx.logger.warn(message, ...args)),
    };
    patched.set(config, result);
    patched.set(result, result);
    return result;
  }, { global: true });

  // 宿主 preset-standard 的 inject 必须包含本信号；不要把它加在 agentPresets 注册表上。
  ctx.provide('dshDefaultOverridesReady', true);

  // 兜底：bundle 补丁按顺序整体替换 inject，后安装的插件可能覆盖掉预设行上的 ready 信号，
  // 导致预设先于本插件注册、internal/config 补丁静默丢失。预设通常在本插件之后才启动，
  // 因此既处理已启动的预设，也在预设刚进入 active 状态时补一次配置重解析。
  const refreshTargets = new Set(personaPresets.map(id => `preset-${id}`));
  if (disabledTools.length > 0) refreshTargets.add('preset-standard');
  const refreshedPresets = new WeakSet();
  async function refreshPreset(fiber) {
    if (!fiber?.entry || !refreshTargets.has(fiber.entry.options?.id)) return;
    if (refreshedPresets.has(fiber)) return;
    if (Object.hasOwn(fiber.inject ?? {}, 'dshDefaultOverridesReady')) return;
    refreshedPresets.add(fiber);
    try {
      await fiber.update(fiber.config, true);
    } catch (error) {
      ctx.logger.warn('dsh-default-overrides: could not refresh preset %s: %s', fiber.entry.options.id, error);
    }
  }
  const refreshEntry = (entry) => {
    if (entry.fiber) void refreshPreset(entry.fiber);
  };
  for (const entry of ctx.loader.entries()) refreshEntry(entry);
  ctx.on('internal/status', (fiber) => {
    if (fiber.state === 2 && fiber.entry) void refreshPreset(fiber);
  }, { global: true });
  setTimeout(() => {
    if (ctx.fiber?.uid == null) return;
    for (const entry of ctx.loader.entries()) refreshEntry(entry);
  }, 250);
}
