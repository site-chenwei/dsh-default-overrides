import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Usage: node scripts/verify-dsh-default-overrides.mjs <dsh-install-dir> <bash-path> [pwsh-path]
// An omitted pwsh-path verifies wiring with a distinct executable, never claims live Pwsh acceptance.
const [installation, bashPath, livePwshPath] = process.argv.slice(2);
if (!installation || !bashPath) throw new Error('Usage: node scripts/verify-dsh-default-overrides.mjs <dsh-install-dir> <bash-path> [pwsh-path]');
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
const PRESET = new URL('./dsh-default-overrides.mjs', import.meta.url).href;
const GROUP_ID = 'local-standard-persistent-shell';
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-shell-verify-')));
// 垫片位于共享的系统临时目录；先清掉上次运行的残留，让"未启用不落盘"的断言可重复。
const SHIM = join(tmpdir(), 'dsh-default-overrides-bashrc.sh');
rmSync(SHIM, { force: true });
const workspace = join(scratch, 'workspace');
const moved = join(workspace, 'moved');
mkdirSync(moved, { recursive: true });
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = scratch;
const environmentBefore = { ...process.env };
const pwshPath = livePwshPath ?? process.execPath;
assert.notEqual(bashPath, pwshPath, 'use different Bash/Pwsh paths to detect cross-family routing');

function overrideRow(config) {
  return { id: 'local-dsh-default-overrides', name: PRESET, config };
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
// No manual internal/config invocation: an unready hook must fail these assertions.
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
  'dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-tools',
  'dsh-system-prompt', 'dsh-sandbox-policy', 'dsh-agent-preset-registry', 'dsh-shell-env', 'dsh-jobs-local',
].map(async name => [name, await load(name)])));

// Real registry mounts the selector's emitted group. Unrelated standard tools are
// omitted from this component fixture; this is not a complete GUI host acceptance.
async function runtime(config, options = {}) {
  const presetId = options.presetId ?? 'standard';
  const root = await loaderContext();
  try {
    for (const name of ['dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local']) await root.plugin(modules[name].default);
    await root.plugin(modules['dsh-sandbox-policy'].default, { mode: 'danger-full-access', workspaceRoot: workspace });
    await root.plugin(modules['dsh-tools'].default);
    await root.plugin(modules['dsh-shell-env'], { dshHome: scratch });
    await root.plugin(modules['dsh-jobs-local'].default);
    await root.plugin(modules['dsh-agent-preset-registry'].default, { default: 'standard' });
    const declaration = options.readyInject === false ? structuredClone(standard) : withReady(standard);
    declaration.config.id = presetId;
    declaration.config.plugins = structuredClone(standard.config.plugins.filter(row => ['persona', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-web'].includes(row.id)));
    declaration.config.plugins.push({ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true });
    // 非 standard 预设拿不到本插件的行补丁（行补丁只作用于官方 standard），夹具直接在声明里禁用依赖未挂服务的行。
    if (presetId !== 'standard') {
      for (const row of declaration.config.plugins) if (row.id === 'tool-bash' || row.id === 'tool-web') row.disabled = true;
    }
    // 模拟 minimal 那样的预设级 persona 策略（complete / includeRuntimeContext）。
    if (options.personaConfig !== undefined) {
      declaration.config.plugins.find(row => row.id === 'persona').config = { ...options.personaConfig };
    }
    await root.loader.root.update([{ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' }, inject: ['dshDefaultOverridesReady'] }, declaration, overrideRow(config)]);
    await settle(root);
    const id = SessionId(`shell-verify-${presetId}-${config.shellMode ?? 'none'}`);
    const seed = Session.create(id);
    const session = Session.create(id, [], { ...seed.header, cwd: workspace });
    const agent = {
      id, session, options: {}, status: 'idle',
      get inbox() { throw new Error('inbox is outside direct-tool verification'); },
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    };
    const scope = scopeModule.createScope(root, agent);
    agent.ctx = scope.ctx;
    await root.agentPresets.mount(scope.ctx, presetId);
    root.agents.register(agent);
    let call = 0;
    return {
      root, agent,
      assemble: () => root.systemPrompt.assemble({ agent, scope: agent }),
      execute: (name, args, signal = new AbortController().signal) => root.tools.execute({
        callId: `verify-${++call}`, name, arguments: args, agent, signal,
      }),
      dispose: () => root.fiber.dispose(),
    };
  } catch (error) { await root.fiber.dispose(); throw error; }
}
function text(result) {
  return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}
function succeeded(result) {
  assert.equal(result.isError, false, text(result));
  return text(result);
}
function quoteBash(value) { return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`; }
function quotePwsh(value) { return `'${value.replaceAll("'", "''")}'`; }

try {
  for (const [config, pattern] of [
    [{ shellMode: 'fish' }, /must be one of/],
    [{ shellMode: 'bash', bashPath: join(scratch, 'missing') }, /bashPath must name/],
    [{ shellMode: 'pwsh', pwshPath: join(scratch, 'missing') }, /pwshPath must name/],
    [{ shellMode: 'bash', bashPath, timeoutMs: -1 }, /positive safe integer/],
    [{ shellMode: 'bash', shellPath: bashPath }, /shellPath was split/],
    [{ shellMode: 'pwsh', blockNestedShells: true }, /PATH shims were removed/],
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
    [{ envContext: 'yes' }, /envContext must be a boolean/],
    [{ shellMode: 'bash', bashPath, normalizeWindowsPaths: 'yes' }, /normalizeWindowsPaths must be a boolean/],
    [{ shellMode: 'pwsh', normalizeWindowsPaths: true }, /only applies to shellMode bash or persistent-bash/],
    [{ normalizeWindowsPaths: true }, /only applies to shellMode bash or persistent-bash/],
  ]) await assert.rejects(() => registeredPreset(config), pattern);

  assert.equal(existsSync(SHIM), false, 'the bash shim must not be written unless the option is enabled');
  const oneShot = await registeredPreset({ shellMode: 'bash', bashPath, normalizeWindowsPaths: true });
  const oneShotBackend = flatten(oneShot.plugins).find(row => row.id === 'gitbash-executor');
  assert.equal(oneShotBackend.config.normalizeWindowsPaths, true);
  assert.deepEqual(oneShotBackend.config.shellPath, bashPath);
  const persistentRewrite = await registeredPreset({ shellMode: 'persistent-bash', bashPath, normalizeWindowsPaths: true });
  const rewriteBackend = flatten(persistentRewrite.plugins).find(row => row.id === 'terminal-shell');
  assert.deepEqual(rewriteBackend.config.shellArgs.slice(0, 2), ['--noprofile', '--rcfile']);
  assert.equal(rewriteBackend.config.shellArgs.at(-1), '-i');
  assert.equal(rewriteBackend.config.shellArgs[2], SHIM.replaceAll('\\', '/'));
  assert.match(readFileSync(SHIM, 'utf8'), /eval\(\) \{ __dsh_default_overrides_eval "\$@"; \}/);
  console.log('PASS: path normalization reaches the chosen backend and writes the shim only when enabled');

  // 两条路径都可选：不配置时持久化模式交给官方默认终端，一次性 bash 保持官方行不动。
  for (const mode of ['persistent-bash', 'persistent-pwsh']) {
    const config = await registeredPreset({ shellMode: mode });
    const backend = flatten(config.plugins).find(row => row.id === 'terminal-shell');
    assert.equal(backend.config.shellPath, undefined, `${mode}: 未配置路径时不得写入 shellPath`);
    assert.equal(backend.config.shellDialect, mode.includes('bash') ? 'bash' : 'pwsh');
    assert.equal(backend.config.shellArgs, undefined);
  }
  assert.deepEqual(await registeredPreset({ shellMode: 'bash' }), standard.config, '一次性 bash 未配置路径时保持官方行不动');
  const pwshDefault = await registeredPreset({ shellMode: 'pwsh' });
  const pwshBackend = flatten(pwshDefault.plugins).find(row => row.id === 'pwsh-executor');
  assert.equal(pwshBackend.config.pwshPath, undefined, '一次性 pwsh 未配置路径时交给官方探测');
  assert.equal(pwshBackend.config.timeoutMs, 300000);
  const bashDefault = await registeredPreset({ shellMode: 'bash', normalizeWindowsPaths: true });
  const defaultBackend = flatten(bashDefault.plugins).find(row => row.id === 'gitbash-executor');
  assert.equal(defaultBackend.config.shellPath, undefined, '无路径但需要改写时仍挂适配器，由其沿用官方默认 argv');
  assert.equal(defaultBackend.config.normalizeWindowsPaths, true);
  console.log('PASS: bashPath and pwshPath are optional and fall back to official defaults');

  for (const mode of ['persistent-bash', 'persistent-pwsh', 'bash', 'pwsh']) {
    const config = await registeredPreset({ shellMode: mode, bashPath, pwshPath, disabledTools: ['tool-web', 'tool-workflow'] });
    const rows = flatten(config.plugins);
    const group = rows.find(row => row.id === GROUP_ID);
    const persistent = mode.startsWith('persistent-');
    const dialect = mode.includes('bash') ? 'bash' : 'pwsh';
    const selectedPath = dialect === 'bash' ? bashPath : pwshPath;
    assert.deepEqual(group.isolate, persistent ? { terminals: true } : { shell: true });
    assert.equal(rows.filter(row => row.id === GROUP_ID).length, 1);
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-web', 'tool-workflow']) assert.equal(rows.find(row => row.id === id).disabled, true);
    const backend = group.config.find(row => row.id === (persistent ? 'terminal-shell' : dialect === 'bash' ? 'gitbash-executor' : 'pwsh-executor'));
    assert.equal(backend.config[mode === 'pwsh' ? 'pwshPath' : 'shellPath'], selectedPath);
    if (persistent) assert.equal(backend.config.shellDialect, dialect);
    assert.equal(group.config.at(-1).name, `@deepseek-ai/dsh-tool-${dialect}${persistent ? '-persistent' : ''}`);
    assert.equal(group.config.at(-1).config?.description, undefined, 'keep official descriptions');
  }
  for (const mode of ['pwsh', 'persistent-pwsh']) {
    const config = await registeredPreset({ shellMode: mode, bashPath: join(scratch, 'unused-missing-bash') });
    const group = config.plugins.find(row => row.id === GROUP_ID);
    const backend = group.config.find(row => row.id === (mode === 'pwsh' ? 'pwsh-executor' : 'terminal-shell'));
    assert.equal(backend.config[mode === 'pwsh' ? 'pwshPath' : 'shellPath'], undefined, 'unset Pwsh path delegates official resolution');
  }
  assert.deepEqual(await registeredPreset({ shellMode: 'bash', bashPath }, minimal), minimal.config);
  const custom = structuredClone(standard);
  custom.id = 'preset-other'; custom.config.id = 'other';
  assert.deepEqual(await registeredPreset({ shellMode: 'bash', bashPath }, custom), custom.config);
  // 未配置任何功能时必须原样放行官方预设：既不改 Shell，也没有默认禁用清单。
  assert.deepEqual(await registeredPreset({ bashPath, pwshPath }), standard.config);
  assert.deepEqual(await registeredPreset({}), standard.config);
  const disableOnly = await registeredPreset({ disabledTools: ['tool-web', 'tool-workflow'] });
  const disableRows = flatten(disableOnly.plugins);
  for (const id of ['tool-web', 'tool-workflow']) assert.equal(disableRows.find(row => row.id === id).disabled, true);
  for (const id of ['tool-bash', 'tool-pwsh', 'skill-filesystem']) assert.deepEqual(disableRows.find(row => row.id === id), standard.config.plugins.find(row => row.id === id));

  const shippedPersona = standard.config.plugins.find(row => row.id === 'persona');
  const PERSONA = 'You are a helpful software engineer assistant.';
  const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';
  const personaRow = config => flatten(config.plugins).find(row => row.id === 'persona');
  const fixed = await registeredPreset({ persona: { prefix: PERSONA } });
  assert.deepEqual(personaRow(fixed).config, { ...shippedPersona.config, prefix: PERSONA, complete: false, includeRuntimeContext: true });
  assert.equal(personaRow(fixed).config.suffix, shippedPersona.config.suffix, 'official suffix template is preserved');
  // persona 之外的整棵条目树必须与官方预设逐字段一致。
  assert.deepEqual(fixed.plugins.map(row => row.id === 'persona' ? { ...row, config: shippedPersona.config } : row), standard.config.plugins);
  assert.deepEqual(personaRow(await registeredPreset({ persona: { suffix: 'Only the suffix.' } })).config, { ...shippedPersona.config, suffix: 'Only the suffix.', complete: false, includeRuntimeContext: true });
  assert.deepEqual(personaRow(await registeredPreset({ persona: { prefix: PERSONA, suffix: 'Kept.', complete: true, includeRuntimeContext: false } })).config, { prefix: PERSONA, suffix: 'Kept.', complete: true, includeRuntimeContext: false });
  const sparse = structuredClone(standard);
  sparse.config.plugins = sparse.config.plugins.filter(row => ['tool-bash', 'tool-pwsh'].includes(row.id));
  // 上游预设缺少 persona 行时必须报错，而不是静默跳过。
  await assert.rejects(() => registeredPreset({ persona: { prefix: PERSONA } }, sparse), /review preset compatibility/);
  await registeredPreset({ shellMode: 'bash', bashPath }, sparse);
  await registeredPreset({ shellMode: 'persistent-bash', bashPath, pwshPath }, standard, async (root, received) => {
    await root.loader.update('local-dsh-default-overrides', { config: { shellMode: 'pwsh', bashPath, pwshPath } });
    await settle(root);
    assert.equal(received.length, 2, 'ready service replacement reloads preset');
    const group = received.at(-1).plugins.filter(row => row.id === GROUP_ID);
    assert.equal(group.length, 1);
    assert.equal(group[0].config[0].config.pwshPath, pwshPath);
  });
  assert.equal(readFileSync(presetPath, 'utf8'), source, 'installed preset is not modified');
  assert.deepEqual({ ...process.env }, environmentBefore, 'plugin must not mutate host environment');
  assert.equal(existsSync(join(scratch, 'plugins', '.dsh-shell-shims')), false);
  console.log('PASS: actual preset registration, ready reload, all four path mappings, minimal/custom isolation, missing targets and no host mutation');

  for (const mode of ['bash', 'pwsh', 'persistent-bash', 'persistent-pwsh']) {
    const harness = await runtime({ shellMode: mode, bashPath, pwshPath, timeoutMs: 10000, disabledTools: ['tool-web'], persona: { prefix: PERSONA, suffix: 'Verify persona suffix.' } });
    const { root, agent } = harness;
    const persistent = mode.startsWith('persistent-');
    const dialect = mode.includes('bash') ? 'bash' : 'pwsh';
    const args = command => ({ command, ...(persistent ? {} : { description: 'Verify configured shell behavior' }) });
    try {
      const before = await harness.assemble();
      const selected = before.tools.find(tool => tool.name === dialect);
      assert(selected, `${mode}: selected tool is mounted`);
      assert(!before.tools.some(tool => tool.name === (dialect === 'bash' ? 'pwsh' : 'bash')));
      assert.deepEqual(selected.parameters.required, persistent ? ['command'] : ['command', 'description']);
      assert.match(selected.description, /Do not invoke/);
      assert.match(selected.parameters.properties.command.description, dialect === 'bash' ? /never use backslashes/ : /Quote paths containing spaces/);
      if (!persistent) assert(selected.parameters.properties.run_in_background, '一次性 bash 必须暴露 run_in_background 参数');
      const context = modules['dsh-system-prompt'].renderContextSnapshot(before);
      assert(context.includes(dialect === 'bash' ? bashPath : pwshPath));
      assert(context.includes(persistent ? 'command only' : 'command and description'));
      const prompt = modules['dsh-system-prompt'].renderPrompt(before);
      assert(prompt.includes(PERSONA), `${mode}: fixed persona reaches the rendered system prompt`);
      assert(prompt.includes('Verify persona suffix.'), `${mode}: configured persona suffix reaches the rendered system prompt`);
      assert(prompt.includes(HARNESS_IDENTITY), `${mode}: harness identity stays by default`);
      assert(prompt.trim().length > PERSONA.length + 'Verify persona suffix.'.length, `${mode}: complete=false keeps other prompt sections`);
      const repeated = await harness.assemble();
      assert.equal(repeated.tools.find(tool => tool.name === dialect).description, selected.description, 'description does not accumulate');
      assert.deepEqual(repeated.tools.find(tool => tool.name === dialect).parameters, selected.parameters);

      // Exercise the actual tool path down to spawn, with a distinct executable
      // for each dialect. Persistent startup is intentionally stopped before PTY creation.
      const method = persistent ? 'spawnTerminal' : 'spawn';
      const original = root.subprocess[method];
      let launch;
      root.subprocess[method] = spec => { launch = spec; throw new Error('verification spawn boundary'); };
      try {
        const stopped = await harness.execute(dialect, args('echo path-probe'));
        assert.equal(stopped.isError, true);
        assert.match(text(stopped), /verification spawn boundary/);
        assert.equal(launch.argv[0], dialect === 'bash' ? bashPath : pwshPath, `${mode}: configured executable reaches spawn`);
        if (persistent) assert.deepEqual(launch.argv.slice(1), dialect === 'bash' ? ['--noprofile', '--norc', '-i'] : ['-NoLogo', '-NoProfile']);
        else if (dialect === 'bash') assert.deepEqual(launch.argv.slice(1), ['-lc', 'echo path-probe']);
        else assert.deepEqual(launch.argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      } finally { root.subprocess[method] = original; }

      if (dialect === 'pwsh' && !livePwshPath) {
        console.log(`PASS: ${mode} real registration, tool schema, prompt and explicit spawn path (live Pwsh skipped: no pwsh-path argument)`);
        continue;
      }
      const firstCommand = dialect === 'bash'
        ? `cd -- ${quoteBash(moved)}; export SELECTOR_VERIFY_STATE=42; printf '%s\\n' selector-ok`
        : `Set-Location -LiteralPath ${quotePwsh(moved)}; $env:SELECTOR_VERIFY_STATE='42'; [Console]::WriteLine(('selector-' + 'ok'))`;
      assert.match(succeeded(await harness.execute(dialect, args(firstCommand))), /selector-ok/);
      const stateCommand = dialect === 'bash'
        ? `printf 'state=%s\\n' "${'${SELECTOR_VERIFY_STATE-unset}'}"; ${quoteBash(process.execPath)} -p 'process.cwd()'`
        : `[Console]::WriteLine(('state=' + $env:SELECTOR_VERIFY_STATE)); (Get-Location).ProviderPath`;
      const state = succeeded(await harness.execute(dialect, args(stateCommand)));
      assert.equal(state.includes('state=42'), persistent, `${mode}: state lifetime`);
      assert(state.includes(persistent ? moved : workspace), `${mode}: working directory lifetime: ${state}`);
      const fail = dialect === 'bash' ? '(exit 7)' : `& ${quotePwsh(process.execPath)} -e 'process.exit(7)'`;
      assert.match(succeeded(await harness.execute(dialect, args(fail))), /exit code:? 7/);
      const ok = dialect === 'bash' ? "printf '%s\\n' recovered" : "[Console]::WriteLine(('recov' + 'ered'))";
      assert.doesNotMatch(succeeded(await harness.execute(dialect, args(ok))), /exit code:? [1-9]/);
      if (dialect === 'pwsh' && persistent) {
        assert.match(succeeded(await harness.execute(dialect, args("Write-Error 'selector-error'"))), /\[exit code: 1\]/);
        assert.doesNotMatch(succeeded(await harness.execute(dialect, args('$false'))), /exit code:? [1-9]/);
      }
      if (!persistent && dialect === 'bash') {
        const badCwd = join(scratch, 'missing-cwd');
        const failed = await harness.execute('bash', { ...args('printf should-not-run'), workdir: badCwd });
        assert.equal(failed.isError, true);
        const background = await harness.execute('bash', { ...args('printf should-not-run'), workdir: badCwd, run_in_background: true });
        const jobId = background.value.jobId;
        const failedJob = await root.jobs.wait(jobId, 3000, agent.id);
        assert.notEqual(failedJob.detail, 'exit code: 0');
        const failedOutput = root.jobs.read(jobId, agent.id).chunks.map(chunk => chunk.text).join('');
        assert.match(failedOutput, /subprocess failed before reporting an outcome/);

        const backgroundOk = await harness.execute('bash', { ...args("printf 'early\\n'; sleep 0.15; printf 'late\\n'"), timeoutMs: 20, run_in_background: true });
        const okJob = await root.jobs.wait(backgroundOk.value.jobId, 3000, agent.id);
        assert.equal(okJob.detail, 'exit code: 0');
        assert.match(root.jobs.read(backgroundOk.value.jobId, agent.id).chunks.map(chunk => chunk.text).join(''), /early\nlate/);
        const promoted = await harness.execute('bash', { ...args('sleep 0.2; printf promoted-ok'), timeoutMs: 30 });
        assert.equal(promoted.value.kind, 'promoted');
        assert.equal((await root.jobs.wait(promoted.value.jobId, 3000, agent.id)).detail, 'exit code: 0');

        const shell = root.agentPresets.serviceFor(agent, 'shell');
        const timed = await (await shell.execute(shell.resolve({ command: 'sleep 2', timeoutMs: 60 }))).result();
        assert.equal(timed.timedOut, true);
        const abort = new AbortController();
        const running = await shell.execute(shell.resolve({ command: 'sleep 2', timeoutMs: 3000, signal: abort.signal }));
        abort.abort();
        assert.equal((await running.result()).aborted, true);
      }
      console.log(`PASS: ${mode} real tool/process execution, state lifetime, exit reporting and recovery${mode === 'bash' ? ', background failure/output/promotion, timeout and abort' : ''}`);
    } finally { await harness.dispose(); }
  }

  const noEnvironment = await runtime({ shellMode: 'bash', bashPath, pwshPath, envContext: false, disabledTools: ['tool-web'] });
  try {
    const assembly = await noEnvironment.assemble();
    assert(!assembly.contexts.some(section => section.name === 'local:dsh-default-overrides:environment'));
    assert.match(assembly.tools.find(tool => tool.name === 'bash').description, /Do not invoke/);
  } finally { await noEnvironment.dispose(); }
  assert.deepEqual({ ...process.env }, environmentBefore);
  console.log('PASS: envContext false preserves tool guidance; all isolated runtimes disposed');

  // 环境事实段与 Shell 补丁解耦：长期可用的每种组合都要给出可核对的文本（见 note environment-facts-in-every-shell-mode）。
  // 夹具里官方 tool-bash 没有 shell 提供者（真实宿主由 bash-sandbox 提供），因此统一禁用 tool-web/tool-bash：
  // "工具表与基线逐字段相同"就是"未托管通道时提示词平面未被改写"的证据。
  const OFFICIAL_FREE = ['tool-web', 'tool-bash'];
  const environmentSection = assembly => assembly.contexts.find(section => section.name === 'local:dsh-default-overrides:environment');
  async function environmentFacts(config, options) {
    const harness = await runtime(config, options);
    try {
      const assembly = await harness.assemble();
      return {
        section: environmentSection(assembly),
        context: modules['dsh-system-prompt'].renderContextSnapshot(assembly),
        // 惰性：官方 persona 前缀含 {{model}}，夹具未注册该变量，只有覆盖过 persona 行的夹具才需要渲染系统提示词。
        prompt: () => modules['dsh-system-prompt'].renderPrompt(assembly),
        tools: JSON.stringify(assembly.tools),
      };
    } finally { await harness.dispose(); }
  }
  const bare = await environmentFacts({ disabledTools: OFFICIAL_FREE });
  assert.equal(bare.section, undefined, '未配置 shellMode 时默认不得贡献环境段（空配置仍是零影响）');

  const envOnly = await environmentFacts({ disabledTools: OFFICIAL_FREE, envContext: true });
  assert(envOnly.section, '显式 envContext: true 在未配置 Shell 时也必须贡献环境段');
  assert.match(envOnly.context, /Host platform: /);
  assert(envOnly.context.includes(workspace), '未配置 Shell 时仍必须给出会话工作区');
  assert.doesNotMatch(envOnly.context, /Shell mode: /, '未配置 Shell 时不得声明方言');
  assert.doesNotMatch(envOnly.context, /command deadline/, '未托管通道时不得声称本插件的命令截止时间');
  assert.equal(envOnly.tools, bare.tools, '未配置 Shell 时不得改写工具表');

  const fallback = await environmentFacts({ disabledTools: OFFICIAL_FREE, shellMode: 'bash' });
  assert(fallback.section, 'officialBashFallback 下环境段必须仍然存在');
  assert.match(fallback.context, /Host platform: /);
  assert.match(fallback.context, /supplied by the active preset or the host default; this plugin configured no shell/);
  assert(fallback.context.includes(workspace));
  assert.doesNotMatch(fallback.context, /Shell mode: bash/, 'fallback 下不得冒充 bash 方言（Windows 上官方给的是 pwsh）');
  assert.doesNotMatch(fallback.context, /command deadline/, 'fallback 下 timeoutMs 不生效，不得声明截止时间');
  assert.equal(fallback.tools, bare.tools, 'fallback 下不得改写工具表');
  for (const [label, facts] of [['env only', envOnly], ['fallback', fallback]]) {
    assert.doesNotMatch(facts.context, /\{\{/, `${label}: 环境段引用的变量必须都已注册`);
  }

  const fallbackOff = await environmentFacts({ disabledTools: OFFICIAL_FREE, shellMode: 'bash', envContext: false });
  assert.equal(fallbackOff.section, undefined, 'envContext false 在 fallback 下同样不得贡献环境段');
  assert.equal(fallbackOff.tools, bare.tools);

  const managedPersistent = await environmentFacts({ disabledTools: OFFICIAL_FREE, shellMode: 'persistent-bash', timeoutMs: 12000 });
  assert.match(managedPersistent.context, /Shell mode: persistent-bash/, '托管持久化通道时必须声明方言');
  assert.match(managedPersistent.context, /command deadline is 12000 ms/, '托管持久化通道时必须声明本插件的截止时间');
  assert.match(managedPersistent.context, /may have changed its own directory/, '只有持久化通道才需要 cwd 分叉提醒');
  assert.match(managedPersistent.context, /official default bash \(bashPath unset\)/, '未配置路径时必须说明走官方默认终端');

  const managedOneShot = await environmentFacts({ disabledTools: OFFICIAL_FREE, shellMode: 'bash', bashPath, timeoutMs: 12000 });
  assert.match(managedOneShot.context, /Shell mode: bash/);
  assert(managedOneShot.context.includes(bashPath), '托管一次性通道时必须给出实际可执行文件');
  assert.match(managedOneShot.context, /command and description/);
  assert.doesNotMatch(managedOneShot.context, /command deadline/, '一次性模式沿用官方等待与上限，不得声明本插件截止时间');
  assert.doesNotMatch(managedOneShot.context, /may have changed its own directory/, '一次性模式每次新 Shell，不需要 cwd 分叉提醒');
  assert.notEqual(managedOneShot.tools, bare.tools, '托管通道时才会补充工具说明与参数提示');

  // 提示词钩子不再按预设名放行/拦截：未被打过行补丁的预设也拿到环境事实，但不得声明本插件没有配置的 Shell 通道。
  const otherBaseline = await environmentFacts({ disabledTools: OFFICIAL_FREE }, { presetId: 'other' });
  assert.equal(otherBaseline.section, undefined, '非 standard 预设下未配置 shellMode 时同样不贡献环境段');
  for (const shellMode of ['bash', 'persistent-bash']) {
    const facts = await environmentFacts({ disabledTools: OFFICIAL_FREE, shellMode }, { presetId: 'other' });
    assert(facts.section, `${shellMode}: 非 standard 预设也必须拿到环境事实段`);
    assert.match(facts.context, /Host platform: /);
    assert(facts.context.includes(workspace), `${shellMode}: 非 standard 预设也必须给出工作区`);
    assert.doesNotMatch(facts.context, /Shell mode: /, `${shellMode}: 行补丁没打过的预设不得声明通道`);
    assert.doesNotMatch(facts.context, /command deadline/, `${shellMode}: 行补丁没打过的预设不得声明截止时间`);
    assert.match(facts.context, /this plugin configured no shell/);
    assert.equal(facts.tools, otherBaseline.tools, `${shellMode}: 行补丁没打过的预设不得改写工具说明`);
  }
  console.log('PASS: environment facts reach every preset without claiming a channel the plugin did not configure');

  // 预设自己关掉运行时上下文时（minimal 的 persona 行就是 complete + includeRuntimeContext:false），
  // 抑制是预设级硬事实，本插件的环境段与段落注入都不得把它顶回来。
  const suppressed = await environmentFacts(
    { disabledTools: OFFICIAL_FREE, shellMode: 'persistent-bash', envContext: true },
    { presetId: 'other', personaConfig: { prefix: 'One line only.', complete: true, includeRuntimeContext: false } },
  );
  assert.equal(suppressed.section, undefined, '预设关闭运行时上下文时本插件的环境段必须同样被抑制');
  assert.equal(suppressed.context, '', '预设关闭运行时上下文时快照必须为空');
  assert.equal(suppressed.prompt().trim(), 'One line only.', 'complete 预设的系统提示词必须仍然是单句');
  console.log('PASS: a preset that suppresses runtime context keeps its single-line prompt');
  console.log('PASS: environment facts stay correct across every shell-mode and envContext combination');

  // personaPresets 放宽的只有 persona 行：列出的预设拿到同一份人设，未列出的保持自己的 prefix。
  // 按段落文本断言，不渲染提示词：该夹具继承的官方前缀含未注册的 {{model}}。
  const SHARED_PERSONA = 'Shared persona for listed presets.';
  const INHERITED_PERSONA = 'You are a coding agent powered by the {{model}} model.';
  const sectionTexts = assembly => assembly.sections.map(section => section.text);
  const listed = await runtime({ disabledTools: OFFICIAL_FREE, persona: { prefix: SHARED_PERSONA }, personaPresets: ['standard', 'other'] }, { presetId: 'other' });
  try {
    assert(sectionTexts(await listed.assemble()).includes(SHARED_PERSONA), '列出的非 standard 预设必须拿到这份人设');
  } finally { await listed.dispose(); }
  const unlisted = await runtime({ disabledTools: OFFICIAL_FREE, persona: { prefix: SHARED_PERSONA } }, { presetId: 'other' });
  try {
    const texts = sectionTexts(await unlisted.assemble());
    assert(texts.includes(INHERITED_PERSONA), '未列出的预设必须保留自己的 prefix');
    assert(!texts.includes(SHARED_PERSONA), '未列出的预设不得拿到这份人设');
  } finally { await unlisted.dispose(); }
  for (const [config, pattern] of [
    [{ persona: { prefix: PERSONA }, personaPresets: [] }, /personaPresets must be a non-empty array/],
    [{ persona: { prefix: PERSONA }, personaPresets: ['standard', 7] }, /personaPresets must be a non-empty array/],
    [{ personaPresets: ['other'] }, /personaPresets only widens the persona row patch/],
  ]) await assert.rejects(() => registeredPreset(config), pattern);
  console.log('PASS: personaPresets widens only the persona row — listed presets inherit the configured prefix, others keep their own');

  // 行补丁在 internal/config 阶段生效：预设行没等到本插件就绪时，它的 config 已经解析完，补丁静默丢失。
  // 这不是夹具假想——真实 preset-ptc/preset-cordis 行原本就没有这条 inject，ptc 会话拿到的是官方前缀。
  // 因此 bundle 必须为每个可能被 patch 的预设行加 dshDefaultOverridesReady（接线断言见 verify-package.mjs）。
  const unready = await runtime({ disabledTools: OFFICIAL_FREE, persona: { prefix: SHARED_PERSONA }, personaPresets: ['standard', 'other'] }, { presetId: 'other', readyInject: false });
  try {
    const texts = sectionTexts(await unready.assemble());
    assert(texts.includes(INHERITED_PERSONA), '未等待 ready 的预设保留官方 prefix');
    assert(!texts.includes(SHARED_PERSONA), '未等待 ready 的预设拿不到 persona 行补丁');
  } finally { await unready.dispose(); }
  console.log('PASS: the ready gate is load-bearing — a preset row that does not wait for the plugin never receives the persona patch');

  const hiddenIdentity = await runtime({ shellMode: 'bash', bashPath, pwshPath, disabledTools: ['tool-web'], persona: { prefix: PERSONA, suffix: 'Verify persona suffix.' }, includeHarnessIdentity: false });
  try {
    const assembly = await hiddenIdentity.assemble();
    const prompt = modules['dsh-system-prompt'].renderPrompt(assembly);
    assert(!prompt.includes(HARNESS_IDENTITY), 'includeHarnessIdentity false must drop the harness identity section');
    assert(prompt.includes(PERSONA), 'the configured persona must survive hiding the harness identity');
    assert(prompt.includes('Verify persona suffix.'), 'the persona suffix must survive hiding the harness identity');
    assert(modules['dsh-system-prompt'].renderContextSnapshot(assembly).includes(bashPath), 'runtime context must survive hiding the harness identity');
    assert.match(assembly.tools.find(tool => tool.name === 'bash').description, /Do not invoke/, 'tool guidance must survive hiding the harness identity');
  } finally { await hiddenIdentity.dispose(); }
  console.log('PASS: includeHarnessIdentity false drops only the harness identity section');

  const RAW_PATH_COMMAND = String.raw`printf '%s\n' C:\Users\chenwei\docs`;
  const pathArgs = (mode, command) => ({ command, ...(mode === 'persistent-bash' ? {} : { description: 'Verify Windows path handling' }) });
  for (const mode of ['bash', 'persistent-bash']) {
    const plain = await runtime({ shellMode: mode, bashPath, pwshPath, disabledTools: ['tool-web'], timeoutMs: 10000 });
    try {
      assert.match(succeeded(await plain.execute('bash', pathArgs(mode, RAW_PATH_COMMAND))), /C:Userschenweidocs/, `${mode}: bash drops backslashes without the option`);
    } finally { await plain.dispose(); }
    const rewriting = await runtime({ shellMode: mode, bashPath, pwshPath, disabledTools: ['tool-web'], timeoutMs: 10000, normalizeWindowsPaths: true });
    try {
      assert.match(succeeded(await rewriting.execute('bash', pathArgs(mode, RAW_PATH_COMMAND))), /C:\/Users\/chenwei\/docs/, `${mode}: the option rewrites the path before bash parses it`);
    } finally { await rewriting.dispose(); }
  }
  console.log('PASS: normalizeWindowsPaths rewrites Windows paths in one-shot bash and in the persistent PTY');

  // 未配置路径时的官方默认：持久化走官方 /bin/bash 终端，一次性 bash（需要改写时）走官方 bash -c。
  const defaultPersistent = await runtime({ shellMode: 'persistent-bash', disabledTools: ['tool-web'], timeoutMs: 10000 });
  try {
    await defaultPersistent.execute('bash', { command: 'export DSH_DEFAULT_STATE=ok' });
    assert.match(succeeded(await defaultPersistent.execute('bash', { command: 'printf "%s\\n" "$DSH_DEFAULT_STATE"' })), /ok/, 'official default terminal persists state');
  } finally { await defaultPersistent.dispose(); }
  const defaultOneShot = await runtime({ shellMode: 'bash', disabledTools: ['tool-web'], timeoutMs: 10000, normalizeWindowsPaths: true });
  try {
    assert.match(succeeded(await defaultOneShot.execute('bash', pathArgs('bash', RAW_PATH_COMMAND))), /C:\/Users\/chenwei\/docs/, 'official bash -c still receives the rewritten command');
  } finally { await defaultOneShot.dispose(); }
  console.log('PASS: shell paths are optional — official /bin/bash terminal and official bash -c both work');
  console.log('Not exercised: a full GUI/model session or Windows ConPTY on this host. Live PowerShell runs only when the optional pwsh-path argument is supplied.');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(SHIM, { force: true });
}
