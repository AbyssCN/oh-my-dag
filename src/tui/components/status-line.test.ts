/**
 * L2 判据:组件层(TUI SDD §9 第二层)—— `render(width)` 返回数组,不起终端。
 *
 * 与 L1 分工:L1 证明**算法**对(`fitLine` 怎么截),这里证明**组件真的把 width 传下去了**。
 * 少了这一层,一个 `render() { return [this.text] }` 的实现能让 L1 全绿而屏幕照样超宽。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { StatusLine } from './status-line';

// 切片②的纯函数 `formatStatusGauge` (与入参类型 `StatusGaugeInput`)
// 在本跑的下一步实装 —— 此处先按契约入参形状把类型就地铺出,再走 namespace
// import 把函数"虚引用"接进来。namespace import 在 Bun 运行时不会因命名导出
// 缺失而炸整文件(只有 named import 会),所以既存 4 条 L2 测试仍能绿;
// 新加的 4 条切片②测试因为调的是 `undefined` 直接 TypeError 红,符合
// "先红后绿(O-6)" 的红态要求。

/** 切片②的 usage 子结构(契约 §3 改法里给的三个字段)。 */
type StatusGaugeUsage = {
  /** 完成 token 数(本轮);未进入算式(契约 I6:时钟外给,下游 now() 算好 tps 送来)。 */
  completionTokens: number;
  /** 缓存命中 token 数,作为 cache% 分子。 */
  cacheRead: number;
  /** 未命中 token 数,与 cacheRead 合计作 cache% 分母(契约 §3 改法)。 */
  uncached: number;
};

/** 切片②纯函数入参。照契约:任一字段为 `null` ⇒ 对应段缺席(I2: NULL ≠ 0)。 */
type StatusGaugeInput = {
  usage: StatusGaugeUsage | null;
  /** 取最小子集 —— 实装时可能换 `ContextPressure`,但函数只看 `ratio`。 */
  pressure: { ratio: number } | null;
  /** 由注入的 now() 算好送来(I6),函数本身不碰时钟。`null` = 无上一轮值。 */
  tps: number | null;
};

// namespace import:Bun 不会因命名导出缺失而炸整文件。`.formatStatusGauge` 在
// 切片②实装前取出来就是 `undefined`,被非空断言后,测试在调用处 TypeError 红。
// 实装步骤到位时这条虚引用就拿到真函数,测试变绿 —— 红/绿由"函数存在性 + 行为"两轴共同决定。
import * as _statusbarNS from '../render/statusbar';
const formatStatusGauge = (_statusbarNS as unknown as {
  formatStatusGauge?: (input: StatusGaugeInput) => string;
}).formatStatusGauge!;

describe('StatusLine', () => {
  // 反向自检 (2026-08-07 实跑): 把 render 改成 `return [this.text]` (不过 fitLine)
  // → 下面「窄屏不超宽」「setText 之后仍受宽度约束」两条当场红。
  test('★ 恒为一行 —— 再长也不折成两行', () => {
    expect(new StatusLine('x'.repeat(500)).render(40)).toHaveLength(1);
  });

  test('★ 窄屏不超宽(组件确实把 width 传给了 fitLine)', () => {
    const line = new StatusLine('omd tui — /home/someone/repos/a-rather-long-project-name');
    for (const w of [10, 40, 100]) {
      expect(visibleWidth(line.render(w)[0] as string)).toBeLessThanOrEqual(w);
    }
  });

  test('★ setText 之后仍受宽度约束(不是只在构造时截一次)', () => {
    const line = new StatusLine('short');
    line.setText('你好世界'.repeat(20));
    expect(visibleWidth(line.render(30)[0] as string)).toBeLessThanOrEqual(30);
  });

  test('放得下时原样出', () => {
    expect(new StatusLine('abc').render(80)).toEqual(['abc']);
  });
});

/**
 * ★ 底栏活仪表(SDD V3 / 切片②)—— 契约 I2/I3/I4 的闸。
 *
 * 契约给的模板:`ctx <进度> <pct>% · <n>t/s · cache <pct>%`,
 * 进度条按 I4 用 ASCII `#-` 实现(白名单内 block 元素 `▰▱` 未量真终端,降级)。
 * `session` 事件已带 `usage`(completion/cacheRead/uncached)与 `pressure`,
 * 底栏行①追加的三格就是这里断言的输出;`tps` 由 I6 注入 now() 算好送来。
 */
describe('★ 底栏活仪表(SDD V3 / 切片②,契约 I2/I3/I4)', () => {
  /**
   * ① 喂入固定 usage(completion tokens / cacheRead / uncached)与 pressure + 算好 tps,
   * 三格文本逐字等于契约模板。
   *
   * 证伪方式:把 progress 块宽改成 ≠ 10(例如 5)→ 长度立即错位;
   * 把 cache% 公式改成 cacheRead / uncached(漏加 cacheRead)→ cache% 不再等于 97%;
   * 把分隔符 ` · ` 中的 `·` 替换成别的字符 → 整字符串不再等于期望值;
   * 把 `if (input.tps !== null)` 的判断去掉 → t/s 段会无中生有 → 期望串立刻红;
   * 把 pressure.ratio 乘 100 之前先 Math.ceil → 62% 变 63% → 整串红。
   */
  test('★ 喂入固定 usage + pressure + tps → 三格文本逐字等于契约模板', () => {
    const out = formatStatusGauge({
      usage: { completionTokens: 120, cacheRead: 194, uncached: 6 },
      pressure: { ratio: 0.62 },
      tps: 12,
    } satisfies StatusGaugeInput);
    // progress = round(0.62 * 10) = 6 `#` + 4 `-` = `######----`
    // ctx%    = round(0.62 * 100) = 62
    // cache%  = round(194 / (194 + 6) * 100) = 97
    // 分隔符 U+00B7(`·`)已在字形白名单(GROUND_TRUTH 量过 = 1 列),不踩 I4。
    expect(out).toBe('ctx ######---- 62% · 12t/s · cache 97%');
  });

  /**
   * ② usage 整体缺席 ⇒ 三格整体缺席,不许画 0 / 不许留分隔符(I2: NULL ≠ 0)。
   *
   * 证伪方式:把 `if (input.usage === null) return '';` 改成 return `'·'` 或 `'0'`
   * → 五个 not.toContain 立刻红(留了 `·` / 含了 `0`);
   * 把任一格(ctx / tps / cache)的 push 移到 usage 缺席分支里 → 对应的 not.toContain 红;
   * 把它改成 `if (input.usage === undefined)`(漏 null 守卫)→ 用 `null` 喂入时整串红。
   */
  test('★ usage 缺席 → 三格整体缺席,无 ctx / t/s / cache / 分隔符 / 0 (I2: NULL ≠ 0)', () => {
    const out = formatStatusGauge({
      usage: null,
      pressure: { ratio: 0.62 },
      tps: 12,
    } satisfies StatusGaugeInput);
    expect(out).toBe('');
    expect(out).not.toContain('ctx');
    expect(out).not.toContain('t/s');
    expect(out).not.toContain('cache');
    expect(out).not.toContain(' · ');
    // 不许出现 0(任何形状的 0 都算编数):这是 I2 的硬规定,
    // 与上面几个 not.toContain 不重叠 —— `0` 可能在某段尾巴(比如未来误算的 cache% = 0)。
    expect(out).not.toMatch(/0/);
  });

  /**
   * ③ tps 无上一轮值时,该格单独缺席;ctx / cache 两格照画。
   *
   * 证伪方式:把 `if (input.tps !== null)` 守卫去掉 → 多出 `0t/s` 那段 → 整串红 + toContain('t/s') 红;
   * 把 ctx / cache 两条 push 也放进 `if (input.tps !== null)` 守卫里 → 期望串少 ctx/cache 红;
   * 把 `tps: null` 改成 `tps: 0`(把"无值"误读成"是零")→ 期望串变 `0t/s` → 红(I2)。
   */
  test('★ tps 无上一轮值 → 该格单独缺席,其余两格照画', () => {
    const out = formatStatusGauge({
      usage: { completionTokens: 120, cacheRead: 194, uncached: 6 },
      pressure: { ratio: 0.62 },
      tps: null,
    } satisfies StatusGaugeInput);
    expect(out).toBe('ctx ######---- 62% · cache 97%');
    expect(out).toContain('ctx');
    expect(out).toContain('cache');
    expect(out).not.toContain('t/s');
    // 没有 t/s 段 ⇒ 也不该出现空分隔符(` ·  · ` 的中间那一段)。
    // 用正则钉: `·` 在分隔位必须**恰好** 1 个( ctx 段尾 1 个, cache 段后没有)。
    expect((out.match(/·/g) ?? []).length).toBe(1);
  });

  /**
   * ④ 仪表挤进既有底栏行① —— 常驻行数不增(I3)。
   *
   * 证伪方式:把 `StatusLine.render` 改成 `return [fitLine(this.text, width), 'extra']`
   * → toHaveLength(1) 立刻红;
   * 把 `fitLine` 换成会折行的 pi-tui `Text` → 长度变 2,本条红;
   * 删掉 `formatStatusGauge` 调用 → 内部压力段就缺 → 不是这条红,但本条仍守住"行数不增"。
   * 这条也守"窄屏不超宽"(既有的 L2 闸在窄列下不动)—— 仪表装进去后窄屏仍 1 行。
   */
  test('★ 仪表挤进既有底栏行① —— 行数不增 (I3)', () => {
    const gaugeText = formatStatusGauge({
      usage: { completionTokens: 120, cacheRead: 194, uncached: 6 },
      pressure: { ratio: 0.62 },
      tps: 12,
    } satisfies StatusGaugeInput);
    const line = new StatusLine(gaugeText);
    // 既有的"恒为一行"闸在装进仪表后仍得守住:宽屏与窄屏都得 1 行。
    expect(line.render(80)).toHaveLength(1);
    expect(line.render(30)).toHaveLength(1);
    // 既有的"窄屏不超宽"闸也要守住 —— 仪表塞进去后窄屏仍不能超宽。
    expect(visibleWidth(line.render(30)[0] as string)).toBeLessThanOrEqual(30);
  });
});