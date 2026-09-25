import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveWindowsBash, createBashProbe, parseBashProbe, verifyWindowsBash, createBashRuntime, BASH_RUNTIME_SERVICE } from './bash-runtime.mjs';
import { applyWindowsBash } from './gitbash-executor.mjs';
import * as windowsTerminal from './windows-bash-terminal.mjs';

/** Portable logic checks plus actual unsupported-backend cleanup on a non-Windows host. */
export async function verifyBashRuntime(installation, bashPath) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-bash-runtime-'));
  try {
    const first = join(scratch, 'first directory');
    const second = join(scratch, 'second directory');
    for (const directory of [first, second]) { mkdirSync(directory); writeFileSync(join(directory, 'bash.exe'), 'resolver fixture'); }
    const environment = { Path: `"${first}";${second}` };
    assert.deepEqual(resolveWindowsBash(undefined, 'bash', environment), { executable: join(first, 'bash.exe'), source: 'PATH' });
    assert.equal(resolveWindowsBash(join(second, 'bash.exe'), 'persistent-bash', environment).executable, join(second, 'bash.exe'));
    assert.throws(() => resolveWindowsBash(join(scratch, 'missing.exe'), 'bash', environment), /source=bashPath.*no fallback/);
    assert.throws(() => resolveWindowsBash(undefined, 'persistent-bash', {}), /persistent-bash.*source=PATH.*configure bashPath/);
    assert.throws(() => resolveWindowsBash('bash.exe', 'bash', environment), /absolute Bash executable/);
    assert.throws(() => resolveWindowsBash(42, 'bash', environment), /source=bashPath.*absolute Bash executable/);

    const probe = createBashProbe(String.raw`C:\Program Files\Bill'Chen\node.exe`);
    const entry = { executable: String.raw`C:\Git\bin\bash.exe`, source: 'bashPath' };
    const msys = { version: '5.2.37(1)-release', system: 'MINGW64_NT-10.0', os: 'Msys', cygpath: '/usr/bin/cygpath', unixPath: "/c/Program Files/Bill'Chen/node.exe", windowsPath: "C:/Program Files/Bill'Chen/node.exe", wsl: '' };
    const output = values => `unrelated startup text\r\n${probe.marker}\r\n${probe.fields.map(key => values[key]).join('\r\n')}\r\n${probe.marker}_END\r\nprompt`;
    const verified = verifyWindowsBash(output(msys), probe, entry, 'bash', ['-lc']);
    assert.equal(verified.family, 'msys');
    for (const [values, family] of [
      [{ ...msys, system: 'CYGWIN_NT-10.0', os: 'Cygwin' }, 'cygwin'],
      [{ ...msys, system: 'Linux', os: 'GNU/Linux', wsl: 'Ubuntu' }, 'wsl'],
      [{ ...msys, system: 'Linux', os: 'GNU/Linux' }, 'linux'],
      [{ ...msys, system: 'Darwin', os: 'Darwin' }, 'unknown'],
    ]) {
      assert.equal(parseBashProbe(output(values), probe).family, family);
      assert.throws(() => verifyWindowsBash(output(values), probe, entry, 'bash', ['-lc']), new RegExp(`detected ${family}.*MSYS-family Bash only`));
    }
    assert.throws(() => verifyWindowsBash(output({ ...msys, version: '' }), probe, entry, 'bash', []), /identity.*Bash version/);
    assert.throws(() => verifyWindowsBash(output({ ...msys, system: '', os: '' }), probe, entry, 'bash', []), /identity.*uname.*PATH/);
    assert.throws(() => verifyWindowsBash('truncated', probe, entry, 'bash', []), /identity.*incomplete/);
    assert.throws(() => verifyWindowsBash(output({ ...msys, windowsPath: 'D:/wrong' }), probe, entry, 'bash', []), /path conversion.*round-trip/);
    assert.throws(() => verifyWindowsBash(output({ ...msys, cygpath: '' }), probe, entry, 'bash', []), /path conversion/);

    const cleanups = [];
    const ctx = { effect: setup => cleanups.push(setup()) };
    let calls = 0;
    const runtime = createBashRuntime(ctx, async ({ signal, wait }) => {
      calls++;
      if (wait) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return verified;
    });
    const cancelled = new AbortController();
    const cancelledCall = assert.rejects(runtime.inspect({ signal: cancelled.signal, wait: true }), /cancel only this request/);
    await Promise.resolve();
    assert.equal(await runtime.inspect(), verified);
    cancelled.abort(new Error('cancel only this request'));
    await cancelledCall;
    assert.equal(await runtime.inspect(), verified, 'a cancelled request does not poison successful cached facts');
    assert.equal(calls, 2);
    await cleanups[0]();
    await assert.rejects(runtime.inspect(), /disposed/);
    const closingRuntime = createBashRuntime(ctx, ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const closingProbe = assert.rejects(closingRuntime.inspect(), /disposed/);
    await Promise.resolve();
    await cleanups[1]();
    await closingProbe;
    console.log('PASS: Bash PATH precedence, explicit-path failure, identity/family/round-trip validation and request-scoped cancellation');

    // A Unix Bash must be rejected by the Windows adapters, including direct execution
    // without prompt assembly. These are real process/PTY checks, not Windows acceptance.
    if (process.platform !== 'win32') {
      const hostRequire = createRequire(join(installation, 'package.json'));
      const load = name => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
      const [{ Context }, { default: Loader }, { Session, SessionId }, scope] = await Promise.all([load('cordis'), load('cordis-plugin-loader'), load('dsh-session'), load('dsh-scope')]);
      for (const persistent of [false, true]) {
        const root = new Context();
        root.baseUrl = pathToFileURL(join(installation, 'package.json')).href;
        try {
          await root.plugin(Loader, { baseUrl: pathToFileURL(join(installation, 'package.json')).href });
          for (const name of ['dsh-agent', 'dsh-session-projection', 'dsh-subprocess-local']) await root.plugin((await load(name)).default);
          await root.plugin((await load('dsh-sandbox-policy')).default, { mode: 'danger-full-access', workspaceRoot: scratch });
          if (persistent) await root.plugin((await load('dsh-terminal')).default);
          const id = SessionId(`runtime-probe-${persistent}`);
          const seed = Session.create(id);
          const agent = { id, session: Session.create(id, [], { ...seed.header, cwd: scratch }), options: {}, status: 'idle', send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() };
          agent.ctx = scope.createScope(root, agent).ctx;
          root.agents.register(agent);
          const handles = [];
          if (persistent) {
            const spawn = root.subprocess.spawnTerminal.bind(root.subprocess);
            root.subprocess.spawnTerminal = async spec => { const handle = await spawn(spec); handles.push(handle); return handle; };
          }
          await root.plugin(persistent ? windowsTerminal : { name: 'verify-windows-bash', inject: ['loader', 'subprocess'], apply: applyWindowsBash }, { shellPath: bashPath, timeoutMs: 10000 });
          if (!persistent) {
            const untouched = join(scratch, 'must-not-execute');
            await assert.rejects(() => root.shell.execute(root.shell.resolve({ command: `touch '${untouched}'`, workdir: scratch })), /compatibility.*MSYS-family Bash only/);
            assert.equal(existsSync(untouched), false);
          }
          await assert.rejects(() => root.get(BASH_RUNTIME_SERVICE).inspect(agent), /compatibility.*MSYS-family Bash only/);
          if (persistent) {
            assert.equal(root.terminals.list(agent).length, 0);
            assert.equal(handles.length, 1);
            await handles[0].done;
          }
        } finally { await root.fiber.dispose(); }
      }
      console.log('PASS: actual one-shot and PTY probes reject unsupported Bash; no user command runs and the rejected PTY exits');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
