/**
 * init/readline-io —— WizardIO 的默认终端实现 (pre-main, pi TUI 还没接管 stdin)。
 *
 * select = 编号菜单; ask = readline (secret 时静音回显); confirm = y/N。
 * 测试不走这条 (注入脚本化 WizardIO), 故这里只求 pragmatic 可用。
 */
import { createInterface } from 'node:readline';
import { fg, bold, dim } from '../branding/palette';
import type { WizardIO } from './wizard';

export function createReadlineIO(): WizardIO {
  const out = process.stdout;

  const question = (prompt: string, secret = false): Promise<string> =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (secret) {
        // 静音回显: 重写 _writeToOutput 只输出 prompt, 不回显输入字符。
        // @ts-expect-error 访问 readline 内部以静音 (公开 API 无静音选项)。
        rl._writeToOutput = (str: string) => {
          if (str.includes(prompt) || str === '\n' || str === '\r\n') out.write(str);
        };
      }
      rl.question(prompt, (answer) => {
        rl.close();
        if (secret) out.write('\n');
        resolve(answer);
      });
    });

  return {
    async select(label, options) {
      out.write(`\n${bold(fg('gold', label))}\n`);
      options.forEach((o, i) => out.write(`  ${fg('cinnabar', String(i + 1))}) ${fg('rice', o.label)}\n`));
      const ans = (await question(dim(fg('riceMuted', '选编号 (回车=1, 空行取消): ')))).trim();
      if (ans === '') return options[0]?.id;
      const idx = Number(ans) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return undefined;
      return options[idx]?.id;
    },
    async ask(q, opts) {
      const suffix = opts?.defaultValue ? dim(fg('riceMuted', ` [${opts.defaultValue}]`)) : '';
      const ans = (await question(`${fg('rice', q)}${suffix}: `, opts?.secret)).trim();
      return ans || opts?.defaultValue || '';
    },
    async confirm(q, defaultValue = false) {
      const hint = defaultValue ? 'Y/n' : 'y/N';
      const ans = (await question(`${fg('rice', q)} ${dim(fg('riceMuted', `(${hint})`))}: `)).trim().toLowerCase();
      if (ans === '') return defaultValue;
      return ans === 'y' || ans === 'yes';
    },
    note(message) {
      out.write(`${message}\n`);
    },
  };
}
