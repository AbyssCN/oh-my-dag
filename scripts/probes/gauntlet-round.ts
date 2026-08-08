/**
 * scripts/probes/gauntlet-round —— **逐屏 gauntlet 一轮**(P3)。
 *
 * ## 它是什么 / 不是什么
 *
 * 拿 `docs/bars/refs/<家>/<场景>.txt` 已采好的帧,**确定性**地量几个格子并排出名次。
 * **零模型调用、零花费** —— 帧是之前采好的证据,这里只是读它。
 *
 * ⚠ **外壳可比,内容不可比**(交接 40 §7.5):竞品在无凭证下停在欢迎屏,omd 走 fixture 能出内容。
 * 所以量的一律是**排版性质**(起始列 / 空行分布 / 重复串 / 宽度守规),
 * **不量**"信息够不够"这类要读内容才谈得上的东西。
 *
 * ## 报告公式(plan:108)
 *
 * 每一格:**谁赢 + 最大的一个缺口, 一句话, 必须带一个可测量的数。**
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REFS = 'docs/bars/refs';
const FAMS = ['omd', 'pi', 'opencode', 'openclaw', 'hermes'] as const;
/**
 * ⚠ `08-streaming` / `09-long-scroll` 只有 omd / pi / opencode 有
 * (openclaw 只认 OPENAI/ANTHROPIC key 停在向导, hermes 网关未起 —— 记在 `refs/_MISSING.md`)。
 * 缺的家在表里画 `—` 并**不参与该格评比**, 不拿"没采到"冒充"表现差"。
 */
const SCENES = ['01-empty', '02-slash-menu', '03-help', '04-narrow-80', '05-no-color', '07-settings', '08-streaming', '09-long-scroll'] as const;

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
function lines(fam: string, sc: string): string[] | null {
  const p = join(REFS, fam, `${sc}.txt`);
  if (!existsSync(p)) return null;
  const l = strip(readFileSync(p, 'utf-8')).split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}

interface Metric {
  /** 名字 */ name: string;
  /** 越小越好? */ lowerBetter: boolean;
  of: (l: string[]) => number;
  unit: string;
}
const startCol = (s: string): number => {
  const m = /\S/.exec(s);
  return m ? m.index : -1;
};
const METRICS: Metric[] = [
  { name: '贴边行(起始列 0)', lowerBetter: true, unit: '行', of: (l) => l.filter((x) => startCol(x) === 0).length },
  { name: '最长连续空行', lowerBetter: true, unit: '行', of: (l) => { let r = 0, m = 0; for (const x of l) { r = x.trim() ? 0 : r + 1; m = Math.max(m, r); } return m; } },
  { name: '非空行占比', lowerBetter: false, unit: '%', of: (l) => Math.round((100 * l.filter((x) => x.trim()).length) / Math.max(1, l.length)) },
  {
    /**
     * 同屏重复的长串。
     *
     * ⚠ **第一版量的是我自己的分词器**:它把编辑框的**上下两条横线**(`─────…`)
     * 数成了"重复串", 于是 omd 六个场景全输, 而真相是那两条线是输入框的边框、**不是噪音**。
     * 去掉画线字符之后:`07-settings` 的"重复"归 **0**, `01-empty` 只剩 **1** 个
     * (首屏 `引擎 <坐标>` 与行① —— 那是**有意留的**, 一次性介绍 + 常驻状态)。
     * ⇒ 报告里那句"最大缺口是重复串"作废。**一个在任何干预下都不动的数, 先看是不是尺子。**
     */
    name: '重复串(同屏≥2次的长串, 已排除画线)',
    lowerBetter: true,
    unit: '个',
    of: (l) => {
      const seen = new Map<string, number>();
      for (const x of l)
        for (const tok of x.split(/[\s│|·,、()\[\]]+/)) {
          if (tok.length < 12) continue;
          if (/^[─━│┃═╌┄┈▁▄▀█▓▒░\-=_.]+$/.test(tok)) continue; // 画线/进度条不是"重复的信息"
          seen.set(tok, (seen.get(tok) ?? 0) + 1);
        }
      return [...seen.values()].filter((n) => n >= 2).length;
    },
  },
];

/**
 * ⚠ **方向没定的格子不进名次。**
 *
 * `非空行占比` 就是这样一个:P1 的原话是「又挤又平, 62% 非空」——**把高占比当缺点**;
 * 而排名时我给它设的是"越大越好"(内容密度高 = 一屏给得多)。**两个方向互相矛盾**,
 * 而 omd 恰好在这一格六场全"赢" —— 拿一个方向没定的格子去凑胜场, 是自己给自己发奖。
 * ⇒ 它照常量、照常打印,但**不计入累计**。方向要 owner 定(或定一个目标区间)。
 */
const NO_RANK = new Set(['非空行占比']);

console.log('# gauntlet 一轮(确定性 · 零模型调用)\n');
const wins: Record<string, number> = {};
for (const m of METRICS) {
  console.log(`## ${m.name}(${NO_RANK.has(m.name) ? '⚠ **方向未定 — 不计入名次**' : m.lowerBetter ? '越小越好' : '越大越好'})\n`);
  console.log(`| 场景 | ${FAMS.join(' | ')} | 赢家 |`);
  console.log(`|---|${FAMS.map(() => '---').join('|')}|---|`);
  for (const sc of SCENES) {
    const vals = FAMS.map((f) => {
      const l = lines(f, sc);
      return l ? m.of(l) : null;
    });
    const present = vals.map((v, i) => ({ v, f: FAMS[i] as string })).filter((x) => x.v !== null) as { v: number; f: string }[];
    if (present.length === 0) continue;
    const best = present.reduce((a, b) => (m.lowerBetter ? (b.v < a.v ? b : a) : b.v > a.v ? b : a));
    const winners = present.filter((x) => x.v === best.v).map((x) => x.f);
    if (!NO_RANK.has(m.name)) for (const w of winners) wins[w] = (wins[w] ?? 0) + 1 / winners.length;
    const cells = vals.map((v, i) => (v === null ? '—' : `${v}${m.unit}${winners.includes(FAMS[i] as string) ? ' ★' : ''}`));
    console.log(`| ${sc} | ${cells.join(' | ')} | ${winners.join('/')} |`);
  }
  console.log('');
}
console.log('## 累计(赢的格子数, 并列按人数均分;**方向未定的格子不计**)\n');
for (const [f, n] of Object.entries(wins).sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(9)} ${n.toFixed(1)}`);
