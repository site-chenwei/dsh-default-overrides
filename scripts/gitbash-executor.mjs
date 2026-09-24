import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { normalizeWindowsPaths } from './command-paths.mjs';

export const name = 'gitbash-executor';
export const inject = ['loader', 'subprocess'];

// Note: 仅替换 argv，生命周期沿用官方执行器 — 见 .agents/notes/implemented/bug-fix/2026-09-24-shell-channel-runtime-contracts.md。
// Note: normalizeWindowsPaths 在 bash 解析前改写命令文本 — 见 .agents/notes/implemented/feature/2026-09-24-windows-path-normalization.md。
export async function apply(ctx, config) {
  const { shellPath, normalizeWindowsPaths: rewritePaths, ...executorConfig } = config;
  if (typeof shellPath !== 'string' || !isAbsolute(shellPath) || !existsSync(shellPath) || !statSync(shellPath).isFile()) {
    throw new Error('gitbash-executor: shellPath must name an existing absolute bash executable');
  }
  const { LocalBashExecutor } = await ctx.loader.import('@deepseek-ai/dsh-bash-local');
  class GitBashExecutor extends LocalBashExecutor {
    execute(spec) {
      const command = rewritePaths === true ? normalizeWindowsPaths(spec.command) : spec.command;
      return this.executeArgv({ ...spec, command }, [shellPath, '-lc', command]);
    }
  }
  await ctx.plugin(GitBashExecutor, {
    timeoutMs: 300000,
    maxOutputBytes: 256 * 1024,
    ...executorConfig,
  });
}
