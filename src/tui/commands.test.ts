/**
 * L1 判据:命令清单与 `/help`(2026-08-07)。
 *
 * ★ 最要紧的一条是**接线闸**:清单是给人看的一张表,分发是 `tui.ts` 里的前缀判断 ——
 * 两处会漂。漂了的症状是 `/help` 列出一条**打了没反应**的命令,
 * 或者装了一条命令但清单里没有(= 发现不了,等于没装)。所以两个方向都查。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, COMMAND_NAMES, STARTUP_HINT, formatHelp, parseHelpCommand } from './commands';

const TUI_SRC = readFileSync(join(import.meta.dir, 'tui.ts'), 'utf8');

describe('★ 接线闸:清单 ↔ 分发,两个方向都查', () => {
  // 反向自检 (2026-08-07 实跑): 从 COMMANDS 里删掉 /runs → 「装了但没列」当场红;
  // 往 COMMANDS 里加一条 tui.ts 不认的 /nope → 「列了但没接」当场红。
  test('★ 清单里每条命令, tui.ts 里都真的**调了它的 handler**', () => {
    // ⚠ 第一版这条是靠"命令名在 tui.ts 里出现过"判的 —— 而 `/seat` `/skill` 的解析器
    //   住在别的文件里, 它们只在**注释**里出现。于是那条闸靠注释蒙混过关:
    //   把 handler 删掉、注释留着, 它照样绿。加 `/session` 时它才终于红。
    //   现在钉的是**真正的分发点**(`CommandDoc.handler`), 注释帮不了忙。
    // ⚠⚠ 第二版仍然不够:正则会匹配到**函数定义**(`async function handleSession(`)——
    //     一个定义了却从没被调用的 handler 照样绿。证伪时把调用点删掉、定义留着, 它纹丝不动。
    //     ⇒ 先把定义整行剔掉, 剩下的才是**调用点**。(同一条闸收紧了三次, 每次都是被证伪逼的。)
    const callSites = TUI_SRC.replace(/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/gm, '');
    const unwired = COMMANDS.filter((c) => !new RegExp(`\\b${c.handler}\\s*\\(`).test(callSites));
    expect(unwired.map((c) => c.name), '这些命令列在 /help 里但 tui.ts 没**调用**它的 handler').toEqual([]);
  });

  test('★ tui.ts 里接了的命令, 清单里都要有(没列 = 发现不了 = 等于没装)', () => {
    // `startsWith('/xxx')` / `=== '/xxx'` 这两种形状是分发的全部写法(含被调用的解析器)。
    const wired = new Set<string>();
    for (const m of TUI_SRC.matchAll(/['"](\/[a-z]+)['" ]/g)) wired.add(m[1] as string);
    // 解析器住在别的文件里, 名字在那边 —— 这里只查 tui.ts 直接出现的。
    const missing = [...wired].filter((n) => !COMMAND_NAMES.includes(n));
    expect(missing, '这些命令接了但没列进 /help').toEqual([]);
  });
});

describe('parseHelpCommand', () => {
  test('/help 与两个常见别名都认', () => {
    for (const t of ['/help', '/?', '/h', '  /help  ']) expect(parseHelpCommand(t)).toBe(true);
  });

  test('别的一律不接管', () => {
    for (const t of ['help', '/helper', '/seat', '帮我看看']) expect(parseHelpCommand(t)).toBe(false);
  });
});

describe('formatHelp', () => {
  test('每条命令都出现', () => {
    const out = formatHelp();
    for (const c of COMMANDS) expect(out).toContain(c.name);
  });

  test('★ 有副作用的命令要说出来 —— 改文件和只读列表不是一回事', () => {
    const out = formatHelp();
    expect(out).toContain('有副作用');
    // /seat 与 /resume 是仅有的两条会改东西的
    expect(COMMANDS.filter((c) => c.what.includes('副作用')).map((c) => c.name)).toEqual(['/seat', '/resume']);
  });

  test('提到文件补全 —— 那条能力没有命令, 不说就没人知道', () => {
    expect(formatHelp()).toContain('模糊补全');
  });
});

describe('★ 启动提示必须提到 /help', () => {
  test('否则四条命令仍然发现不了 —— 这一条就是这一片存在的理由', () => {
    expect(STARTUP_HINT).toContain('/help');
  });

  test('tui.ts 的 hint 用的就是它(不是另写一句)', () => {
    expect(TUI_SRC).toContain('hint: STARTUP_HINT');
  });
});
