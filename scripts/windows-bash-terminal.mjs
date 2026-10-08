import { BASH_RUNTIME_SERVICE, BASH_PROBE_TIMEOUT_MS, resolveWindowsBash, createBashProbe, verifyWindowsBash, createBashRuntime, withBashProbeDeadline, bashDiagnostic } from './bash-runtime.mjs';

export const name = 'windows-bash-terminal';
export const inject = ['loader', 'terminals', 'shell', 'sandboxPolicy', 'sessionProjections', 'subprocess'];

// Note: 仅薄封装公开 PTY 后端，命令和会话状态仍由官方工具持有 — 见 .agents/notes/implemented/feature/2026-09-25-verified-windows-bash.md。
// Note: 环境事实走组内隔离的一次性执行器，不再向 PTY 写探测命令 — 见 .agents/notes/implemented/feature/2026-10-08-pipe-bash-probe.md。
export async function apply(ctx, config) {
  const entry = resolveWindowsBash(config.shellPath, 'persistent-bash');
  const { BashTerminalBackend, Config } = await ctx.loader.import('@deepseek-ai/dsh-terminal-bash');
  const { TerminalBackendCleanupError } = await ctx.loader.import('@deepseek-ai/dsh-terminal');
  // Note: 必须在本行的 ctx 上直接注册，嵌套 ctx 拿不到隔离域内的 terminals — 见 .agents/notes/implemented/bug-fix/2026-10-08-isolated-terminal-realm.md。
  const validated = Config['~standard'].validate(config);
  if (validated.issues) throw new Error(`windows-bash-terminal: ${validated.issues.map(issue => issue.message ?? String(issue)).join('; ')}`);
  const resolved = validated.value;
  const startupArgs = resolved.shellArgs?.length ? resolved.shellArgs : ['--noprofile', '--norc', '-i'];
  class VerifiedBashBackend extends BashTerminalBackend {
    async spawn(spec) {
      return withBashProbeDeadline(spec.signal, async signal => {
        try { return await super.spawn({ ...spec, signal }); }
        catch (error) {
          if (error instanceof TerminalBackendCleanupError) throw error;
          throw bashDiagnostic(entry, 'persistent-bash', 'PTY startup', error.message, error);
        }
      });
    }
  }
  const backend = new VerifiedBashBackend(ctx, { ...resolved, shellDialect: 'bash', shellPath: entry.executable, shellArgs: startupArgs });
  ctx.terminals.registerBackend(backend);
  const runtime = createBashRuntime(ctx, async request => {
    // 探测沿用与持久化通道相同的免 profile 启动，只差交互模式；事实描述的是这个入口的实际环境。
    const probe = createBashProbe();
    const spec = ctx.shell.resolve({
      command: probe.command, workdir: request.workdir,
      timeoutMs: BASH_PROBE_TIMEOUT_MS, onExpiry: 'kill', signal: request.signal,
    });
    let result;
    try { result = await (await ctx.shell.executeArgv(spec, [entry.executable, '--noprofile', '--norc', '-c', probe.command])).result(); }
    catch (error) { throw bashDiagnostic(entry, 'persistent-bash', 'environment probe', error.message, error); }
    request.signal.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw bashDiagnostic(entry, 'persistent-bash', 'environment probe', `exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}; ${result.stderr.text || result.stdout.text}`);
    }
    return verifyWindowsBash(result.stdout.text + result.stderr.text, probe, entry, 'persistent-bash', startupArgs);
  });
  ctx.provide(BASH_RUNTIME_SERVICE, {
    inspect: (agent, signal) => runtime.inspect({ workdir: agent.session.header.cwd, signal }),
  });
}
