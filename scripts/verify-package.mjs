import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: npm run verify:package -- <dsh-install-dir> <bash-path> [pwsh-path]
// Note: test the published artifact and real bundle wiring — 见 .agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md。
const [installationArg, bashPath, pwshPath] = process.argv.slice(2);
if (!installationArg || !bashPath || !process.env.npm_execpath) {
  throw new Error('Usage: npm run verify:package -- <dsh-install-dir> <bash-path> [pwsh-path]');
}
const installation = resolve(installationArg);
const installAnchor = join(installation, 'package.json');
const requireDsh = createRequire(installAnchor);
const load = name => import(pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href);
const repository = fileURLToPath(new URL('../', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-package-verify-')));
const home = join(scratch, 'home');
const profileDir = join(home, 'profiles', 'web');
const env = { ...process.env, DSH_HOME: home };
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const runNode = (args, options = {}) => execFileSync(process.execPath, args, {
  cwd: repository, env, stdio: 'inherit', ...options,
});

try {
  // Syntax is checked by verify:package; avoid lifecycle output in npm's JSON.
  const [archive] = Object.values(JSON.parse(runNode([
    process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', scratch,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })));
  const files = new Set(archive.files.map(file => file.path));
  for (const file of ['package.json', 'cordis.patch.yml', 'scripts/dsh-default-overrides.mjs', 'scripts/gitbash-executor.mjs']) {
    assert(files.has(file), `archive is missing ${file}`);
  }
  assert(!archive.files.some(file => /^(?:node_modules|\.idea|\.git)\//.test(file.path)), 'no local dependencies or editor state in archive');

  // The real CLI installs and selects the bundle, entirely inside a temporary home.
  runNode([
    join(installation, 'lib', 'bin.js'), 'plugin', '--profile', 'web',
    'add', join(scratch, archive.filename), '--offline', '--ignore-scripts',
  ]);
  const boot = await load('dsh-app-boot');
  const inventory = boot.readProfilePlugins({ binName: 'dsh', profileDir, installAnchor });
  const installed = inventory.dependencies.find(item => item.name === manifest.name);
  assert(installed?.bundle && installed.enabled, 'DSH must discover and automatically select the installed bundle');
  const requireProfile = createRequire(join(profileDir, 'package.json'));
  const installedManifest = requireProfile.resolve(`${manifest.name}/package.json`);
  assert.equal(JSON.parse(readFileSync(installedManifest, 'utf8')).version, manifest.version);
  assert.match(requireProfile.resolve(manifest.name), /dsh-default-overrides\.mjs$/);

  // Exercise the documented user layer, then inspect the real DSH composition.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify([
    { id: 'local-dsh-default-overrides', config: { shellMode: 'bash', bashPath, disabledTools: ['tool-web'], persona: { prefix: 'You are a helpful software engineer assistant.' } } },
  ]));
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert(profile.layers.some(layer => layer.packageName === manifest.name), 'bundle passes host compatibility and patch loading');
  const warnings = [];
  const entries = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message));
  assert.deepEqual(warnings, []);
  const entry = entries.find(row => row.id === 'local-dsh-default-overrides');
  const standard = entries.find(row => row.id === 'preset-standard');
  assert(entries.find(row => row.id === 'system-prompt').inject?.includes('dshDefaultOverridesReady'), 'the bundle patch must gate the global system-prompt row');
  assert.equal(entries.filter(row => row.id === entry.id).length, 1);
  assert.equal(entry.name, manifest.name);
  assert.deepEqual(entry.config, { shellMode: 'bash', bashPath, disabledTools: ['tool-web'], persona: { prefix: 'You are a helpful software engineer assistant.' } });
  assert(standard.inject.includes('dshDefaultOverridesReady'));

  const [{ Context }, { default: Loader, Group }] = await Promise.all([load('cordis'), load('cordis-plugin-loader')]);
  const root = new Context();
  const received = [];
  try {
    await root.plugin(boot.PluginPackages, {
      resolution: await boot.createRuntimeResolution({ installAnchor, profile, home }),
    });
    await root.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'package.json')).href });
    root.loader.builtins.group = Group;
    root.provide('agentPresets', { register(config) { received.push(config); return () => {}; } });
    // The preset is deliberately declared first: the bundle's inject must gate it.
    await root.loader.root.update([standard, entry]);
    await root.loader.await();
    for (const row of root.loader.entries()) await row.fiber?.await();
    assert.equal(received.length, 1, 'the real preset registers after the packaged plugin is ready');
    const rows = received[0].plugins;
    assert.equal(rows.find(row => row.id === 'tool-web').disabled, true);
    assert.equal(rows.find(row => row.id === 'persona').config.prefix, 'You are a helpful software engineer assistant.');
    const shell = rows.find(row => row.id === 'local-standard-persistent-shell');
    assert.equal(shell.config[0].config.shellPath, bashPath);
    assert.equal((await root.loader.import(shell.config[0].name)).name, 'gitbash-executor');
  } finally {
    await root.fiber.dispose();
  }
  console.log('PASS: npm artifact, offline DSH installation, automatic bundle selection, profile overrides, package imports and ready-gated preset registration');

  // Run existing process tests from the installed artifact, including relative adapter lookup.
  runNode([
    fileURLToPath(new URL('./scripts/verify-dsh-default-overrides.mjs', pathToFileURL(installedManifest))),
    installation, bashPath, ...(pwshPath ? [pwshPath] : []),
  ]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
