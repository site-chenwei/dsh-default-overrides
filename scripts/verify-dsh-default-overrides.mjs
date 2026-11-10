import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Usage: node scripts/verify-dsh-default-overrides.mjs <dsh-install-dir>
// The fixture mounts the real DSH packages and the real preset patch, not copies of plugin logic.
const [installationArg] = process.argv.slice(2);
if (!installationArg) throw new Error('Usage: node scripts/verify-dsh-default-overrides.mjs <dsh-install-dir>');
const installation = resolve(installationArg);
const requireDsh = createRequire(pathToFileURL(join(installation, 'package.json')).href);
const load = name => import(pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { default: Loader, Group }, { entryListSchema }, yaml, { Session, SessionId }, scopeModule] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('cordis-plugin-include'),
  import(pathToFileURL(requireDsh.resolve('js-yaml')).href), load('dsh-session'), load('dsh-scope'),
]);
const presetPath = requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
const source = readFileSync(presetPath, 'utf8');
const standard = yaml.load(source, { schema: entryListSchema })[0].insert[0];
const minimal = yaml.load(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/minimal.patch.yml'), 'utf8'), { schema: entryListSchema })[0].insert[0];
const ptc = yaml.load(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/ptc.patch.yml'), 'utf8'), { schema: entryListSchema })[0].insert[0];
const PRESET = new URL('./dsh-default-overrides.mjs', import.meta.url).href;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-default-overrides-verify-')));
const workspace = join(scratch, 'workspace');
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = scratch;

function overrideRow(config) {
  return { id: 'dsh-default-overrides', name: PRESET, config };
}
function withReady(row) {
  return { ...structuredClone(row), inject: ['dshDefaultOverridesReady'] };
}
function flatten(rows) {
  return rows.flatMap(row => [row, ...(row.group ? flatten(row.config) : [])]);
}
async function settle(root) {
  await root.loader.await();
  for (const entry of root.loader.entries()) await entry.fiber?.await();
}
async function loaderContext() {
  const root = new Context();
  await root.plugin(Loader, { baseUrl: pathToFileURL(join(installation, 'package.json')).href });
  root.loader.builtins.group = Group;
  return root;
}

// Record the configuration actually delivered by official AgentPreset.register.
async function registeredPreset(config, row = standard, verify) {
  const root = await loaderContext();
  const received = [];
  root.provide('agentPresets', { register(value) { received.push(value); return () => {}; } });
  try {
    await root.loader.root.update([withReady(row), overrideRow(config)]);
    await settle(root);
    assert.equal(received.length, 1, 'preset actually registers once after ready');
    await verify?.(root, received);
    return received.at(-1);
  } finally { await root.fiber.dispose(); }
}

const modules = Object.fromEntries(await Promise.all([
  'dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-tools', 'dsh-tool-executor-native',
  'dsh-system-prompt', 'dsh-sandbox-policy', 'dsh-agent-preset-registry', 'dsh-harness-dev-context',
].map(async name => [name, await load(name)])));

// Minimal real runtime: enough to exercise system-prompt assembly, persona registration and preset config.
async function runtime(config, options = {}) {
  const presetId = options.presetId ?? 'standard';
  const root = await loaderContext();
  try {
    for (const name of ['dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local']) await root.plugin(modules[name].default);
    await root.plugin(modules['dsh-sandbox-policy'].default, { mode: 'danger-full-access', workspaceRoot: workspace });
    await root.plugin(modules['dsh-tools'].default);
    await root.plugin(modules['dsh-tool-executor-native']);
    await root.plugin(modules['dsh-agent-preset-registry'].default, { default: 'standard' });
    const declaration = options.readyInject === false ? structuredClone(standard) : withReady(standard);
    declaration.config.id = presetId;
    declaration.config.plugins = structuredClone(standard.config.plugins.filter(row => ['persona', 'tool-web', 'tool-workflow'].includes(row.id)));
    for (const row of declaration.config.plugins) if (row.id === 'tool-web' || row.id === 'tool-workflow') row.disabled = true;
    if (options.personaConfig !== undefined) {
      declaration.config.plugins.find(row => row.id === 'persona').config = { ...options.personaConfig };
    }
    const rows = [
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' }, inject: ['dshDefaultOverridesReady'] },
      declaration,
      overrideRow(config),
    ];
    if (options.webRuntime !== undefined) {
      root.provide('webServer', { host: '127.0.0.1', port: 3080, protocol: 'http:', getOrigin: () => 'http://127.0.0.1:3080' });
      const webRow = {
        id: 'web-runtime',
        name: '@deepseek-ai/dsh-web-app',
        ...(options.webRuntime.ready === false ? {} : { inject: ['dshDefaultOverridesReady'] }),
        config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] },
      };
      const harnessRow = { id: 'harness-dev-context', name: '@deepseek-ai/dsh-harness-dev-context' };
      await root.loader.root.update([webRow, harnessRow]);
      await root.loader.await();
      rows.unshift(webRow, harnessRow);
    }
    await root.loader.root.update(rows);
    await settle(root);
    const id = SessionId(`prompt-verify-${presetId}`);
    const seed = Session.create(id);
    const session = Session.create(id, [], { ...seed.header, cwd: workspace });
    const agent = {
      id, session, options: {}, status: 'idle',
      get inbox() { throw new Error('inbox is outside direct verification'); },
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    };
    const scope = scopeModule.createScope(root, agent);
    agent.ctx = scope.ctx;
    await root.agentPresets.mount(scope.ctx, presetId);
    root.agents.register(agent);
    return {
      root,
      assemble: () => root.systemPrompt.assemble({ agent, scope: agent }),
      dispose: () => root.fiber.dispose(),
    };
  } catch (error) { await root.fiber.dispose(); throw error; }
}
const sectionTexts = assembly => assembly.sections.map(section => section.text);
const personaRow = config => flatten(config.plugins).find(row => row.id === 'persona');

try {
  const PERSONA = 'You are a helpful software engineer assistant.';
  const SUFFIX = 'Verify persona suffix.';
  const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';

  // 配置校验：无效值在配置阶段直接报错；空配置不改动官方预设。
  for (const [config, pattern] of [
    [{ disabledTools: 'tool-web' }, /disabledTools must be an array/],
    [{ disabledTools: ['tool-web', 42] }, /disabledTools must be an array/],
    [{ disabledTools: ['tool-missing'] }, /not a row of the standard preset/],
    [{ persona: 'text' }, /persona must be an object/],
    [{ persona: null }, /persona must be an object/],
    [{ persona: {} }, /persona needs at least one/],
    [{ persona: { preifx: 'typo' } }, /unsupported keys/],
    [{ persona: { prefix: 42 } }, /persona\.prefix must be a string/],
    [{ persona: { complete: 'yes' } }, /persona\.complete must be a boolean/],
    [{ includeHarnessIdentity: 'no' }, /includeHarnessIdentity must be a boolean/],
    [{ surfaceContext: 'no' }, /surfaceContext must be a boolean/],
    [{ autoCompaction: false }, /autoCompaction was removed in 0\.9\.0/],
    [{ reverseProxyMode: 'yes' }, /reverseProxyMode must be a boolean/],
    [{ shellMode: 'bash' }, /shellMode was removed in 0\.7\.0/],
    [{ bashPath: '/bin/bash' }, /bashPath was removed in 0\.7\.0/],
  ]) await assert.rejects(() => registeredPreset(config), pattern);
  assert.deepEqual(await registeredPreset({}), standard.config);
  assert.deepEqual(await registeredPreset({ personaPresets: ['ptc'] }), standard.config, 'personaPresets without persona is inert');
  console.log('PASS: option validation and zero-impact empty config');
  assert.deepEqual(await registeredPreset({ reverseProxyMode: true }), standard.config);
  const reverseExplicit = await registeredPreset({ reverseProxyMode: true, disabledTools: ['tool-web'] });
  assert.equal(flatten(reverseExplicit.plugins).find(row => row.id === 'tool-web').disabled, true);
  console.log('PASS: reverseProxyMode applies defaults and explicit options win');

  // 工具禁用只作用于 standard；其他预设原样放行。
  const disabled = await registeredPreset({ disabledTools: ['tool-web', 'tool-workflow'] });
  for (const id of ['tool-web', 'tool-workflow']) assert.equal(flatten(disabled.plugins).find(row => row.id === id).disabled, true);
  for (const id of ['persona', 'skill-filesystem']) {
    assert.deepEqual(flatten(disabled.plugins).find(row => row.id === id), standard.config.plugins.find(row => row.id === id));
  }
  assert.deepEqual(await registeredPreset({ disabledTools: ['tool-web'] }, ptc), ptc.config);
  assert.deepEqual(await registeredPreset({ disabledTools: ['tool-web'] }, minimal), minimal.config);
  console.log('PASS: disabledTools only rewrites the standard preset');

  // persona 覆盖整行 config；未列出的预设保持自己的 prefix。
  const shippedPersona = standard.config.plugins.find(row => row.id === 'persona');
  const fixed = await registeredPreset({ persona: { prefix: PERSONA, suffix: SUFFIX } });
  assert.deepEqual(personaRow(fixed).config, { ...shippedPersona.config, prefix: PERSONA, suffix: SUFFIX, complete: false, includeRuntimeContext: true });
  assert.deepEqual(fixed.plugins.map(row => row.id === 'persona' ? { ...row, config: shippedPersona.config } : row), standard.config.plugins);
  const shared = await registeredPreset({ persona: { prefix: PERSONA }, personaPresets: ['ptc'] }, ptc);
  assert.equal(personaRow(shared).config.prefix, PERSONA);
  assert.deepEqual(await registeredPreset({ persona: { prefix: PERSONA }, personaPresets: ['ptc'] }), standard.config);
  const sparse = structuredClone(standard);
  sparse.config.plugins = sparse.config.plugins.filter(row => ['tool-bash', 'tool-pwsh'].includes(row.id));
  await assert.rejects(() => registeredPreset({ persona: { prefix: PERSONA } }, sparse), /review preset compatibility/);
  for (const personaPresets of ['ptc', ['standard', 7]]) {
    await assert.rejects(() => registeredPreset({ persona: { prefix: PERSONA }, personaPresets }), /personaPresets must be an array/);
  }
  console.log('PASS: persona overrides respect personaPresets and preserve untouched presets');

  // includeHarnessIdentity 只删身份段，不影响 persona。
  const defaultAssembly = await runtime({ persona: { prefix: PERSONA, suffix: SUFFIX } });
  try {
    const prompt = modules['dsh-system-prompt'].renderPrompt(await defaultAssembly.assemble());
    assert(prompt.includes(HARNESS_IDENTITY));
    assert(prompt.includes(PERSONA));
    assert(prompt.includes(SUFFIX));
  } finally { await defaultAssembly.dispose(); }
  const hidden = await runtime({ persona: { prefix: PERSONA, suffix: SUFFIX }, includeHarnessIdentity: false });
  try {
    const prompt = modules['dsh-system-prompt'].renderPrompt(await hidden.assemble());
    assert(!prompt.includes(HARNESS_IDENTITY), 'includeHarnessIdentity false drops the identity section');
    assert(prompt.includes(PERSONA) && prompt.includes(SUFFIX), 'persona survives hiding identity');
  } finally { await hidden.dispose(); }
  console.log('PASS: includeHarnessIdentity false drops only the harness identity section');

  // surfaceContext 由 web-runtime 行注册；false 同时去掉两段，true 保留。
  const WEB_SECTIONS = ['harness:source', 'app:web-surface'];
  const webSections = assembly => assembly.sections.filter(section => WEB_SECTIONS.includes(section.name)).map(section => section.name);
  const otherSections = assembly => assembly.sections.map(section => section.name).filter(name => !WEB_SECTIONS.includes(name));
  const shown = await runtime({ surfaceContext: true, persona: { prefix: PERSONA, suffix: SUFFIX } }, { webRuntime: {} });
  let shownOther;
  let shownSurface;
  try {
    const assembly = await shown.assemble();
    assert.deepEqual(webSections(assembly), WEB_SECTIONS);
    shownOther = otherSections(assembly);
    shownSurface = shown.root.loader.resolve('web-runtime').fiber?.effectiveConfig?.surfaceContext;
  } finally { await shown.dispose(); }
  const webHidden = await runtime({ surfaceContext: false, persona: { prefix: PERSONA, suffix: SUFFIX } }, { webRuntime: {} });
  try {
    const assembly = await webHidden.assemble();
    assert.deepEqual(webSections(assembly), []);
    assert.deepEqual(otherSections(assembly), shownOther);
    assert.equal(webHidden.root.loader.resolve('web-runtime').fiber?.effectiveConfig?.surfaceContext, false, 'surfaceContext false must reach the web-runtime entry');

  } finally { await webHidden.dispose(); }
  assert.equal(shownSurface, true, 'surfaceContext true must reach the web-runtime entry');
  console.log('PASS: surfaceContext toggles only the two Web surface sections');

  // 反代模式默认隐藏身份与 Web 表层上下文；显式 true 可以覆盖。
  const reverse = await runtime({ reverseProxyMode: true, persona: { prefix: PERSONA, suffix: SUFFIX } }, { webRuntime: {} });
  try {
    const assembly = await reverse.assemble();
    assert.deepEqual(webSections(assembly), []);
    const prompt = modules['dsh-system-prompt'].renderPrompt(assembly);
    assert(!prompt.includes(HARNESS_IDENTITY), 'reverseProxyMode must hide the harness identity');
    assert(prompt.includes(PERSONA) && prompt.includes(SUFFIX));
  } finally { await reverse.dispose(); }
  const reverseRuntimeExplicit = await runtime({ reverseProxyMode: true, includeHarnessIdentity: true, surfaceContext: true, persona: { prefix: PERSONA, suffix: SUFFIX } }, { webRuntime: {} });
  try {
    const assembly = await reverseRuntimeExplicit.assemble();
    assert.deepEqual(webSections(assembly), WEB_SECTIONS);
    assert(modules['dsh-system-prompt'].renderPrompt(assembly).includes(HARNESS_IDENTITY), 'explicit includeHarnessIdentity true must win');
  } finally { await reverseRuntimeExplicit.dispose(); }
  console.log('PASS: reverseProxyMode hides prompt fingerprints unless explicitly overridden');

  // 预设行没等待 ready（被后安装的 bundle 覆盖 inject）时，运行时会补一次刷新。
  const unready = await runtime({ persona: { prefix: PERSONA, suffix: SUFFIX }, personaPresets: ['standard', 'other'] }, { presetId: 'other', readyInject: false });
  try {
    const texts = sectionTexts(await unready.assemble());
    assert(texts.includes(PERSONA), 'ungated preset must be refreshed by the runtime fallback');
  } finally { await unready.dispose(); }
  console.log('PASS: ungated presets are refreshed at runtime');

  // 运行时重新配置插件会让真实预设重新注册，且拿到新的人设。
  await registeredPreset({ persona: { prefix: PERSONA, suffix: SUFFIX } }, standard, async (root, received) => {
    await root.loader.update('dsh-default-overrides', { config: { persona: { prefix: 'Reloaded persona.', suffix: SUFFIX } } });
    await settle(root);
    assert.equal(received.length, 2, 'ready service replacement reloads the preset');
    assert.equal(personaRow(received.at(-1)).config.prefix, 'Reloaded persona.');
  });
  assert.equal(readFileSync(presetPath, 'utf8'), source, 'installed preset is not modified');
  console.log('PASS: runtime reload re-registers the preset with the new config');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
}
