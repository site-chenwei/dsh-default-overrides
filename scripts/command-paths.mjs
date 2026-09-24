import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Note: 命令归一化的唯一样板，供一次性适配器与持久化 eval 垫片共用 — 见 .agents/notes/implemented/feature/2026-09-24-windows-path-normalization.md。

/** 引号外遇到这些字符就结束路径段；引号内以配对引号为界。 */
const OUTSIDE_DELIMITERS = /[\s'"`;|&<>()]/;

/** 判断 index 处是否是 `X:\` 形式的盘符前缀（排除标识符中间）。 */
function drivePrefixAt(text, index) {
  if (index > 0 && /[A-Za-z0-9_]/.test(text[index - 1])) return false;
  return /[A-Za-z]/.test(text[index] ?? '') && text[index + 1] === ':' && text[index + 2] === '\\';
}

/** 路径段结束位置：引号内到配对引号，引号外到空白或 shell 元字符。 */
function tokenEnd(text, start, quote) {
  let end = start;
  while (end < text.length) {
    const char = text[end];
    if (quote === '') {
      if (OUTSIDE_DELIMITERS.test(char)) break;
    } else if (char === quote) break;
    end += 1;
  }
  return end;
}

/**
 * 把形如 `C:\Users\name` 的 Windows 路径改写为 `C:/Users/name`。
 * 只改写盘符开头的路径段，正则、转义等其他反斜杠保持原样。
 * @param {string} command - 模型给出的原始命令文本。
 * @returns {string} bash 解析后仍能拿到反斜杠的等价命令。
 */
export function normalizeWindowsPaths(command) {
  let out = '';
  let index = 0;
  let quote = '';
  while (index < command.length) {
    if (drivePrefixAt(command, index)) {
      const end = tokenEnd(command, index, quote);
      out += command.slice(index, end).replaceAll('\\', '/');
      index = end;
      continue;
    }
    const char = command[index];
    if (quote === '' && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = '';
    out += char;
    index += 1;
  }
  return out;
}

// CLI：垫片用它把 stdin 的命令写回 stdout；导入本模块时不会触发。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(normalizeWindowsPaths(Buffer.concat(chunks).toString('utf8')));
}
