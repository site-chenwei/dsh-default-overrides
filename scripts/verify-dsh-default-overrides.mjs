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
const [{ Context }, { default: Loader, Group }, { parseEntryYaml }, { Session, SessionId }, scopeModule] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('cordis-plugin-include'), load('dsh-session'), load('dsh-scope'),
]);
const presetPath = requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
const source = readFileSync(presetPath, 'utf8');
const standard = parseEntryYaml(source)[0].insert[0];
const minimal = parseEntryYaml(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/minimal.patch.yml'), 'utf8'))[0].insert[0];
const ptc = parseEntryYaml(readFileSync(requireDsh.resolve('@deepseek-ai/dsh-web-app/presets/ptc.patch.yml'), 'utf8'))[0].insert[0];
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
async function registeredPreset(config, row = standard, verify, options = {}) {
  const root = await loaderContext();
  const received = [];
  root.provide('agentPresets', { register(value) { received.push(value); return () => {}; } });
  try {
    const declaration = options.readyInject === false ? structuredClone(row) : withReady(row);
    await root.loader.root.update([declaration, overrideRow(config)]);
    await settle(root);
    if (options.minRegistrations !== undefined) assert.ok(received.length >= options.minRegistrations, `preset registration count ${received.length} < ${options.minRegistrations}`);
    else assert.equal(received.length, options.expectedRegistrations ?? 1, 'preset registration count');
    await verify?.(root, received);
    return received.at(-1);
  } finally { await root.fiber.dispose(); }
}

const modules = Object.fromEntries(await Promise.all([
  'dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-tools', 'dsh-tool-executor-native',
  'dsh-system-prompt', 'dsh-sandbox-policy', 'dsh-agent-preset-registry', 'dsh-harness-dev-context',
].map(async name => [name, await load(name)])));

// Minimal real runtime: enough to exercise system-prompt assembly and preset config.
async function runtime(config, options = {}) {
  const root = await loaderContext();
  try {
    for (const name of ['dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local']) await root.plugin(modules[name].default);
    await root.plugin(modules['dsh-sandbox-policy'].default, { mode: 'danger-full-access', workspaceRoot: workspace });
    await root.plugin(modules['dsh-tools'].default);
    await root.plugin(modules['dsh-tool-executor-native']);
    await root.plugin(modules['dsh-agent-preset-registry'].default, { default: 'standard' });
    const declaration = options.readyInject === false ? structuredClone(standard) : withReady(standard);
    declaration.config.plugins = [];
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
    const id = SessionId('prompt-verify-standard');
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
    await root.agentPresets.mount(scope.ctx, 'standard');
    root.agents.register(agent);
    return {
      root,
      assemble: () => root.systemPrompt.assemble({ agent, scope: agent }),
      dispose: () => root.fiber.dispose(),
    };
  } catch (error) { await root.fiber.dispose(); throw error; }
}

try {
  const HARNESS_IDENTITY = 'DeepSeek Harness';

  // 配置校验：无效值在配置阶段直接报错；空配置不改动官方预设。
  for (const [config, pattern] of [
    [{ disabledTools: 'tool-web' }, /disabledTools must be an array/],
    [{ disabledTools: ['tool-web', 42] }, /disabledTools must be an array/],
    [{ disabledTools: ['tool-missing'] }, /not a row of the standard preset/],
    [{ includeHarnessIdentity: 'no' }, /includeHarnessIdentity must be a boolean/],
    [{ surfaceContext: 'no' }, /surfaceContext must be a boolean/],
    [{ autoCompaction: false }, /autoCompaction was removed in 0\.9\.0/],
    [{ reverseProxyMode: true }, /reverseProxyMode was removed in 0\.10\.0/],
    [{ persona: { prefix: 'text' } }, /persona was removed in 0\.10\.0/],
    [{ personaPresets: ['ptc'] }, /personaPresets was removed in 0\.10\.0/],
    [{ shellMode: 'bash' }, /shellMode was removed in 0\.7\.0/],
    [{ bashPath: '/bin/bash' }, /bashPath was removed in 0\.7\.0/],
  ]) await assert.rejects(() => registeredPreset(config), pattern);
  assert.deepEqual(await registeredPreset({}), standard.config);
  console.log('PASS: option validation and zero-impact empty config');

  // 工具禁用只作用于 standard；其他预设原样放行。
  const disabled = await registeredPreset({ disabledTools: ['tool-web', 'tool-workflow'] });
  for (const id of ['tool-web', 'tool-workflow']) assert.equal(flatten(disabled.plugins).find(row => row.id === id).disabled, true);
  for (const id of ['persona', 'skill-filesystem']) {
    assert.deepEqual(flatten(disabled.plugins).find(row => row.id === id), standard.config.plugins.find(row => row.id === id));
  }
  assert.deepEqual(await registeredPreset({ disabledTools: ['tool-web'] }, ptc), ptc.config);
  assert.deepEqual(await registeredPreset({ disabledTools: ['tool-web'] }, minimal), minimal.config);
  console.log('PASS: disabledTools only rewrites the standard preset');

  // includeHarnessIdentity 只删身份段。
  const defaultAssembly = await runtime({});
  try {
    const assembly = await defaultAssembly.assemble();
    const prompt = modules['dsh-system-prompt'].renderPrompt(assembly);
    assert(prompt.includes(HARNESS_IDENTITY));
  } finally { await defaultAssembly.dispose(); }
  const hidden = await runtime({ includeHarnessIdentity: false });
  try {
    const prompt = modules['dsh-system-prompt'].renderPrompt(await hidden.assemble());
    assert(!prompt.includes(HARNESS_IDENTITY), 'includeHarnessIdentity false drops the identity section');
  } finally { await hidden.dispose(); }
  console.log('PASS: includeHarnessIdentity false drops only the harness identity section');

  // surfaceContext 由 web-runtime 行注册；false 同时去掉两段，true 保留。
  const WEB_SECTIONS = ['harness:source', 'app:web-surface'];
  const webSections = assembly => assembly.sections.filter(section => WEB_SECTIONS.includes(section.name)).map(section => section.name);
  const otherSections = assembly => assembly.sections.map(section => section.name).filter(name => !WEB_SECTIONS.includes(name));
  const shown = await runtime({ surfaceContext: true }, { webRuntime: {} });
  let shownOther;
  let shownSurface;
  try {
    const assembly = await shown.assemble();
    assert.deepEqual(webSections(assembly), WEB_SECTIONS);
    shownOther = otherSections(assembly);
    shownSurface = shown.root.loader.resolve('web-runtime').fiber?.effectiveConfig?.surfaceContext;
  } finally { await shown.dispose(); }
  const webHidden = await runtime({ surfaceContext: false }, { webRuntime: {} });
  try {
    const assembly = await webHidden.assemble();
    assert.deepEqual(webSections(assembly), []);
    assert.deepEqual(otherSections(assembly), shownOther);
    assert.equal(webHidden.root.loader.resolve('web-runtime').fiber?.effectiveConfig?.surfaceContext, false, 'surfaceContext false must reach the web-runtime entry');
    // 模拟 profile HMR 重新解析 harness-dev-context（entry 被重新启用），assemble 层仍必须过滤。
    const harnessEntry = webHidden.root.loader.resolve('harness-dev-context');
    await harnessEntry.update({ disabled: false });
    await settle(webHidden.root);
    assert.deepEqual(webSections(await webHidden.assemble()), [], 'assemble filter must survive a re-enabled harness entry');
  } finally { await webHidden.dispose(); }
  assert.equal(shownSurface, true, 'surfaceContext true must reach the web-runtime entry');
  console.log('PASS: surfaceContext toggles only the two Web surface sections');

  // 预设行没等待 ready（被后安装的 bundle 覆盖 inject）时，运行时会补一次刷新。
  await registeredPreset({ disabledTools: ['tool-web'] }, standard, async (root, received) => {
    await settle(root);
    assert.ok(received.length >= 2, 'ungated preset must be refreshed by the runtime fallback');
    assert.equal(flatten(received.at(-1).plugins).find(row => row.id === 'tool-web').disabled, true);
  }, { readyInject: false, minRegistrations: 2 });
  console.log('PASS: ungated standard preset is refreshed at runtime');

  // 运行时重新配置插件会让真实预设重新注册，且拿到新的禁用清单。
  await registeredPreset({ disabledTools: [] }, standard, async (root, received) => {
    await root.loader.update('dsh-default-overrides', { config: { disabledTools: ['tool-web'] } });
    await settle(root);
    assert.equal(received.length, 2, 'ready service replacement reloads the preset');
    assert.equal(flatten(received.at(-1).plugins).find(row => row.id === 'tool-web').disabled, true);
  });
  assert.equal(readFileSync(presetPath, 'utf8'), source, 'installed preset is not modified');
  console.log('PASS: runtime reload re-registers the preset with the new config');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
}
