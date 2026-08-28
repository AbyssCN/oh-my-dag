#!/usr/bin/env bun
/**
 * scripts/memory-recall-ab —— **记忆召回的 A/B 装置**(2026-08-28)。
 *
 * 回答两个**分开的**问题。合成一个就什么都判不出来:
 *   **成本**:召回省 token 吗?
 *   **效用**:召回改变行为吗?
 *
 * ## 先钉死一条会毁掉整个实验的直觉
 *
 * **召回本身只花不省。** 注入 k 条 fact 就是净增 token。它"省"的唯一方式是**替代掉**
 * 一次本来要做的搜索或重读。所以真正的问题不是「记忆省不省」,是「省下的搜索够不够付召回的钱」。
 * 因此成本读数必须是**总** token(含全部工具调用),只量注入块大小等于没量。
 *
 * ## 单一变量
 *
 * 召回块**在 / 不在**。其余逐字节相同:同 prompt、同座位、同温度、同 seed 序。
 * ⚠ 不许顺手改 `k` 或 `maxCharsPerFact` —— 一次动两个,塌了分不清是谁。
 *
 * ## 语料两类,**两类都跑**(只跑第一类 = 选择性取样)
 *
 * | 类 | 含义 | 为什么非有不可 |
 * |---|---|---|
 * | `anchored` | 库里**有**能帮上忙的 fact | 召回的最好情况。只测这一类会系统性高估它 |
 * | `cold` | 库里**没有**相关 fact | 真实使用里的多数。这里召回是纯成本 —— 而且可能**误导** |
 *
 * `cold` 类里那条「召回的无关事实把答案带偏了吗」是**最容易不去测、而风险最大**的一格。
 *
 * ## 预先声明的判别式(动手前钉死;事后再定判据 = 没判据)
 *
 * n=3 每臂每题,取中位数。
 *
 * **anchored 类**
 * - 召回**有用** ⟺ oracle 命中率 B − A ≥ `MIN_ORACLE_LIFT`(0.30)**且** token 涨幅 ≤ `MAX_COST_RATIO_ANCHORED`(1.20×)
 * - 召回**没用** ⟺ oracle 命中率差 < 0.10(行为没变)**或** token 涨幅 > 1.50×
 * - 两者都不成立 → 记「本轴判不动」,**不硬下结论**
 *
 * **cold 类**
 * - 召回**无害** ⟺ token 涨幅 ≤ `MAX_COST_RATIO_COLD`(1.10×)**且** oracle 命中率不降
 * - 召回**有害** ⟺ oracle 命中率**降**(无关事实误导了)—— 这一条单独成立就足以否掉常开召回
 *
 * ## oracle 必须是机械的
 *
 * 每道题带一个**确定性**判据函数(正则 / 子串 / 结构检查),零 LLM 判官。
 * **不许**问模型"你用到记忆了吗" —— `memory-inject.ts:60` 已经写过这条:
 * ACTION CHANGED 无真值,只有代理指标。
 *
 * ## 它量的是什么、不量什么
 *
 * 量:**同一段上下文里多了这几条 fact,产出和成本变了多少**。
 * 不量:整条 chat 管线(那还有 transformContext 的时机、前缀缓存命中等一堆混杂变量)。
 * 也**不碰** `MEMORY_REQUERY` —— 那是 owner 的 M1 观察窗(至 2026-09-01)量的东西,
 * 本装置跑隔离 goal,不污染它的观察对象。
 *
 * ```bash
 * bun run scripts/memory-recall-ab.ts --dry-run          # 零模型:验管线 + 打印判别式
 * bun run scripts/memory-recall-ab.ts --seat <coord>     # 真跑
 * ```
 *
 * @module
 */
import '../src/harness/script-bootstrap';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from '../src/model';
import { createOmdMemory } from '../src/harness/memory';
import { HOST_SAFEGUARD } from '../src/memory/safeguards/namespaces';
import { resolveMemoryDbPath } from '../src/harness/memory/db-path';
import { formatRecall } from '../src/harness/chat/memory-inject';

// ── 预先声明的判别式 ────────────────────────────────────────────────────────
export const VERDICT = {
  /** anchored: B 比 A 的 oracle 命中率至少高这么多才算"有用"。 */
  MIN_ORACLE_LIFT: 0.3,
  /** anchored: 命中率差小于它 = 行为没变 = 没用。 */
  NO_LIFT_BAND: 0.1,
  /** anchored: 允许的 token 涨幅上限。 */
  MAX_COST_RATIO_ANCHORED: 1.2,
  /** anchored: 超过它直接判"没用"(再有用也付不起)。 */
  COST_VETO_ANCHORED: 1.5,
  /** cold: 无关任务上召回几乎不该花钱。 */
  MAX_COST_RATIO_COLD: 1.1,
} as const;

/**
 * ## 任务有效性(EVAL-PROTOCOL §4 —— 首版漏了这一条)
 *
 * **先证任务有区分度, 再谈召回有没有用。** 对照臂(A)成功率:
 * - **≤0.60** → 有区分度, 读数可当能力结论;
 * - **≥0.80** → 任务太易, 本轮只算**任务校准失败**, 判词一律降为"不得当能力结论用";
 * - **中间灰带 0.60–0.80** → 判"边缘成立", 结论降级为**方向性**(协议原话:灰带口径要定死,
 *   参考实现 v2 的 62.5% 恰落灰带就是判据设计缺陷)。
 */
export const TASK_VALIDITY = { discriminating: 0.6, tooEasy: 0.8 } as const;

/** 每臂每题重复次数;取中位数(与本仓既有 ab 协议同口径)。 */
export const N_REPEAT = 3;
/** 召回条数。**不是本次的变量** —— 动它要另开一跑。 */
export const RECALL_K = 5;

// ── 语料 ────────────────────────────────────────────────────────────────────

export interface AbTask {
  id: string;
  /** `anchored` = 库里有能帮上忙的 fact;`cold` = 没有。 */
  klass: 'anchored' | 'cold';
  /** 给两臂**逐字相同**的任务文本。 */
  prompt: string;
  /** 召回用的查询(仅 B 臂用到)。 */
  recallQuery: string;
  /**
   * 机械 oracle:产出是否算"对"。**零 LLM。**
   * 返回 true = 命中。写的时候问自己:知道那条 fact 与不知道,这个函数会给出不同答案吗?
   * 答不上来 = 这道题测不出东西,别放进语料。
   */
  oracle: (output: string) => boolean;
  /**
   * **带工具的任务**(2026-08-28 补)。给了这个钩子, 本题就走多轮搜索循环而不是单发。
   *
   * ## 为什么非有不可
   *
   * 前两跑的成本读数结构上**只量得到"召回花多少", 量不到"召回省多少"** —— 单发调用里
   * 根本没有工具调用可省, 而"省下的搜索够不够付召回的钱"才是真问题。这一格补的就是它:
   * A 臂不知道答案 → 必须搜 → 每一轮搜索**把累积对话重发一遍**;B 臂事实已在上下文里 →
   * 可能一轮直接答。省不省在这里才第一次有可能出现。
   *
   * 不是原生 tool-calling(`ModelRequest` 没有 tools 字段), 是文本协议循环。承重性质相同:
   * 多一轮就多重发一次累积对话 —— 与本仓「大内容进 prompt 不进工具环」那条读数同一个机制。
   */
  search?: (query: string) => string;
}

/**
 * 两臂共用的输出契约。**刻意要求 JSON** —— 这样 oracle 是**字段检查**而不是中文正则。
 * 正则判中文散文太脆:换个说法就误判,而误判会被读成"召回没用"。
 */
/** cold 真值 —— 全部用脚本算过(见同名 test 里的自证), 不是心算的。 */
const COLD_R_COUNT = 20;
const COLD_MOD_CHAIN = 191;
const COLD_BRACKET_DEPTH = 4;

const JSON_TAIL = '\n\n只输出一个 JSON 对象,不要任何解释文字、不要 markdown 代码围栏。';

/** 从模型输出里抠出第一个 JSON 对象;抠不出 = 这一发不算命中(不是判据放宽的理由)。 */
function parseJson(out: string): Record<string, unknown> | null {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 语料。每道 anchored 题在注释里指名它靠库里**哪一条 fact**(id 来自 `.omd/memory.db`,
 * 2026-08-28 dream 固化产出)—— 不指名的话 "anchored" 这个标签是自封的,分类读数就作废。
 *
 * ⚠ 三道 cold 题**必须**与库里内容无关。它们量的是「无关召回的成本与误导」,
 * 那是本装置最容易被省掉、而风险最大的一半。
 */
export const CORPUS: AbTask[] = [
  // ── anchored ──────────────────────────────────────────────────────────────
  //
  // 三道题全部围绕库里那对**互斥条件分支**(2026-08-28 dream 重抽产出):
  //   · 有内环轮的图 STALLED → 加 maxRounds 后 resume        (bd7d2e1b, worked)
  //   · 平铺图/直通v2(无内环轮)→ 加 maxRounds **无效**,
  //     应看摘要里哪个切片节点红了(RED/GREEN/accept), 修 SDD 或实装后**同 runId** resume
  //     复用绿节点                                            (1585f735 / 7eacc667 / 4429c14a, worked)
  // 库里另有约 10 条 `failed` 记着**踩这个坑的现场**(f837e722 / ecf3683c / 70314994 …):
  // 对平铺图照搬"加 maxRounds"。
  //
  // 为什么这对分支是好 oracle:**默认答案对一支是错的**。系统自己的通用处方就是"加 maxRounds",
  // 所以不知道这条 fact 的臂会照着说 —— 而那正是库里记着的那个坑。
  //
  // ⚠ a1/a2 是**成对**的(平铺 / 嵌套), 缺一不可:只留平铺那道的话, 召回臂只要"总选反常答案"
  // 就能拿满分, 而那不是懂了, 是偏置。a2 罚的就是这种偏置。
  {
    id: 'a1-flat-graph-stalled',
    klass: 'anchored',
    recallQuery: '平铺图 直通v2 STALLED 加 maxRounds 无效 切片节点 resume',
    prompt:
      '一个 omd plan 跑成 not-converged (STALLED):rounds=0,冻结判据没过。' +
      '该图是**平铺图(直通v2),没有内环轮**。下一步该做什么?' +
      '用 JSON: {"action":"add_max_rounds"|"inspect_slice_nodes","resumeSameRunId":true|false}。' + JSON_TAIL,
    // 命中 = 不加轮数、去看切片节点状态, 且 resume 复用同 runId 的绿节点。
    oracle: (out) => {
      const j = parseJson(out);
      return j?.action === 'inspect_slice_nodes' && j?.resumeSameRunId === true;
    },
  },
  {
    id: 'a2-nested-graph-stalled',
    klass: 'anchored',
    recallQuery: '非平铺图 有内环轮 STALLED 加 maxRounds resume 再给几轮',
    prompt:
      '一个 omd plan 跑成 not-converged (STALLED):rounds=0,冻结判据没过。' +
      '该图**有内环轮(不是平铺图)**。下一步该做什么?' +
      '用 JSON: {"action":"add_max_rounds"|"inspect_slice_nodes","resumeSameRunId":true|false}。' + JSON_TAIL,
    // 命中 = 这一支加轮数**才是对的**。反偏置闸:只会选反常答案的臂在这里会红。
    oracle: (out) => parseJson(out)?.action === 'add_max_rounds',
  },
  {
    // 靠 5fc7a046 / d09151d0「spec 契约未落盘 → 下游 execute 拿不到、未能收敛」= failed
    //
    // ⚠ 首版问法是「设计一个 plan, 给出 output_type」—— 两臂都 0.00。查了召回内容:
    // **前四条全是对的 fact**, 所以不是没召到, 是召到了也没改变答案。fact 说的是
    // 「没落盘会失败」, 没直说「该填 output_type: file」, 中间那一跳要模型自己接。
    // 改成直接问 fact 记着的那件事本身:上游没落盘、下游拿不到, 该怎么修。
    id: 'a3-spec-not-on-disk-fix',
    klass: 'anchored',
    recallQuery: 'spec 契约 未落盘 下游 execute 拿不到 spec 文件 未收敛',
    prompt:
      '一个两段 plan:`spec` 节点产出了实现契约,但**只写在节点正文里、没有落成文件**;' +
      '下游 `execute` 拿不到 spec 文件,跑成 not-converged。该怎么修?\n' +
      '用 JSON: {"fix":"spec_writes_file"|"execute_reads_upstream_text"|"merge_into_one_node"}。' +
      JSON_TAIL,
    // 命中 = 让 spec 真的写文件。另两个选项分别是"下游兜底读正文"(库里记着这条正是失败现场)
    // 与"合成一个节点"(绕开问题)。
    oracle: (out) => parseJson(out)?.fix === 'spec_writes_file',
  },


  // ── cold(与库里内容无关)────────────────────────────────────────────────
  //
  // ⚠ 前两版 cold 题(罗马数字 / 星期几 / GROUP BY / 工作日 / 进制 / 正则)**两次**都是
  // A=1.00, 协议 §4 判「任务校准失败」。换成 LLM 的结构性弱项:逐字符计数、长串多步累积。
  // 这类题难不在知识, 在**逐位不出错**, 所以模型强也不会到顶 —— 而它与库里那 406 条
  // plan-family / oracle 教训**毫无关系**, cold 的身份不变。
  {
    id: 'c1-char-count',
    klass: 'cold',
    recallQuery: '字符 计数 统计 出现次数',
    prompt:
      '数下面这串字符里字母 r 出现了多少次(区分大小写, 只数小写 r):\n' +
      'strawberry-raspberry-rhubarb-ररr-rrarrbrr-berry-rrr\n' +
      '用 JSON: {"count": <整数>}。' + JSON_TAIL,
    oracle: (out) => parseJson(out)?.count === COLD_R_COUNT,
  },
  {
    id: 'c2-modular-chain',
    klass: 'cold',
    recallQuery: '取模 累积 计算 链式',
    prompt:
      '令 x0 = 7。对 i = 1..12 迭代 xi = (xi-1 * 31 + 17) mod 1000。给出 x12。' +
      '用 JSON: {"x12": <整数>}。' + JSON_TAIL,
    oracle: (out) => parseJson(out)?.x12 === COLD_MOD_CHAIN,
  },
  {
    id: 'c3-bracket-depth',
    klass: 'cold',
    recallQuery: '括号 嵌套 深度 匹配',
    prompt:
      '下面这串括号的**最大嵌套深度**是多少(只算圆括号, 方括号与花括号一律忽略)?\n' +
      '(a[b(c{d(e)f}g)h]i(j(k(l)m)n)o)\n' +
      '用 JSON: {"depth": <整数>}。' + JSON_TAIL,
    oracle: (out) => parseJson(out)?.depth === COLD_BRACKET_DEPTH,
  },

  // ── tool(带工具:唯一可能量到"召回省了一次搜索"的一格)────────────────
  //
  // A 臂不知道答案 ⇒ 必须 SEARCH ⇒ 每多一轮就把累积对话重发一遍;
  // B 臂事实已在上下文 ⇒ 可能一轮直接 ANSWER。**省不省在这里才第一次有可能出现。**
  {
    // 靠库里那对互斥分支(1585f735 / bd7d2e1b)—— 与 a1/a2 同一条 fact, 但这次
    // A 臂有路可走(能搜到 runbook), 所以量的是"搜一趟 vs 已经知道"的差价。
    id: 't1-stalled-runbook',
    klass: 'anchored',
    recallQuery: '平铺图 直通v2 STALLED 加 maxRounds 无效 切片节点 resume',
    prompt:
      '一个 omd plan 跑成 not-converged (STALLED), rounds=0, 冻结判据没过, ' +
      '图是**平铺图(直通v2), 没有内环轮**。下一步该做什么?' +
      '最终答案用 JSON: {"action":"add_max_rounds"|"inspect_slice_nodes"}。',
    search: (q) => {
      const k = q.toLowerCase();
      if (k.includes('平铺') || k.includes('flat') || k.includes('直通') || k.includes('内环') || k.includes('stalled')) {
        return (
          'docs/runbook/stalled.md:\n' +
          '- 图有内环轮 → 加 maxRounds 后 resume, 再给几轮。\n' +
          '- 平铺图(直通v2)没有内环轮 → **加 maxRounds 无意义**。\n' +
          '  改为看摘要里哪个切片节点红了 (RED/GREEN/accept), 修 SDD 或实装后同 runId resume。'
        );
      }
      return '(无匹配结果)';
    },
    oracle: (out) => parseJson(out)?.action === 'inspect_slice_nodes',
  },
];

// ── 跑 ──────────────────────────────────────────────────────────────────────

interface ArmResult {
  taskId: string;
  klass: AbTask['klass'];
  arm: 'A-no-recall' | 'B-recall';
  /** 中位数 token(总量:prompt + completion)。 */
  tokens: number;
  /** oracle 命中率(n 次里命中几次 / n)。 */
  oracleRate: number;
  /** 中位数墙钟毫秒。 */
  wallMs: number;
  /** 中位数前缀缓存命中 token。 */
  cacheHit: number;
  /** 带工具的题:中位搜索轮数。单发题 = null(不适用 ≠ 1)。 */
  rounds: number | null;
  /** B 臂召回到几条(A 臂恒 0)。**0 与"没召回"要分得开** —— A 臂记 null。 */
  hits: number | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 搜索循环的轮数上限。到顶还没答 = 这一发不算命中(不是判据放宽的理由)。 */
const MAX_SEARCH_ROUNDS = 4;

/** 文本协议:模型每轮要么 `SEARCH: <query>`, 要么 `ANSWER: <json>`。 */
const TOOL_PROTOCOL =
  '\n\n你可以搜索仓库。每一轮**只输出一行**, 二选一:\n' +
  '  SEARCH: <关键词>   ← 想查资料时\n' +
  '  ANSWER: <JSON>     ← 已经能答了\n' +
  '别输出别的。';

/** 跑一发带搜索的多轮循环, 返回 {文本, 累计 token, 累计 cacheHit, 轮数}。 */
async function runSearchLoop(
  task: AbTask,
  seat: string,
  firstPrompt: string,
): Promise<{ text: string; tokens: number; cacheHit: number; rounds: number }> {
  let convo = firstPrompt + TOOL_PROTOCOL;
  let tokens = 0;
  let cacheHit = 0;
  for (let round = 1; round <= MAX_SEARCH_ROUNDS; round++) {
    const res = await callModel({ model: seat, messages: [{ role: 'user', content: convo }], temperature: 0 });
    const u = res.usage as { in?: number; out?: number; cacheHit?: number } | undefined;
    if (typeof u?.in !== 'number' || typeof u?.out !== 'number') {
      throw new Error(`usage 形状不认得: ${JSON.stringify(u)}`);
    }
    tokens += u.in + u.out;
    cacheHit += u.cacheHit ?? 0;
    const line = String(res.text ?? '').trim();
    const ans = line.match(/ANSWER:\s*([\s\S]*)/);
    if (ans) return { text: ans[1]!, tokens, cacheHit, rounds: round };
    const q = line.match(/SEARCH:\s*(.+)/);
    if (!q) return { text: line, tokens, cacheHit, rounds: round }; // 不守协议 → 交给 oracle 判(多半红)
    // 搜索结果**追加进同一段对话** —— 下一轮把整段重发, 这就是工具环的成本所在。
    convo += `\n\n[你上一轮] SEARCH: ${q[1]}\n[搜索结果]\n${task.search!(q[1]!.trim())}`;
  }
  return { text: '', tokens, cacheHit, rounds: MAX_SEARCH_ROUNDS }; // 到顶没答 = 不算命中
}

async function runArm(task: AbTask, arm: ArmResult['arm'], seat: string, recallBlock: string | null): Promise<ArmResult> {
  const tokens: number[] = [];
  const walls: number[] = [];
  /** 前缀缓存命中 token —— 成本问题的另一半(缓存读价远低于新发)。 */
  const cacheHits: number[] = [];
  let hitCount = 0;
  const roundCounts: number[] = [];
  for (let i = 0; i < N_REPEAT; i++) {
    const prompt = recallBlock ? `${recallBlock}\n\n${task.prompt}` : task.prompt;
    const t0 = Date.now();
    if (task.search) {
      const r = await runSearchLoop(task, seat, prompt);
      walls.push(Date.now() - t0);
      tokens.push(r.tokens);
      cacheHits.push(r.cacheHit);
      roundCounts.push(r.rounds);
      if (task.oracle(r.text)) hitCount++;
      continue;
    }
    // 字段名是 `model` 不是 `coord`(`ModelRequest.model` = 'provider:modelId')。
    // temperature 钉死:两臂唯一的差别必须是召回块在不在, 采样随机性会把小的 lift 淹掉。
    const res = await callModel({
      model: seat,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });
    walls.push(Date.now() - t0);
    // ⚠ usage 的真实形状是 `{in, out, cacheHit}`(实测 minimax 座位)。首版猜成
    // `inputTokens/outputTokens`, 于是**整跑的成本读数全是 0** —— 而 0 与"没认出字段"
    // 长得一模一样(仓规坑①)。所以这里**认不出就抛**, 不许默认 0:
    // 一个恒 0 的成本读数比没有读数更糟, 它会让"召回不花钱"这个错结论看起来有证据。
    const u = res.usage as { in?: number; out?: number; cacheHit?: number } | undefined;
    if (typeof u?.in !== 'number' || typeof u?.out !== 'number') {
      throw new Error(`usage 形状不认得: ${JSON.stringify(u)} — 成本读数会变成 0, 拒绝继续(改这里的字段名)`);
    }
    tokens.push(u.in + u.out);
    cacheHits.push(u.cacheHit ?? 0);
    if (task.oracle(String(res.text ?? ''))) hitCount++;
  }
  return {
    taskId: task.id,
    klass: task.klass,
    arm,
    tokens: median(tokens),
    oracleRate: hitCount / N_REPEAT,
    wallMs: median(walls),
    cacheHit: median(cacheHits),
    // 带工具的题才有轮数;单发题记 null(**不是 1** —— "不适用"与"一轮"是两件事)。
    rounds: roundCounts.length > 0 ? median(roundCounts) : null,
    hits: recallBlock === null ? null : RECALL_K,
  };
}

/** 判词。**三种结局都要能说出口** —— 只认好消息的实验没有信息量。 */
export function judge(rows: ArmResult[]): string[] {
  const out: string[] = [];

  // ── 逐题先出一行(EVAL-PROTOCOL §6「分层写, 不熔账」)────────────────────
  // ⚠ 首版只出按类聚合的两行, 实测把一个真信号埋了:a1 是 0.00→0.67(召回真的改了行为),
  // 而 a2/a3 两臂都是 1.00(题到顶, 没有 headroom)。三题一平均, +0.67 被稀释成 +0.22,
  // 读起来像"召回几乎没用"。**天花板题会伪装成没有增益。**
  const ids = [...new Set(rows.map((r) => r.taskId))];
  for (const id of ids) {
    const ra = rows.find((r) => r.taskId === id && r.arm === 'A-no-recall');
    const rb = rows.find((r) => r.taskId === id && r.arm === 'B-recall');
    if (!ra || !rb) continue;
    const ceil = ra.oracleRate >= 1 ? ' ⚠对照臂到顶, 这题量不出增益' : '';
    out.push(
      `  · ${id}: A=${ra.oracleRate.toFixed(2)} B=${rb.oracleRate.toFixed(2)} ` +
        `(${rb.oracleRate - ra.oracleRate >= 0 ? '+' : ''}${(rb.oracleRate - ra.oracleRate).toFixed(2)}) ` +
        `token ${ra.tokens}→${rb.tokens} (+${rb.tokens - ra.tokens})${ceil}`,
    );
  }

  for (const klass of ['anchored', 'cold'] as const) {
    const a = rows.filter((r) => r.klass === klass && r.arm === 'A-no-recall');
    const b = rows.filter((r) => r.klass === klass && r.arm === 'B-recall');
    if (a.length === 0 || b.length === 0) {
      out.push(`${klass}: 无读数 (NULL, 不是 0)`);
      continue;
    }
    const aTok = median(a.map((r) => r.tokens));
    const bTok = median(b.map((r) => r.tokens));
    const ratio = aTok === 0 ? Number.NaN : bTok / aTok;
    const aRate = a.reduce((s, r) => s + r.oracleRate, 0) / a.length;
    const bRate = b.reduce((s, r) => s + r.oracleRate, 0) / b.length;
    const lift = bRate - aRate;
    const head = `${klass}: oracle A=${aRate.toFixed(2)} B=${bRate.toFixed(2)} (lift ${lift >= 0 ? '+' : ''}${lift.toFixed(2)}) · token ${aTok}→${bTok} (${ratio.toFixed(2)}×)`;

    // 任务有效性先判 —— 任务太易的话下面那些判词一条都不成立(EVAL-PROTOCOL §4)。
    if (aRate >= TASK_VALIDITY.tooEasy) {
      out.push(`${head} → **任务校准失败**(对照臂 ${aRate.toFixed(2)} ≥ ${TASK_VALIDITY.tooEasy}, 题太易)—— 本轮不得当能力结论用`);
      continue;
    }
    const dim = aRate > TASK_VALIDITY.discriminating ? '(灰带, 结论仅方向性) ' : '';

    // ⚠ 灰带限定词贴在**每一种**结论上。首版只贴在"有用/无害"两支 —— 那等于说
    // 好消息要打折、坏消息可以照收, 是单向的判据松紧, 本仓 P-1 那一族的形状。
    if (klass === 'anchored') {
      if (ratio > VERDICT.COST_VETO_ANCHORED) out.push(`${head} → ${dim}**没用**(成本否决: >${VERDICT.COST_VETO_ANCHORED}×)`);
      else if (lift >= VERDICT.MIN_ORACLE_LIFT && ratio <= VERDICT.MAX_COST_RATIO_ANCHORED) out.push(`${head} → ${dim}**有用**`);
      else if (Math.abs(lift) < VERDICT.NO_LIFT_BAND) out.push(`${head} → ${dim}**没用**(行为没变)`);
      else out.push(`${head} → **本轴判不动**(落在预声明判据之间, 不硬下结论)`);
    } else {
      if (lift < -VERDICT.NO_LIFT_BAND) out.push(`${head} → ${dim}**有害**(无关召回把答案带偏了 — 单这一条就足以否掉常开召回)`);
      else if (ratio <= VERDICT.MAX_COST_RATIO_COLD) out.push(`${head} → ${dim}**无害**`);
      else out.push(`${head} → ${dim}**纯成本**(无关任务上涨了 ${((ratio - 1) * 100).toFixed(0)}%)`);
    }
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
//
// ⚠ 用 `import.meta.main` 包住:不包的话 `import { CORPUS }` 会**顺带把整跑跑起来**,
// 于是 oracle 判别力自证(协议必做的那一步)自己就要先烧一遍模型。

if (!import.meta.main) {
  // 被 import 当模块用(判别力自证 / 测试)—— 只导出, 不跑。
} else {

const dryRun = process.argv.includes('--dry-run');
const seatIdx = process.argv.indexOf('--seat');
const seat = seatIdx >= 0 ? process.argv[seatIdx + 1]! : process.env.OMD_AB_SEAT ?? '';

console.log('== 预先声明的判别式 (动手前钉死) ==');
console.log(JSON.stringify(VERDICT, null, 2));
console.log(`n=${N_REPEAT} 每臂每题, 取中位数 · 召回 k=${RECALL_K} (本跑不是变量)`);
console.log(`语料: anchored ${CORPUS.filter((t) => t.klass === 'anchored').length} 题 · cold ${CORPUS.filter((t) => t.klass === 'cold').length} 题`);

if (CORPUS.length === 0) {
  console.log('\n语料还是空的 —— 装置在, 题没写。照 templates/packs/EVAL-PROTOCOL.md 的隐藏 oracle 三规则填 CORPUS。');
  console.log('每道 anchored 题要在注释里写清它靠库里**哪一条 fact**(带 id), 否则这个标签是自封的。');
  process.exit(0);
}
if (dryRun) {
  console.log('\n-- DRY-RUN: 零模型调用, 只验管线 --');
  const memory = createOmdMemory({ path: resolveMemoryDbPath(process.env), safeguard: HOST_SAFEGUARD });
  for (const t of CORPUS) {
    const hits = await memory.retrieve(t.recallQuery, RECALL_K);
    const block = formatRecall(hits, 400);
    console.log(`  [${t.klass}] ${t.id}: 召回 ${hits.length} 条 / 注入块 ${block?.length ?? 0} 字符`);
  }
  memory.close();
  process.exit(0);
}
if (!seat) {
  console.error('缺座位: --seat <provider:model> 或 OMD_AB_SEAT');
  process.exit(2);
}

const memory = createOmdMemory({ path: resolveMemoryDbPath(process.env), safeguard: HOST_SAFEGUARD });
const rows: ArmResult[] = [];
for (const task of CORPUS) {
  const hits = await memory.retrieve(task.recallQuery, RECALL_K);
  const block = formatRecall(hits, 400);
  // A 臂**先**跑 —— 基线要量在同一条件下, 而且不受 B 臂任何副作用影响。
  rows.push(await runArm(task, 'A-no-recall', seat, null));
  rows.push(await runArm(task, 'B-recall', seat, block));
  console.log(`  ${task.id} 跑完 (召回 ${hits.length} 条)`);
}
memory.close();

const verdicts = judge(rows);
console.log('\n== 判词 ==');
for (const v of verdicts) console.log('  ' + v);

mkdirSync('runs', { recursive: true });
const outPath = join('runs', `memory-recall-ab-${Date.now()}.json`);
writeFileSync(outPath, `${JSON.stringify({ seat, verdict: VERDICT, nRepeat: N_REPEAT, k: RECALL_K, rows, verdicts }, null, 2)}\n`);
console.log(`\n读数写入 ${outPath} — 两侧都记(塌与不塌都是读数)。`);
}
