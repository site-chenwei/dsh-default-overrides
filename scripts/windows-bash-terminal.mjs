import { BASH_RUNTIME_SERVICE, resolveWindowsBash, createBashProbe, verifyWindowsBash, createBashRuntime, withBashProbeDeadline, probeBashTerminal, bashDiagnostic } from './bash-runtime.mjs';

export const name = 'windows-bash-terminal';
export const inject = ['loader', 'terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess'];

// Note: 仅薄封装公开 PTY 后端，命令和会话状态仍由官方工具持有 — 见 .agents/notes/implemented/feature/2026-09-25-verified-windows-bash.md。
export async function apply(ctx, config) {
  const entry = resolveWindowsBash(config.shellPath, 'persistent-bash');
  const { BashTerminalBackend, Config } = await ctx.loader.import('@deepseek-ai/dsh-terminal-bash');
  const { TerminalBackendCleanupError } = await ctx.loader.import('@deepseek-ai/dsh-terminal');
  // Note: 必须在本行的 ctx 上直接注册，嵌套 ctx 拿不到隔离域内的 terminals — 见 .agents/notes/implemented/bug-fix/2026-10-08-isolated-terminal-realm.md。
  const validated = Config['~standard'].validate(config);
  if (validated.issues) throw new Error(`windows-bash-terminal: ${validated.issues.map(issue => issue.message ?? String(issue)).join('; ')}`);
  const resolved = validated.value;
  const startupArgs = resolved.shellArgs?.length ? resolved.shellArgs : ['--noprofile', '--norc', '-i'];
  const factsByOwner = new WeakMap();
  class VerifiedBashBackend extends BashTerminalBackend {
    async spawn(spec) {
      return withBashProbeDeadline(spec.signal, async signal => {
        let session;
        try { session = await super.spawn({ ...spec, signal }); }
        catch (error) {
          if (error instanceof TerminalBackendCleanupError) throw error;
          throw bashDiagnostic(entry, 'persistent-bash', 'PTY startup', error.message, error);
        }
        try {
          const probe = createBashProbe();
          let output;
          try { output = await probeBashTerminal(session, probe, signal); }
          catch (error) { throw bashDiagnostic(entry, 'persistent-bash', 'PTY probe', error.message, error); }
          factsByOwner.set(spec.owner, verifyWindowsBash(output, probe, entry, 'persistent-bash', startupArgs));
          return session;
        } catch (error) {
          try { await session.close('Bash verification failed'); }
          catch (cleanupError) { throw new TerminalBackendCleanupError(error, cleanupError); }
          throw error;
        }
      });
    }
  }
  const backend = new VerifiedBashBackend(ctx, { ...resolved, shellDialect: 'bash', shellPath: entry.executable, shellArgs: startupArgs });
  ctx.terminals.registerBackend(backend);
  const runtime = createBashRuntime(ctx, async ({ agent, signal }) => {
    // 官方持久化工具惰性创建自己的会话。临时会话走同一后端，验证后立即关闭。
    const session = await ctx.terminals.spawn(agent, { type: backend.type, cwd: agent.session.header.cwd }, signal);
    try { return factsByOwner.get(agent); }
    finally { await ctx.terminals.kill(agent, session.sessionId, 'Bash environment probe completed'); }
  });
  ctx.provide(BASH_RUNTIME_SERVICE, {
    inspect: (agent, signal) => runtime.inspect({ agent, signal }),
  });
}
