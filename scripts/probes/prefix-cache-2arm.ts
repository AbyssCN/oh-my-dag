/**
 * prefix-cache-2arm —— **claude-code 订阅位到底会不会缓存 user 消息里的大前缀**(2026-08-14)。
 *
 * ## 为什么必须实测
 *
 * 对照臂 run `33c08ff4` 的 40 发 `claude-code:claude-haiku-4-5` **cacheHit 全 0**,
 * 而 `fanout.ts` 的设计原话是「所有 stage 共用同一 head → 最大化公共前缀,stablePrefix 段跨轮命中」。
 *
 * ⚠ 我第一次拿「claude-code 历史均值 30%」当反证,**那是错的**:那张表里
 * **一行 haiku 都没有、一行 fanout 都没有**(研究子进程根本没挂 tui 账本观察者),
 * 拿它当基线等于"基线不在同一条件上,整个对比作废"(本仓 §对照基线 那条血账)。
 * 所以不推,改量。
 *
 * ## 机制上的怀疑(读代码得出,待这条实验判)
 *
 * - `fanout.ts` 的 `msg()` 把**全部内容(含共享 corpus)放进一条 user 消息**,没有 system 段;
 * - `claude-sdk-complete.ts` 经 Agent SDK `query({prompt: string})` 发出去 —— 接口是**一整个字符串**,
 *   没有块级 `cache_control` 的位置;
 * - 全仓 `grep cache_control` = **0 处**。
 * → 若 CLI 不自动给 user 前缀打断点,这条路上的前缀缓存就是**结构上不成立**的,
 *   而 fanout 的 warm-then-fanout 在 claude-code 座位上是空转。
 *
 * ## 四要素(跑之前钉死)
 *
 * - **单一变量** = 同一个大前缀发第二遍(第一发写缓存,第二发该读到)。前缀/模型/参数全同。
 * - **对照基线** = 同一次跑里对 `deepseek:deepseek-v4-flash` 发同样两发 ——
 *   它是**已知会自动前缀缓存**的通道。它若也 0,说明尺子没动,本实验作废。
 * - **预先声明的成败信号**:
 *     · 第二发 `cacheHit > 0`  → 这条路会缓存 user 前缀 ⇒ 那 40 发的 0 **另有原因**(继续查);
 *     · 第二发 `cacheHit = 0` ∧ deepseek 臂 > 0 → 前缀缓存在 claude-code 位上**不成立**
 *       ⇒ fanout 的 head 共享设计在这些座位上是空转, 降耗该先修这个而不是砍 L×V。
 * - **两侧都记**: 每发的 in/out/cacheHit 原样落表, 不塌与塌都写。
 *
 * 跑: bun --env-file=.env run scripts/probes/prefix-cache-2arm.ts [--chars 24000]
 */
import '../../src/harness/script-bootstrap';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CHARS = Math.max(4000, Number(opt('chars') ?? '24000'));

/**
 * 稳定大前缀。**逐字节固定**(禁时间戳/随机数)—— 前缀只要动一个字符, 缓存按定义就不该命中,
 * 那时读到的 0 分不清是"通道不缓存"还是"前缀根本不同"。
 */
function bigPrefix(chars: number): string {
  const unit =
    '本段是前缀缓存实验的稳定语料段。它逐字节固定, 不含时间戳与随机数, 因为前缀只要动一个字符, ' +
    '缓存按定义就不该命中 —— 那时读到的 0 分不清是"通道不缓存"还是"前缀根本不同"。' +
    'This paragraph is deliberately repeated to build a long, byte-stable prefix for prompt-cache probing. ';
  let s = '';
  while (s.length < chars) s += unit;
  return s.slice(0, chars);
}

interface Row {
  model: string;
  发次: number;
  in: number;
  out: number;
  cacheHit: number | null;
  ms: number;
  err?: string;
}

async function main(): Promise<void> {
  const { bootstrapModelRuntime } = await import('../../src/model/bootstrap');
  await bootstrapModelRuntime?.();
  const { callModel } = await import('../../src/model/index');

  const prefix = bigPrefix(CHARS);
  const rows: Row[] = [];
  // 两臂: 被测 (claude-code 订阅位, = 本次 research 的 lens/reduce/synth/judge 座) 与
  // 对照 (deepseek, 已知自动前缀缓存)。同一前缀, 同一问题, 各发两次。
  for (const model of ['claude-code:claude-haiku-4-5', 'deepseek:deepseek-v4-flash']) {
    for (const 发次 of [1, 2]) {
      const t = Date.now();
      try {
        const r = await callModel({
          model,
          maxTokens: 200,
          messages: [{ role: 'user', content: `${prefix}\n\n只回一个词: ok` }],
        });
        rows.push({
          model,
          发次,
          in: r.usage?.in ?? 0,
          out: r.usage?.out ?? 0,
          // NULL ≠ 0: provider 没报这一格 = 不知道, 不是"零命中"
          cacheHit: r.usage?.cacheHit ?? null,
          ms: Date.now() - t,
        });
      } catch (e) {
        rows.push({ model, 发次, in: 0, out: 0, cacheHit: null, ms: Date.now() - t, err: String(e).slice(0, 160) });
      }
    }
  }

  console.log(`\n前缀 ${CHARS} 字符 · 每个坐标连发两次 (第一发写缓存, 第二发该读到)\n`);
  console.log('坐标'.padEnd(30) + '发次'.padStart(5) + 'in'.padStart(10) + 'out'.padStart(8) + 'cacheHit'.padStart(11) + '耗时'.padStart(9));
  for (const r of rows) {
    const ch = r.cacheHit === null ? 'null(没报)' : String(r.cacheHit);
    console.log(r.model.padEnd(30) + String(r.发次).padStart(5) + String(r.in).padStart(10) + String(r.out).padStart(8) + ch.padStart(11) + `${r.ms}ms`.padStart(9) + (r.err ? `  ⚠ ${r.err}` : ''));
  }

  // 判词按预声明的信号机械打印 —— 不在这里现编判据。
  const second = (m: string): Row | undefined => rows.find((r) => r.model.startsWith(m) && r.发次 === 2);
  const cc = second('claude-code');
  const ds = second('deepseek');
  const hit = (r?: Row): boolean => (r?.cacheHit ?? 0) > 0;
  console.log('\n判词 (按跑前钉死的信号):');
  if (!hit(ds)) {
    console.log('  ⚠ 对照臂 (deepseek) 第二发也没命中 → **尺子没动, 本实验作废**, 别读被测臂。');
  } else if (hit(cc)) {
    console.log('  · claude-code 第二发命中 → 这条路会缓存 user 前缀; research 那 40 发的 0 **另有原因**, 继续查。');
  } else {
    console.log('  · claude-code 第二发 0 而 deepseek 命中 → **前缀缓存在 claude-code 位上不成立**;');
    console.log('    fanout 的 head 共享设计在这些座位上是空转 —— 降耗先修这个, 而不是砍 L×V。');
  }
}

if (import.meta.main) await main();
