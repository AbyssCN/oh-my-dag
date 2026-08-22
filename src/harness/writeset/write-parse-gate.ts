/**
 * harness/write-parse-gate —— **写后即验**(issue #145 提议 1,2026-08-16)。
 *
 * ## 它治的那个病
 *
 * plana M3.5 实战:M3 新建的七个屏零语法问题,但**三次把既有文件改坏**,形态完全一致 ——
 * 新旧内容并存 / 位置错位,即"部分写入":
 *
 * - `routes.tsx`:类型联合结束后接一段没有 `/**` 开头的悬空注释体,随后重复声明同一类型
 *   → **58 处语法错误,整棵树编译不过**;
 * - `SolveScreen.tsx`:两条 `const` 被塞进函数调用的参数表内部,右括号错位;
 * - `SolveScreen.tsx`:同一段 JSX 注释 + `<View` 新旧两版并存。
 *
 * ⚠ **反证先写在这**:`agent-leaf.ts` 的 hashline 模式**存在的目的**就是「治弱模型改文件
 * 错位/腐烂」,而这三次 hashline 模式**是开着的**(spin 签名里就是 `hashline_read` /
 * `hashline_edit`)。专治这个病的工具在场,病照犯 —— 这正是「可靠性来自模型之外」那条:
 * 工具、prompt 规则都拦不住,得有一道**会红的闸**。
 *
 * ## 为什么判在**节点末**而不是每次写之后
 *
 * issue 原文提的是「写后当场解析,红了当场让 leaf 重写」,挂点也现成
 * (`agent-leaf.ts` 的 `FILE_WRITE_TOOLS` 写前快照/写后比对那条链)。**这里刻意偏离,理由是
 * 同一份交接报告 §8.6 自己记的读数**:一次编辑中途的文件本来就可能不可解析
 * (先写类型再写实现、分两刀改一个函数),而那份报告在有 running 节点时读 tsc,
 * **四次全部读到写到一半的中间态**,四次都差点当成回归。
 * 每写必判 = 把那四次误判做进闸里,而假阳性闸的下场是被人关掉。
 *
 * 节点末判则没有这个问题:节点结束时树该是自洽的,不自洽就是真坏了。
 * 代价是反馈慢一个节点(而不是慢一个工具调用),换来的是**零中间态假阳性**。
 *
 * ⚠ **2026-08-16 补第二层**:上面这个取舍把「反馈慢一个节点」的代价记轻了 ——
 * 慢一个节点 = 一次**整节点冷重跑**(实测 75–973s / in 87K–12.8M)。
 * 于是加了 {@link createParseFeedback}:同一条判据、**会话内**的第二个出口,
 * **只提醒不判定**。中间态假阳性的代价因此从"闸误杀"降到"一句 ~60 token 的提醒",
 * 而本闸(硬的那道)一个字没动。判据只有一份,出口有两个 —— 别再写第三份判据。
 *
 * 另一个好处:判在引擎侧 `filesTouched` 上 → pi 通道与 claude-sdk 通道**同一道闸**,
 * 不必在两个 runner 里各接一份(两处各写一份必漂)。
 *
 * ## 判据(拿不准一律不报,同 static-lint / g1 闸)
 *
 * - 认得的扩展名才判:JS/TS 家族走 `Bun.Transpiler`(零依赖、毫秒级),JSON 走 `JSON.parse`;
 * - **认不出的扩展名不判**,不是"判它是对的"——`.md` / `.png` / `.py` 一律跳过;
 * - 读不到文件(不存在 / 权限 / 二进制)→ 跳过,不报。产物存在性是**另一道闸**的活
 *   (`empty-artifact`),两道闸各报各的,别让这一道去兼职;
 * - 没有 `Bun` 全局(非 bun 运行时)→ 整道闸跳过并留一行,不是静默当绿。
 */
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { logger } from '../../logger';

/** 一条解析失败。`error` 已是人话(解析器原文首行),给下游 leaf 直接消费。 */
export interface ParseFailure {
  path: string;
  error: string;
}

/**
 * 扩展名 → Bun.Transpiler 的 loader。**只列有把握的**:
 * `.tsx`/`.jsx` 必须用 tsx/jsx loader(否则 JSX 当语法错),`.mts`/`.cts` 同 ts。
 */
const JS_LOADERS: Readonly<Record<string, 'ts' | 'tsx' | 'js' | 'jsx'>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

/** 这个扩展名判不判得了 —— 判不了的直接跳过(不是"判它是对的")。 */
export function isParseable(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '.json' || ext in JS_LOADERS;
}

/**
 * 解析一份**内容**。可解析 → `null`;解析不了 → 错误首行。
 * 纯函数(不碰盘),便于反向自检直接喂坏样本。
 */
export function parseContent(path: string, content: string): string | null {
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.json') {
      JSON.parse(content);
      return null;
    }
    const loader = JS_LOADERS[ext];
    if (!loader) return null; // 认不出 → 不判
    if (typeof Bun === 'undefined') return null; // 非 bun 运行时 → 整道闸跳过 (调用方会留一行)
    // transformSync 语法错即抛。**只要语法, 不要类型** —— 类型是 tsc 的活, 那是另一道更慢的闸;
    // 这一道要的是毫秒级 + 零误报, 而「新旧内容并存 / 括号错位」全都是语法层的。
    new Bun.Transpiler({ loader }).transformSync(content);
    return null;
  } catch (err) {
    return String((err as Error).message ?? err).split('\n')[0]!.slice(0, 300);
  }
}

/**
 * 判一批路径。返回**解析失败**的那些;跳过的(扩展名不认 / 读不到)不进结果也不报。
 *
 * `root` = 相对路径的根(节点的 cwd)。
 */
export function parseWrittenFiles(paths: readonly string[], root: string): ParseFailure[] {
  if (typeof Bun === 'undefined') {
    // fail-open, 但不吞证据 (§3 第 2 条): 闸整个不在的时候要说出来, 别让缺席长得像"全绿"。
    logger.warn({ files: paths.length }, '[omd/write-parse] 非 bun 运行时 → 写后即验整道跳过 (不是判绿)');
    return [];
  }
  const out: ParseFailure[] = [];
  for (const p of paths) {
    if (!isParseable(p)) continue;
    let content: string;
    try {
      content = readFileSync(isAbsolute(p) ? p : join(root, p), 'utf8');
    } catch {
      continue; // 读不到 → 存在性是产物闸的活, 这道闸不兼职
    }
    const error = parseContent(p, content);
    if (error) out.push({ path: p, error });
  }
  return out;
}

/**
 * 一个 leaf 一份。上限刻意小: 注到第 4 条还没修好, 说明它修不动 ——
 * 那时该由节点末硬闸接手, 继续注只是在往一个已经修不动的会话里塞字。
 */
const MAX_NUDGES_PER_LEAF = 3;

/**
 * **L0 会话内自愈** (2026-08-16 承 #145 提议 1 的另一半)。
 *
 * ## 它补的是「探测点」与「出口点」之间那段距离
 *
 * 同一条判据 ({@link parseContent}) 今天只有一个出口: **节点末** →
 * `broken-artifact` → 整个节点冷重跑。而探测点其实在**节点内** —— 写工具一返回,
 * 盘上就已经能判了 (`agent-leaf` 的写后快照那条链就在那一刻取的)。
 * 两点之间隔着的那段, 就是白烧的 token 与墙钟:
 *
 * | 出口 | 实测代价 (plana run 1c9a4566 / e74e6342 的 agent 节点) |
 * |---|---|
 * | 节点末硬闸 → 冷重跑 | 单节点 75–973s · in 87K–12.8M (其中未命中缓存 30K–160K) |
 * | 会话内注入 | 一条 ~60 token 的 user 消息 + 多跑一轮 (上下文命中率实测 86–99%) |
 *
 * ## 为什么这一层可以每写就判, 而节点末那层不行
 *
 * `write-parse-gate.ts` 文件头拒绝「每写必判」的理由取自交接报告 §8.6 的四次误判 ——
 * 但那四次量的是**有别的节点在跑时读整棵树的 tsc** (跨节点中间态 + 全工程类型图),
 * 与「解析本 leaf 自己刚写完的那一个文件」不是同一个 scope。⚠ 尽管如此,
 * **同一个文件分两刀改**这一种中间态是真的 (先写类型再写实现)。
 * 所以这一层的出口是 **advisory**, 不是闸:
 *
 *   · 判红 → 只往下一次请求里塞一句话, **不失败、不中止、不改任何判定**;
 *   · 真是分刀改的 → 它下一刀本来就会修好, 代价封顶在那一句话 (~60 token);
 *   · 真坏了 → 它当场修, 省下一次整节点冷重跑。
 *
 * **不对称就是全部论证**: 误报代价 ~60 token, 命中收益 10⁴–10⁶ token + 数百秒。
 * 节点末硬闸一个字不动 —— 这一层修不好的, 那一层照样红。
 *
 * ## 边沿触发 (同 drift 的 `takeInjection`)
 *
 * 状态是「每条路径上一次报过的错」: `ok → 坏` 才注, 同一条错不重复注,
 * 修好了 (解析回绿) 就**重新上膛** —— 于是"一直坏着"注一次而不是每写一次注一次。
 */
export interface ParseFeedback {
  /**
   * 一次**真改变了内容**的写之后调用 (noop 的写不必判 —— 盘上逐字没动, 不会有新损坏)。
   * `root` = 相对路径的根 (leaf 的 cwd)。
   */
  note(paths: readonly string[], root: string): void;
  /** 边沿取走: 有待注内容则返回正文并清空, 无则 null。 */
  takeInjection(): string | null;
  /** 读数: 这个 leaf 一共注了几条 (进 `AgentLeafResult.parseNudges`)。 */
  nudges(): number;
}

export function createParseFeedback(): ParseFeedback {
  /** path → 上一次报过的错误首行。缺席 = 这条路径此刻是干净的 (上膛状态)。 */
  const reported = new Map<string, string>();
  let pending: ParseFailure[] = [];
  let sent = 0;
  return {
    note(paths, root) {
      if (sent >= MAX_NUDGES_PER_LEAF) return;
      for (const f of paths) {
        if (!isParseable(f)) continue;
        const [failure] = parseWrittenFiles([f], root);
        if (!failure) {
          reported.delete(f); // 解析回绿 → 重新上膛
          continue;
        }
        if (reported.get(f) === failure.error) continue; // 同一条错, 它已经知道了
        reported.set(f, failure.error);
        pending.push(failure);
      }
    },
    takeInjection() {
      if (pending.length === 0) return null;
      const batch = pending;
      pending = [];
      sent += batch.length;
      return renderParseNudge(batch);
    },
    nudges: () => sent,
  };
}

/**
 * 会话内注入的正文。与 {@link renderParseFailures} **刻意分开写**: 那份是给下一个
 * (冷启动的) leaf 或重规划轮读的事后判词, 这份是给**正在干活的这个 leaf** 读的当下提醒。
 * 两个读者、两种时态、两种处置 —— 合成一份就得同时满足两边, 结果是两边都不贴切。
 *
 * ⚠ 「若你正分两刀改」那半句不是客套: 这一层是 advisory, 而分刀改是它唯一的正当误报形态。
 * 明写出来, 免得模型为了迎合一句它认为是错的判词去动本来对的代码
 * (同 engine.ts 那条「引擎侧事故, 不是对上一轮方案的评价」的教训)。
 */
export function renderParseNudge(failures: readonly ParseFailure[]): string {
  return (
    `[写后即验 · 提醒] 你刚写过的文件里, 有 ${failures.length} 个此刻**语法解析不通过**: ` +
    `${failures.map((f) => `${f.path} — ${f.error}`).join(' | ')}。` +
    '若你正把这个文件分两刀改, 下一刀把它改到能解析即可, 忽略本条。' +
    '若不是, 那多半是**部分写入**(新旧内容并存 / 括号或注释位置错位): ' +
    '**读全文 → 重写全文**, 别在坏掉的文本上继续打补丁。' +
    '节点结束时这些文件仍解析不过的话, 整个节点会被判失败重跑。'
  );
}

/** 给下游 leaf / 重规划轮读的判词。逐条点名文件与解析器原话 —— 「哪里坏了」不许靠猜。 */
export function renderParseFailures(failures: readonly ParseFailure[]): string {
  return (
    `写后即验未过: 本节点写完之后有 ${failures.length} 个文件**语法解析不通过** —— ` +
    `典型成因是"部分写入"(新旧内容并存 / 括号或注释位置错位), 不是内容写得不好而是**文件坏了**。` +
    `逐条: ${failures.map((f) => `${f.path} — ${f.error}`).join(' | ')}。` +
    `修法: 把点名的文件**整段重写**(读全文 → 重写全文), 别在坏掉的文本上继续打补丁。`
  );
}
