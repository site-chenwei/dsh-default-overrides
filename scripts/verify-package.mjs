import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: npm run verify:package -- <dsh-install-dir>
// Note: test the published artifact and real bundle wiring — 见 .agents/notes/implemented/architecture/2026-09-24-distributable-dsh-bundle.md。
const [installationArg] = process.argv.slice(2);
if (!installationArg || !process.env.npm_execpath) throw new Error('Usage: npm run verify:package -- <dsh-install-dir>');
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
const runtimeFiles = ['dsh-default-overrides.mjs'];
const runNode = (args, options = {}) => execFileSync(process.execPath, args, {
  cwd: repository, env, stdio: 'inherit', ...options,
});

try {
  const [archive] = Object.values(JSON.parse(runNode([
    process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', scratch,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })));
  const files = new Set(archive.files.map(file => file.path));
  for (const file of ['package.json', 'cordis.patch.yml', ...runtimeFiles.map(file => `scripts/${file}`)]) {
    assert(files.has(file), `archive is missing ${file}`);
  }
  assert(!files.has('scripts/verify-dsh-default-overrides.mjs'), 'verification scripts stay out of the npm package');
  assert(!files.has('scripts/verify-package.mjs'), 'verification scripts stay out of the npm package');
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
    { id: 'dsh-default-overrides', config: { includeHarnessIdentity: false, surfaceContext: false, disabledTools: ['tool-web'], autoCompaction: false, persona: { prefix: 'You are a helpful software engineer assistant.' } } },
  ]));
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert(profile.layers.some(layer => layer.packageName === manifest.name), 'bundle passes host compatibility and patch loading');
  const warnings = [];
  const entries = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message));
  assert.deepEqual(warnings, []);
  const entry = entries.find(row => row.id === 'dsh-default-overrides');
  const standard = entries.find(row => row.id === 'preset-standard');
  assert(entries.find(row => row.id === 'system-prompt').inject?.includes('dshDefaultOverridesReady'), 'the bundle patch must gate the global system-prompt row');
  assert.equal(entries.filter(row => row.id === entry.id).length, 1);
  assert.equal(entry.name, manifest.name);
  assert.deepEqual(entry.config, { includeHarnessIdentity: false, surfaceContext: false, disabledTools: ['tool-web'], autoCompaction: false, persona: { prefix: 'You are a helpful software engineer assistant.' } });
  assert(standard.inject.includes('dshDefaultOverridesReady'));
  for (const id of ['preset-standard', 'preset-ptc', 'preset-cordis', 'preset-minimal']) {
    const preset = entries.find(row => row.id === id);
    assert(preset, `the shipped web profile must declare ${id}`);
    assert(preset.inject?.includes('dshDefaultOverridesReady'), `the bundle patch must gate ${id}`);
  }
  const webRuntime = entries.find(row => row.id === 'web-runtime');
  assert(webRuntime, 'the shipped web profile must declare web-runtime');
  for (const dependency of ['webStartup', 'dshDefaultOverridesReady']) {
    assert(webRuntime.inject?.includes(dependency), `the bundle patch must keep ${dependency} on web-runtime`);
  }

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
    const compaction = rows.find(row => row.id === 'compaction').config.find(row => row.id === 'compaction-basic');
    assert.deepEqual(compaction.config, { auto: false });
  } finally {
    await root.fiber.dispose();
  }
  console.log('PASS: npm artifact, offline DSH installation, automatic bundle selection, profile overrides and ready-gated preset registration');

  // File deployment example must remain a valid single-file patch.
  const fileDir = join(scratch, 'file-plugin');
  mkdirSync(fileDir);
  copyFileSync(fileURLToPath(new URL('./scripts/dsh-default-overrides.mjs', pathToFileURL(installedManifest))), join(fileDir, 'dsh-default-overrides.mjs'));
  const [{ entryListSchema }, yaml] = await Promise.all([
    load('cordis-plugin-include'), import(pathToFileURL(requireDsh.resolve('js-yaml')).href),
  ]);
  const filePatches = yaml.load(readFileSync(join(repository, 'examples/file.cordis.patch.yml'), 'utf8'), { schema: entryListSchema });
  const fileEntry = filePatches[0].insert[0];
  fileEntry.name = pathToFileURL(join(fileDir, 'dsh-default-overrides.mjs')).href;
  fileEntry.config = { ...fileEntry.config, personaPresets: ['ptc'] };
  const fileEntries = boot.composeEntries([
    ...profile.layers.filter(layer => layer.packageName !== manifest.name).map(layer => layer.patches), filePatches,
  ], message => { throw new Error(message); });
  assert(fileEntries.find(row => row.id === 'dsh-default-overrides'), 'file deployment example inserts the entry');
  for (const id of ['preset-standard', 'preset-ptc', 'preset-cordis', 'preset-minimal', 'system-prompt']) {
    assert(fileEntries.find(row => row.id === id)?.inject?.includes('dshDefaultOverridesReady'), `file deployment must gate ${id}`);
  }
  assert(fileEntries.find(row => row.id === 'web-runtime')?.inject?.includes('webStartup'), 'file deployment must keep webStartup');
  console.log('PASS: documented single-file deployment example composes cleanly');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
