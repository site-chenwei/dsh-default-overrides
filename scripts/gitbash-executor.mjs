import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { normalizeWindowsPaths } from './command-paths.mjs';
import { BASH_RUNTIME_SERVICE, BASH_PROBE_TIMEOUT_MS, resolveWindowsBash, createBashProbe, verifyWindowsBash, createBashRuntime, bashDiagnostic } from './bash-runtime.mjs';

export const name = 'gitbash-executor';
export const inject = ['loader', 'subprocess'];

// Note: 仅替换 argv，生命周期沿用官方执行器 — 见 .agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md。
// Note: 非 Windows 未配置 shellPath 时沿用官方默认 argv — 见 .agents/notes/implemented/feature/2026-09-24-optional-shell-paths.md。
export async function apply(ctx, config) {
  if (process.platform === 'win32') return applyWindowsBash(ctx, config);
  const { shellPath, normalizeWindowsPaths: rewritePaths, ...executorConfig } = config;
  if (shellPath !== undefined && (typeof shellPath !== 'string' || !isAbsolute(shellPath) || !existsSync(shellPath) || !statSync(shellPath).isFile())) {
    throw new Error('gitbash-executor: shellPath must name an existing absolute bash executable');
  }
  const { LocalBashExecutor } = await ctx.loader.import('@deepseek-ai/dsh-bash-local');
  class GitBashExecutor extends LocalBashExecutor {
    execute(spec) {
      const command = rewritePaths === true ? normalizeWindowsPaths(spec.command) : spec.command;
      // 没有显式路径时不猜路径：交给官方 execute 的默认 argv（bash -c）。
      if (shellPath === undefined) return super.execute({ ...spec, command });
      return this.executeArgv({ ...spec, command }, [shellPath, '-lc', command]);
    }
  }
  await ctx.plugin(GitBashExecutor, {
    timeoutMs: 300000,
    maxOutputBytes: 256 * 1024,
    ...executorConfig,
  });
}

// Note: 预检与命令固定到同一入口，准备阶段沿用官方截止和后台失败语义 — 见 .agents/notes/implemented/feature/2026-09-25-verified-windows-bash.md。
export async function applyWindowsBash(ctx, config) {
  const { shellPath, normalizeWindowsPaths: rewritePaths, ...executorConfig } = config;
  const entry = resolveWindowsBash(shellPath, 'bash');
  const startupArgs = ['-lc'];
  const { LocalBashExecutor } = await ctx.loader.import('@deepseek-ai/dsh-bash-local');
  let runtime;
  let executor;
  class VerifiedBashExecutor extends LocalBashExecutor {
    constructor(executorCtx, executorConfig) {
      super(executorCtx, executorConfig);
      executor = this;
    }
    execute(spec) {
      const command = rewritePaths === true ? normalizeWindowsPaths(spec.command) : spec.command;
      return this.executeArgv({ ...spec, command }, async signal => {
        await runtime.inspect({ ...spec, signal });
        return [entry.executable, ...startupArgs, command];
      });
    }
  }
  await ctx.plugin(VerifiedBashExecutor, { timeoutMs: 300000, maxOutputBytes: 256 * 1024, ...executorConfig });
  runtime = createBashRuntime(ctx, async request => {
    const probe = createBashProbe();
    const spec = executor.resolve({
      command: probe.command, workdir: request.workdir,
      timeoutMs: BASH_PROBE_TIMEOUT_MS, onExpiry: 'kill', signal: request.signal,
      dshEnv: request.dshEnv, sandboxPolicy: request.sandboxPolicy,
    });
    let result;
    try { result = await (await executor.executeArgv(spec, [entry.executable, ...startupArgs, probe.command])).result(); }
    catch (error) { throw bashDiagnostic(entry, 'bash', 'startup/probe', error.message, error); }
    request.signal.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw bashDiagnostic(entry, 'bash', 'startup/probe', `exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}; ${result.stderr.text || result.stdout.text}`);
    }
    return verifyWindowsBash(result.stdout.text + result.stderr.text, probe, entry, 'bash', startupArgs);
  });
  ctx.provide(BASH_RUNTIME_SERVICE, {
    inspect: (agent, signal) => runtime.inspect({ workdir: agent.session.header.cwd, signal }),
  });
}
