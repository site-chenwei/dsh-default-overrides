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
async function runtime(config) {
  const root = await loaderContext();
  try {
    for (const name of ['dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local']) await root.plugin(modules[name].default);
    await root.plugin(modules['dsh-sandbox-policy'].default, { mode: 'danger-full-access', workspaceRoot: workspace });
    await root.plugin(modules['dsh-tools'].default);
    await root.plugin(modules['dsh-system-prompt'].default, { persona: '' });
    await root.plugin(modules['dsh-shell-env'], { dshHome: scratch });
    await root.plugin(modules['dsh-jobs-local'].default);
    await root.plugin(modules['dsh-agent-preset-registry'].default, { default: 'standard' });
    const declaration = withReady(standard);
    declaration.config.plugins = structuredClone(standard.config.plugins.filter(row => ['persona', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-web'].includes(row.id)));
    declaration.config.plugins.push({ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', disabled: true });
    await root.loader.root.update([declaration, overrideRow(config)]);
    await settle(root);
    const id = SessionId(`shell-verify-${config.shellMode}`);
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
    await root.agentPresets.mount(scope.ctx, 'standard');
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
    [{ shellMode: 'bash' }, /requires bashPath/],
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
  ]) await assert.rejects(() => registeredPreset(config), pattern);

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
      if (!persistent) assert.match(selected.description, /run_in_background/);
      const context = modules['dsh-system-prompt'].renderContextSnapshot(before);
      assert(context.includes(dialect === 'bash' ? bashPath : pwshPath));
      assert(context.includes(persistent ? 'command only' : 'command and description'));
      const prompt = modules['dsh-system-prompt'].renderPrompt(before);
      assert(prompt.includes(PERSONA), `${mode}: fixed persona reaches the rendered system prompt`);
      assert(prompt.includes('Verify persona suffix.'), `${mode}: configured persona suffix reaches the rendered system prompt`);
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
  console.log('Not exercised: a full GUI/model session or Windows ConPTY on this host. Live PowerShell runs only when the optional pwsh-path argument is supplied.');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
}
