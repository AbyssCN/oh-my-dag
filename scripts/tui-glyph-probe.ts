/**
 * scripts/tui-glyph-probe —— **字形宽度探针**(TUI SDD §7.5.2,切片 S6)。
 *
 * 这个文件**只做 IO**:调 python 拿第二套读数、(可选)问真终端拿第三套、把结果印成表
 * 或生成 `src/tui/render/glyph-table.ts`。判定规则与候选集都在
 * `src/tui/render/glyphs.ts` —— 规则与数据分家会漂,而且那样这个脚本就成了唯一持有
 * "什么算安全"的地方,别的代码想复用只能再抄一份。
 *
 * ## 它在量什么
 *
 * 一个字形在终端里占几列,**没有一个所有人都同意的答案**。至少三套读数:
 *   ① pi-tui `visibleWidth()` —— 我们排版时用的那把尺子;
 *   ② Unicode East Asian Width —— 独立实现(python `unicodedata`),与 ① 无共享代码;
 *   ③ **用户那台终端 + 那套字体实际画了几列** —— 唯一的真值。
 *
 * ## ⚠ 关于 ③:自动化 lane 里量不到,所以不假装量到了
 *
 * 真值要靠终端回答 `CSI 6n`。**`node-pty` 给的是伪终端设备,后面没有终端模拟器** ——
 * 没有人会回答。所以想要 ③ 必须**在真终端里手跑** `--tty`;不在 TTY 里就明说没量到,
 * 而不是拿 ② 冒充 ③。量不到的那一格写"未量",填一个看起来很像的数会让整张表失去意义。
 *
 * ⚠ **自举**:本脚本经 `glyphs.ts` 间接 import 它自己生成的 `glyph-table.ts`,
 * 所以那个文件即使过期也得在(它进版本库正是为此)。真丢了就先从 git 取回再重新生成。
 *
 * 用法(`bun run scripts/tui-glyph-probe.ts [flags]`):
 *   (无)         ①② 自动比对,印 markdown 表
 *   --tty        在真终端里加量 ③
 *   --json       机读输出
 *   --emit-ts    生成 `src/tui/render/glyph-table.ts`
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { execFileSync } from 'node:child_process';
import { GLYPH_CANDIDATES, decideVerdict } from '../src/tui/render/glyphs';

// ---------------------------------------------------------------------------
// 读数 ②:独立实现(python unicodedata)—— 与 pi-tui 不共用任何代码
// ---------------------------------------------------------------------------

/**
 * 逐码点按 wcwidth 的规则求和,歧义宽度**单独报 `'A'` 不折算成数**。
 *
 * 把 Ambiguous 压成 1 或 2 都是在替用户的终端做决定 —— 而这一格的正确答案就是"看情况",
 * 压成一个数正好把探针要抓的东西抹掉了。
 */
function pythonWidths(glyphs: string[]): (number | 'A')[] {
  const src = `
import sys, json, unicodedata
out = []
for s in json.load(sys.stdin):
    total = 0
    ambiguous = False
    for ch in s:
        if ch in ('\\u200d', '\\ufe0f', '\\ufe0e'):   # ZWJ / 变体选择符
            continue
        if unicodedata.combining(ch) or unicodedata.category(ch) in ('Mn', 'Me', 'Cf'):
            continue
        w = unicodedata.east_asian_width(ch)
        if w == 'A':
            ambiguous = True
            total += 1
        elif w in ('W', 'F'):
            total += 2
        else:
            total += 1
    out.append('A' if ambiguous else total)
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', src], { input: JSON.stringify(glyphs), encoding: 'utf8' }));
}

// ---------------------------------------------------------------------------
// 读数 ③:真终端 —— 只在 stdin 是 TTY 时可用
// ---------------------------------------------------------------------------

/**
 * @returns 每个字形实际推进的列数;拿不到真终端时返回 `null`(**不是 0,不是猜的数**)。
 *
 * ⚠ 走 **`/dev/tty` 而不是 stdin/stdout**。第一版用 `process.stdin.isTTY` 判断 +
 * 往 stdout 写 `CSI 6n` —— 那样 `--tty --json > out.json` 会把转义序列写进**文件**,
 * 终端根本没收到,于是"量不到"。而 `--json` 重定向恰恰是自动化取这份读数的唯一办法
 * (实测踩到:窗口开起来了、退出码 0、`groundTruth` 还是 false)。
 * `/dev/tty` 永远指向控制终端,与重定向无关。
 */
async function terminalWidths(glyphs: string[]): Promise<number[] | null> {
  const { openSync, writeSync } = await import('node:fs');
  const tty = await import('node:tty');
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return null; // 没有控制终端 (CI / 管道里跑) → 明说没量到
  }
  const input = new tty.ReadStream(fd);
  const restore = (): void => {
    try {
      input.setRawMode(false);
      // ⚠ **只 destroy,不再 closeSync(fd)**:ReadStream 拥有这个 fd,destroy 已经关掉它,
      // 再关一次是 `EBADF`。而那个错是**流拆解时异步抛的**,落不进这里的 try ——
      // 实测症状:第一条命令 `process.exit(0)` 抢在它前面所以看不见,第二条命令退出码变 1。
      input.destroy();
    } catch {
      /* 清理不是判据 */
    }
  };
  try {
    input.setRawMode(true);
  } catch {
    restore();
    return null; // 不是真终端 (fd 打得开但不支持 termios)
  }

  const readCol = (): Promise<number | null> =>
    new Promise((resolve) => {
      let buf = '';
      const timer = setTimeout(() => {
        input.off('data', onData);
        resolve(null); // ⚠ 超时返回 null 不是 0 —— 「没人回答」与「第 0 列」是两件事
      }, 2000);
      const onData = (d: Buffer): void => {
        buf += d.toString();
        const m = /\x1b\[\d+;(\d+)R/.exec(buf);
        if (m) {
          clearTimeout(timer);
          input.off('data', onData);
          resolve(Number(m[1]));
        }
      };
      input.on('data', onData);
      writeSync(fd, '\x1b[6n');
    });

  const out: number[] = [];
  try {
    for (const g of glyphs) {
      writeSync(fd, '\r\x1b[2K');
      const before = await readCol();
      if (before === null) return null; // 终端不答 6n → 整份读数作废, 不拿半份充数
      writeSync(fd, g);
      const after = await readCol();
      if (after === null) return null;
      out.push(after - before);
    }
    writeSync(fd, '\r\x1b[2K');
    return out;
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// 比对
// ---------------------------------------------------------------------------

/**
 * 真终端读数的**出处**。「已量」不能是一句没有来源的断言 —— 这份读数只对**这套终端 + 这套字体**
 * 成立(Nerd Font 私用区只有 `Mono` 变体才是 1 列;歧义宽度只有非 CJK locale 才是 1 列)。
 * 换机器要重量,而重量之前得知道上一次是在哪量的。
 */
function provenance(): string {
  const bits = [
    process.env.WT_SESSION ? 'Windows Terminal' : undefined,
    process.env.TERM_PROGRAM,
    process.env.TERM,
    process.env.LANG,
    process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : '(环境变量里看不出终端身份)';
}

const flat = GLYPH_CANDIDATES.flatMap((c) => c.glyphs.map((g) => ({ group: c.group, glyph: g })));
const py = pythonWidths(flat.map((f) => f.glyph));
const tty = process.argv.includes('--tty') ? await terminalWidths(flat.map((f) => f.glyph)) : null;

const codepointsOf = (s: string) =>
  [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

const rows = flat.map((f, i) => {
  const pi = visibleWidth(f.glyph);
  const unicode = py[i] as number | 'A';
  const term = tty ? (tty[i] as number) : null;
  const { verdict, why } = decideVerdict(f.group, pi, unicode, term);
  return { group: f.group, glyph: f.glyph, codepoints: codepointsOf(f.glyph), pi, unicode, term, verdict, why };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ groundTruth: tty !== null, rows }, null, 2));
  process.exit(0);
}

/**
 * `--emit-ts`:把读数**生成**成 `src/tui/render/glyph-table.ts`。
 *
 * 手抄 74 行码点是必错的;生成的话,pi-tui 升级后重跑一条命令就能看出哪一格变了
 * (diff 自己就是读数对比)。⇒ **别手改那个文件**。
 */
if (process.argv.includes('--emit-ts')) {
  const esc = (s: string) =>
    [...s]
      .map((c) => ((c.codePointAt(0) ?? 0) < 0x7f && c !== '\\' && c !== "'" ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`))
      .join('');
  const list = (v: string) =>
    rows
      .filter((r) => r.verdict === v)
      .map((r) => `  '${esc(r.glyph)}', // ${r.codepoints} · ${r.group} · ${r.why}`)
      .join('\n');
  const safeWidths = rows
    .filter((r) => r.verdict === 'safe')
    .map((r) => `  ['${esc(r.glyph)}', ${r.pi}], // ${r.codepoints}`)
    .join('\n');
  console.log(`/**
 * src/tui/render/glyph-table —— **字形宽度探针的产物**(切片 S6)。
 *
 * ⚠ **生成文件,别手改。** 重新生成:
 *   \`bun run scripts/tui-glyph-probe.ts --emit-ts > src/tui/render/glyph-table.ts\`
 *
 * 真终端读数(第三套读数):**${tty !== null ? '已量' : '未量'}** ——
 * ${tty !== null ? `量于 ${provenance()},${new Date().toISOString().slice(0, 10)}。` : '自动化 lane 后面没有终端模拟器, 没人回答 CSI 6n。想量真值在真终端里跑 `--tty`。'}
 * ${tty !== null ? '⚠ 这份读数只对**那套终端 + 那套字体**成立:Nerd Font 私用区只有 `Mono` 变体才是 1 列;\n * 歧义宽度只有非 CJK locale 才是 1 列。换机器要重量。' : ''}
 *
 * 判定三态(**不是两态**):
 *  - \`SAFE\` —— 两把尺子(pi-tui / Unicode EAW)一致${tty !== null ? ',且真终端同意' : ''};
 *  - \`NEEDS_TTY\` —— **歧义宽度**(EAW = A):CJK locale 画 2 列、别处画 1 列。
 *    不是"不安全",是**这台机器上答不了** —— 两者压成一个黑名单就再也分不开;
 *  - \`UNSAFE\` —— 字体私用区 / emoji / ZWJ:各终端与各字体分歧最大,一律不做 UI 骨架。
 */

/** 白名单:字形 → 已核实的列宽。测试拿它当**回归钉**,pi-tui 改了宽度表这里当场红。 */
export const SAFE_GLYPH_WIDTHS: ReadonlyMap<string, number> = new Map([
${safeWidths}
]);

/** 歧义宽度:**未量**,不是不安全。要用它得先在真终端上量一次。 */
export const NEEDS_TTY_GLYPHS: ReadonlySet<string> = new Set([
${list('needs-tty')}
]);

/** 确定不用:字体/终端相关,量了也只对这一台机器成立。 */
export const UNSAFE_GLYPHS: ReadonlySet<string> = new Set([
${list('unsafe')}
]);

/**
 * 这份表**是不是**由真终端裁决过。
 *
 * ⚠ 它决定 \`NEEDS_TTY_GLYPHS\` 为空该怎么读:
 * \`true\` + 空 = 歧义那一档**已被裁决完**(全部并进 SAFE 或 UNSAFE);
 * \`false\` + 空 = **生成脚本出问题了**(候选集里明明有歧义字形)。
 * 两者读数长得一样,靠这个字段分 —— 本仓 \`NULL ≠ 0 ≠ 不适用\`。
 */
export const GROUND_TRUTH = ${tty !== null};
`);
  process.exit(0);
}

const MARK: Record<string, string> = { safe: '白', 'needs-tty': '待真终端', unsafe: '不用' };
console.log('# 字形宽度探针读数\n');
console.log(tty !== null ? '真终端读数: **已量**\n' : '真终端读数: **未量**(不在 TTY 里跑;这一列是 `-`,不是 0)\n');
console.log('| 组 | 字形 | 码点 | pi-tui | unicode | 真终端 | 判定 | 说明 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const shown = r.group === 'nerdfont' ? '(私用区)' : `\`${r.glyph}\``;
  console.log(
    `| ${r.group} | ${shown} | ${r.codepoints} | ${r.pi} | ${r.unicode} | ${r.term ?? '-'} | ${MARK[r.verdict]} | ${r.why} |`,
  );
}
const by = (v: string) => rows.filter((r) => r.verdict === v);
console.log(
  `\n白名单 ${by('safe').length} / 待真终端 ${by('needs-tty').length} / 不用 ${by('unsafe').length}(总 ${rows.length})`,
);
console.log(`\n白名单字形: ${by('safe').map((r) => r.glyph).join(' ')}`);
console.log(`\n待真终端确认: ${by('needs-tty').map((r) => r.glyph).join(' ')}`);
