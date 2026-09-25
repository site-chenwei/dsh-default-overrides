import { statSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

// Note: 入口、真实通道探测与模型指引共享事实；不猜安装位置 — 见 .agents/notes/implemented/feature/2026-09-25-verified-windows-bash.md。
export const BASH_RUNTIME_SERVICE = 'dshBashRuntime';
// 与宿主 PTY 默认截止时间一致，避免探测沿用五分钟命令预算。
export const BASH_PROBE_TIMEOUT_MS = 30000;

export function bashDiagnostic(entry, mode, stage, detail, cause) {
  return new Error(`dsh-default-overrides: ${mode} Bash ${stage} failed (source=${entry.source}, executable=${JSON.stringify(entry.executable)}): ${detail}`, cause === undefined ? undefined : { cause });
}

export function resolveWindowsBash(shellPath, mode, environment = process.env) {
  const isFile = path => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  if (shellPath !== undefined) {
    const entry = { executable: shellPath, source: 'bashPath' };
    if (typeof shellPath !== 'string' || !isAbsolute(shellPath) || !isFile(shellPath)) {
      throw bashDiagnostic(entry, mode, 'resolution', 'bashPath must be an existing absolute Bash executable; no fallback was attempted');
    }
    return { ...entry, executable: resolve(shellPath) };
  }
  // Windows 环境键不区分大小写；与 Node 的重复键选择顺序一致。
  const pathKey = Object.keys(environment).sort().find(key => key.toLowerCase() === 'path');
  for (const directory of (environment[pathKey] ?? '').split(';').filter(Boolean)) {
    const candidate = resolve(join(directory.replace(/^"(.*)"$/, '$1'), 'bash.exe'));
    if (isFile(candidate)) return { executable: candidate, source: 'PATH' };
  }
  throw bashDiagnostic({ executable: 'bash.exe', source: 'PATH' }, mode, 'resolution', 'no bash.exe found on the host PATH; configure bashPath explicitly');
}

function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** 固定只读命令；路径按数据引用，不通过命令归一化器。 */
export function createBashProbe(nativePath = process.execPath) {
  const marker = `DSH_BASH_PROBE_${randomUUID().replaceAll('-', '')}`;
  const fields = ['version', 'system', 'os', 'cygpath', 'unixPath', 'windowsPath', 'wsl'];
  const command = `( ${[
    "__dsh_probe_unix=''; __dsh_probe_windows=''",
    "__dsh_probe_cygpath=$(type -P cygpath) || __dsh_probe_cygpath=''",
    `if [[ -n $__dsh_probe_cygpath ]]; then if __dsh_probe_unix=$("$__dsh_probe_cygpath" -u -- ${quote(nativePath)}); then __dsh_probe_windows=$("$__dsh_probe_cygpath" -m -- "$__dsh_probe_unix") || __dsh_probe_windows=''; fi; fi`,
    `printf '\\n${marker}\\n${fields.map(() => '%s\\n').join('')}${marker}_END\\n' "\${BASH_VERSION-}" "$(uname -s)" "$(uname -o 2>/dev/null || :)" "$__dsh_probe_cygpath" "$__dsh_probe_unix" "$__dsh_probe_windows" "\${WSL_DISTRO_NAME-\${WSL_INTEROP-}}"`,
  ].join('; ')} )`;
  return { command, marker, fields, nativePath };
}

export function parseBashProbe(output, probe) {
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.indexOf(probe.marker);
  const end = lines.indexOf(`${probe.marker}_END`, start + 1);
  if (start < 0 || end - start !== probe.fields.length + 1) throw new Error('missing or incomplete Bash probe record');
  const facts = Object.fromEntries(probe.fields.map((key, index) => [key, lines[start + index + 1]]));
  if (!/^\d+\.\d+/.test(facts.version)) throw new Error('the selected entry did not report a Bash version');
  if (!facts.system) throw new Error('uname -s did not report a system type; check the Bash startup PATH');
  const family = facts.os === 'Msys' || /^(?:MSYS|MINGW32|MINGW64)_NT-/.test(facts.system) ? 'msys'
    : facts.os === 'Cygwin' || /^CYGWIN_NT-/.test(facts.system) ? 'cygwin'
      : facts.system === 'Linux' ? (facts.wsl ? 'wsl' : 'linux') : 'unknown';
  return { ...facts, family };
}

export function verifyWindowsBash(output, probe, entry, mode, startupArgs) {
  let facts;
  try { facts = parseBashProbe(output, probe); }
  catch (error) { throw bashDiagnostic(entry, mode, 'identity', `${error.message}; output=${JSON.stringify(output.slice(-4096))}`, error); }
  if (facts.family !== 'msys') {
    throw bashDiagnostic(entry, mode, 'compatibility', `detected ${facts.family} (${facts.system}, Bash ${facts.version}); this Windows backend currently supports MSYS-family Bash only; configure a supported bashPath`);
  }
  if (!facts.cygpath || !facts.unixPath.startsWith('/') || win32.normalize(facts.windowsPath).toLowerCase() !== win32.normalize(probe.nativePath).toLowerCase()) {
    throw bashDiagnostic(entry, mode, 'path conversion', `cygpath could not round-trip the host executable path; check the selected Bash initialization and cygpath availability; output=${JSON.stringify(output.slice(-4096))}`);
  }
  return { ...entry, mode, startupArgs: [...startupArgs], ...facts };
}

/** 请求各自拥有取消信号；只缓存成功事实，不让一次取消毒化后续装配。 */
export function createBashRuntime(ctx, inspect) {
  let facts;
  const lifecycle = new AbortController();
  const active = new Set();
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Bash runtime disposed'));
    await Promise.allSettled([...active]);
  });
  return {
    async inspect(request = {}) {
      request.signal?.throwIfAborted();
      lifecycle.signal.throwIfAborted();
      if (facts) return facts;
      const signal = request.signal ? AbortSignal.any([request.signal, lifecycle.signal]) : lifecycle.signal;
      const operation = Promise.resolve().then(() => inspect({ ...request, signal }));
      active.add(operation);
      try {
        const result = await operation;
        signal.throwIfAborted();
        facts = result;
        return facts;
      } finally { active.delete(operation); }
    },
  };
}

/** PTY 从启动到探测结束使用同一短预算，计时器不会控制返回后的终端。 */
export async function withBashProbeDeadline(signal, operation) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`Bash probe timed out after ${BASH_PROBE_TIMEOUT_MS} ms`)), BASH_PROBE_TIMEOUT_MS);
  try { return await operation(signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal); }
  finally { clearTimeout(timer); }
}

/** 读取后端的真实终端，保留官方的 prompt、发送和滚动输出协议。 */
export async function probeBashTerminal(session, probe, signal) {
  const result = await session.startSend({ text: probe.command, submit: true, signal }).done;
  signal?.throwIfAborted();
  if (result.sessionStatus.kind === 'exited' || result.waitReason === 'timeout') {
    throw new Error(`Bash probe ended with ${result.waitReason}: ${result.viewport}`);
  }
  return session.read({ offset: 0, count: 100 }).text;
}

export function bashRuntimeDescription(facts) {
  return `Verified Bash environment: MSYS (${facts.system}), Bash ${facts.version}. Entry: ${JSON.stringify(facts.executable)} from ${facts.source}. Startup arguments: ${JSON.stringify(facts.startupArgs)}. cygpath conversion was verified.`;
}

export function bashPathGuidance(facts) {
  const common = 'Use Bash quoting. Prefer relative filesystem paths and forward slashes; quote literal arguments. Single quotes preserve backslashes. Do not rewrite code, regular expressions, printf formats or data strings as filesystem paths.';
  return facts ? `${common} In this MSYS environment, use cygpath when explicit Unix/Windows path conversion is needed. Native Windows programs may receive MSYS-converted arguments and environment variables. Preserve container and remote paths; scope MSYS2_ARG_CONV_EXCL or MSYS2_ENV_CONV_EXCL to the specific command when necessary, rather than disabling conversion globally.` : common;
}
