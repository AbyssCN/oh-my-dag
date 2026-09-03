/**
 * 空旋钮闸 (INV-P2-1 泛化, 2026-07-28 全仓扫的产物)。
 *
 * 这次 session 里同一个缺陷形态撞见了五次, **没有一次是靠计划找到的**:
 *   `max_retry`/`on_failure`/`fallback` 零消费者 · `escalation` 座位纯装饰 · `postcondition` 被两个
 *   conductor prompt 反复明示却无人检查 · goal 路的 continuity 有机制零调用方 · INV-GOAL-3 的
 *   taint closure 写在契约里但代码没有。
 *
 * 共性: 声明面 (schema / 座位表 / prompt / 契约) 往前跑了, 消费面没跟上, **两边都不报错**。
 * 受害者要么是被误导的 conductor (照着明示写了没人看的字段), 要么是显式配了却被静默忽略的调用方。
 *
 * 这个文件把"靠撞"变成"靠红"。两条闸:
 *   1. **明示即承诺**: conductor prompt 里出现的每个 node 字段, 必须有引擎消费者。
 *   2. **座位即承诺**: `ALL_SEATS` 里的每个座位, 必须真的被解析过 (不是只被 auto-assign 派模型
 *      + 被起跑自检查凭证, 然后没人读)。
 *
 * 加字段/加座位而不登记消费点 → 这里红。
 *
 * ⚠ 这道闸只抓「有没有人解析」, 抓不到「解析出来的东西有没有用在它该用的地方」——
 * 后者是另一个形态 (S-2), 由 `src/mcp/seat-wiring.test.ts` 守。两者的分工与全部同族缺陷
 * 见 **`docs/silent-failures.md`** (长期台账, 不是 session 记录)。要撤回一个已明示的东西, 从 prompt 里删掉即可
 * (zod 层留容忍不影响本闸 —— 容忍旧 plan 与"邀请 conductor 去写"是两回事)。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SEATS } from '../model/role-models';
import { SEATS } from '../model/seats';

/**
 * 座位 → 解析点。座位不是"auto-assign 派个模型 + 起跑自检查凭证"就算活着 —— 得有人真去解析它,
 * 否则 config 配了不生效 (INV-MODEL-1 要杀的正是这个)。
 *
 * ## 这条闸曾经是恒真式 (2026-08-02 修)
 *
 * 2026-08-01 有人把手抄的 `SEAT_CONSUMERS` 改成**从 `seats.ts` 派生**:
 * `Object.fromEntries(SEATS.map(s => [s.id, s.where.join(' + ')]))`, 动机是"少一份要记得同步的清单"。
 * 动机成立, **但代价是把交叉验证一起删了** —— 派生之后这条闸变成「`seats.ts` 里每个座位都写了
 * `where`」, 拿真源查真源, 永远绿。它头注还写着「必须**真的被解析过**」, 于是成了
 * **一条自称守着 X、实际守着恒真式的闸** —— 比没有闸更坏, 因为它让人以为这件事有人管。
 *
 * > 教训: 消除重复之前先问「这份重复是不是正在**当交叉验证用**」。两份清单互相对不上会红,
 * > 合成一份就再也不会红了。
 *
 * ## 现在的判据: 去源码里找真的解析调用
 *
 * 扫 `src/` + `scripts/` 全部非测试 `.ts`(**排除 `model/seats.ts` 自己**), 每个座位必须至少有一处
 * `resolveSeatModel('<id>')` / `tryResolveSeatModel` / `resolveRoleModelConfigured` / `resolveRoleModel`。
 *
 * ⚠ **这条闸的诚实边界**: 它查"有没有人解析", 查不出"解析它的那个文件本身有没有人调"。
 *   曾经的假阳性: `dream` 座位解析在 `src/dream/model-live.ts`, 而该文件在 import 图上是孤儿
 *   (2026-08-02 摘掉 `dream_consolidate` 工具后再无入口) —— 这条闸看不出来, 照样给绿。
 *   **这个盲点已补上**: 那一层由 `src/harness/reachability.test.ts` 守(该座位随 ADR-0003 摘除,
 *   实现停到 `experimental/`)。两条闸合起来才等于"配了真的会生效":
 *   本闸问「有没有人解析」, 可达性闸问「解析它的文件从生产入口到得了吗」。
 *   同族分工: 「解析出来用没用对地方」由 `src/mcp/seat-wiring.test.ts` 守(判据是引擎真收到的 config)。
 */
const SEAT_RESOLVERS = /(?:resolveSeatModel|tryResolveSeatModel|resolveRoleModelConfigured|resolveRoleModel)\(\s*['"]([a-z-]+)['"]/g;

/**
 * **池成员座位**: 它不是独立角色, 只作为 stamp 池的一个坐标被消费, 按设计就没有专属解析点。
 * 值 = 豁免理由(必须与 `seats.ts` 里该座位的 `what` 说法一致, 否则就是拿豁免掩盖真的空旋钮)。
 */
const POOL_ONLY_SEATS: Record<string, string> = {
  overflow: '只作为 stamp 池 mid 档的一个坐标被消费 (见 seats.ts 该座位的 what/recommend)',
};

function repoTsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) repoTsFiles(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

/** 全仓真的被解析过的座位 id → 解析它的文件。**不含 `model/seats.ts`**(真源不能给自己作证)。 */
function resolvedSeats(): Map<string, string[]> {
  const root = new URL('../..', import.meta.url).pathname;
  const out = new Map<string, string[]>();
  for (const f of [...repoTsFiles(join(root, 'src')), ...repoTsFiles(join(root, 'scripts'))]) {
    if (f.includes('model/seats')) continue; // 真源自己不算消费者
    const src = readFileSync(f, 'utf8');
    SEAT_RESOLVERS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SEAT_RESOLVERS.exec(src))) {
      const id = m[1]!;
      out.set(id, [...(out.get(id) ?? []), f.slice(root.length)]);
    }
  }
  return out;
}

describe('座位即承诺 — 每个座位都真的被解析过', () => {
  test('★ 每个座位在源码里至少有一处真解析 (池成员座位显式豁免)', () => {
    const resolved = resolvedSeats();
    // 扫描面自检: 抓不到任何解析 = 正则漂了/路径错了, 而不是"全仓座位都死了"。
    expect(resolved.size).toBeGreaterThan(10);

    const unresolved = ALL_SEATS.filter((s) => !resolved.has(s) && !(s in POOL_ONLY_SEATS));
    expect(
      unresolved.length === 0
        ? ''
        : `以下座位没有任何解析点 —— 配了它不生效 (空旋钮):\n  ${unresolved.join('\n  ')}\n` +
          '修法: 要么接上真消费者, 要么从 ALL_SEATS 删掉; 若它只是 stamp 池成员, 登记进 POOL_ONLY_SEATS 并写明理由。',
    ).toBe('');
  });

  test('豁免名单不许收留真座位 (豁免的必须确实没有专属解析点)', () => {
    // 反向: 一个被豁免的座位如果其实有解析点, 说明豁免是多余的 —— 摘掉, 别让名单变成垃圾桶。
    const resolved = resolvedSeats();
    const needless = Object.keys(POOL_ONLY_SEATS).filter((s) => resolved.has(s));
    expect(needless, `这些座位有真解析点, 不该待在 POOL_ONLY_SEATS 里: ${needless.join(', ')}`).toEqual([]);
  });

  test('豁免名单不含已不存在的座位', () => {
    const stale = Object.keys(POOL_ONLY_SEATS).filter((s) => !(ALL_SEATS as readonly string[]).includes(s));
    expect(stale).toEqual([]);
  });

  test('seats.ts 登记表与 ALL_SEATS 同集 (删座位要同步删登记)', () => {
    const registered = new Set(SEATS.map((s) => s.id));
    expect([...registered].filter((s) => !(ALL_SEATS as readonly string[]).includes(s))).toEqual([]);
    expect(ALL_SEATS.filter((s) => !registered.has(s))).toEqual([]);
  });
});
