// Note: 包根导出与 bundle 共用此入口，安装接线由补丁提供 — 见 .agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md。
export const name = 'dsh-default-overrides';
export const inject = ['loader', 'agentPresets'];

// 0.7.0 移除了 Shell 覆盖；旧配置必须显式迁移，避免静默改变用户选择的 Shell。
const REMOVED_OPTIONS = ['shellMode', 'shellPath', 'bashPath', 'pwshPath', 'timeoutMs', 'envContext', 'normalizeWindowsPaths', 'blockNestedShells'];
// 0.10.0 移除了反代默认值与 persona 覆盖；保留旧字段时明确报错，避免配置静默失效。
const REMOVED_0_10_OPTIONS = ['reverseProxyMode', 'persona', 'personaPresets'];

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
  for (const key of REMOVED_OPTIONS) {
    if (options[key] !== undefined) {
      throw new Error(`dsh-default-overrides: ${key} was removed in 0.7.0; this package no longer overrides shell channels`);
    }
  }
  for (const key of REMOVED_0_10_OPTIONS) {
    if (options[key] !== undefined) {
      throw new Error(`dsh-default-overrides: ${key} was removed in 0.10.0; remove it from the config`);
    }
  }
  if (options.autoCompaction !== undefined) {
    throw new Error('dsh-default-overrides: autoCompaction was removed in 0.9.0; native compaction is controlled by DSH');
  }
  // Note: 禁用清单改由配置提供，默认不触碰官方工具行 — 见 .agents/notes/implemented/feature/2026-09-24-configurable-disabled-tools.md。
  const disabledTools = options.disabledTools ?? [];
  if (!Array.isArray(disabledTools) || disabledTools.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('dsh-default-overrides: disabledTools must be an array of standard preset row ids');
  }
  const includeHarnessIdentity = options.includeHarnessIdentity;
  if (includeHarnessIdentity !== undefined && typeof includeHarnessIdentity !== 'boolean') {
    throw new Error('dsh-default-overrides: includeHarnessIdentity must be a boolean');
  }
  const surfaceContext = options.surfaceContext;
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
  const SURFACE_SECTION_NAMES = new Set(['harness:source', 'app:web-surface']);

  // DSH 0.2.2 把 harness:source / app:web-surface 移到独立的 harness-dev-context 行；
  // surfaceContext:false 必须同时停用该行，否则只关掉了 DSH_WEB_URL。
  // 仅停用 entry 不够：profile HMR 会重新解析条目并恢复它。assemble() 层按名称过滤
  // 是最终保护；即使 entry 再次激活，也不会把这两段送进模型。
  function installSurfaceSuppressor(systemPrompt) {
    if (systemPrompt === undefined) return;
    const key = Symbol.for('dsh-default-overrides.surface-suppressor');
    let state = systemPrompt[key];
    if (state === undefined) {
      state = { active: false, original: systemPrompt.assemble };
      systemPrompt[key] = state;
      systemPrompt.assemble = async function (context = {}) {
        const assembly = await state.original.call(this, context);
        if (!state.active) return assembly;
        return {
          ...assembly,
          sections: (assembly.sections ?? []).filter(section => !SURFACE_SECTION_NAMES.has(section.name)),
          contexts: (assembly.contexts ?? []).filter(entry => !SURFACE_SECTION_NAMES.has(entry.name)),
        };
      };
    }
    state.active = surfaceContext === false;
  }

  function disableHarnessDevContext(entry) {
    if (entry?.options?.id !== 'harness-dev-context' || entry.options.disabled === true) return;
    entry.update({ disabled: true }).catch(error => ctx.logger.warn('dsh-default-overrides: could not disable harness-dev-context: %s', error));
  }
  if (surfaceContext === false) {
    for (const entry of ctx.loader.entries()) disableHarnessDevContext(entry);
    ctx.on('loader/entry-init', disableHarnessDevContext);
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
    // 工具禁用只作用于官方 standard 预设；其他预设原样放行。
    if (fiber?.runtime?.callback !== AgentPreset) return config;
    if (config.id !== 'standard' || disabledTools.length === 0) return config;
    if (patched.has(config)) return patched.get(config);
    const rows = flattenRows(config.plugins);
    // 上游行 ID 变化时明确报错，避免 applyEntryPatches 只留一条 warning 后静默不生效。
    for (const id of disabledTools) {
      if (!rows.some(row => row.id === id)) {
        throw new Error(`dsh-default-overrides: disabledTools names ${JSON.stringify(id)}, which is not a row of the standard preset`);
      }
    }
    const patchedPlugins = applyEntryPatches(config.plugins, disabledTools.map(id => ({ id, disabled: true })), (message, ...args) => ctx.logger.warn(message, ...args));
    const result = {
      ...config,
      plugins: patchedPlugins.data ?? patchedPlugins,
    };
    patched.set(config, result);
    patched.set(result, result);
    return result;
  }, { global: true });

  // 宿主 preset-standard 的 inject 必须包含本信号；不要把它加在 agentPresets 注册表上。
  ctx.provide('dshDefaultOverridesReady', true);

  // system-prompt 自身注入 dshDefaultOverridesReady，不能放进本插件的 inject（会形成循环）。
  // 等它可用后再安装 assemble 过滤器，覆盖 HMR 恢复 harness-dev-context 的情况。
  ctx.inject(['systemPrompt'], (spCtx) => {
    installSurfaceSuppressor(spCtx.systemPrompt);
  });

  // 兜底：bundle 补丁按顺序整体替换 inject，后安装的插件可能覆盖掉预设行上的 ready 信号，
  // 导致预设先于本插件注册、internal/config 补丁静默丢失。预设通常在本插件之后才启动，
  // 因此既处理已启动的预设，也在预设刚进入 active 状态时补一次配置重解析。
  const refreshTargets = new Set(disabledTools.length > 0 ? ['preset-standard'] : []);
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
