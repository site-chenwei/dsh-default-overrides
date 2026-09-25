import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Note: 只改整个简单路径词，复杂语法整条透传以保留 Shell 结构 — 见 .agents/notes/implemented/feature/2026-09-25-option-applicability-and-command-safety.md。
const WORD_BREAK = /[\s;|&<>]/;
const DRIVE_PATH = /^[A-Za-z]:\\/;

/** 一个完整的简单词可以整体引用；混合引用、展开和转义元字符不属于路径参数。 */
function normalizeWord(word) {
  const quote = word[0] === "'" || word[0] === '"' ? word[0] : '';
  const path = quote ? word.slice(1, -1) : word;
  if (!DRIVE_PATH.test(path)) return word;
  // 引用、展开与转义元字符原样保留，避免替换反斜杠后改变 Bash 的解析。
  if (/["'`$<>|?*\r\n]/.test(path) || /\\[\\\s;&(){}\[\]!#~]/.test(path)) return word;
  if (!quote && /[\s;&(){}\[\]!#~]/.test(path)) return word;
  return `${quote}${path.replaceAll('\\', '/')}${quote}`;
}

/**
 * 只纠正简单参数中的 Windows 盘符路径。
 * 不解析展开、heredoc、复合语法或转义引号；整条命令保持原样，避免部分改写后改变语法。
 */
export function normalizeWindowsPaths(command) {
  let out = '';
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (WORD_BREAK.test(char)) {
      if (command.startsWith('<<', index)) return command;
      out += char;
      index += 1;
      continue;
    }
    if (char === '#') {
      const end = command.indexOf('\n', index);
      if (end === -1) return out + command.slice(index);
      out += command.slice(index, end);
      index = end;
      continue;
    }
    const start = index;
    let quote = '';
    while (index < command.length) {
      const current = command[index];
      if (!quote && WORD_BREAK.test(current)) break;
      if (quote !== "'" && /[$`(){}]/.test(current)) return command;
      if (current === '\\' && quote !== "'") {
        const next = command[index + 1];
        if (next === undefined || /[\s"'`$\\;|&<>(){}]/.test(next)) return command;
        index += 2;
        continue;
      }
      if (!quote && (current === "'" || current === '"')) quote = current;
      else if (current === quote) quote = '';
      index += 1;
    }
    if (quote) return command;
    const word = command.slice(start, index);
    // 只接受无引用的词，或被一对引号完整包裹的词；拼接引用原样保留。
    const quoted = word[0] === "'" || word[0] === '"';
    const body = quoted ? word.slice(1, -1) : word;
    out += /["']/.test(body) ? word : normalizeWord(word);
  }
  return out;
}

// CLI：垫片用它把 stdin 的命令写回 stdout；导入本模块时不会触发。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(normalizeWindowsPaths(Buffer.concat(chunks).toString('utf8')));
}
