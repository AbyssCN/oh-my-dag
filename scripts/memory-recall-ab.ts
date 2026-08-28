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
}

/**
 * 两臂共用的输出契约。**刻意要求 JSON** —— 这样 oracle 是**字段检查**而不是中文正则。
 * 正则判中文散文太脆:换个说法就误判,而误判会被读成"召回没用"。
 */
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
  {
    // 靠 5fc7a046「spec 节点产出契约却未写入磁盘, 改由下游用正文当契约」= failed
    // 与 d09151d0「上游 spec 契约未落盘时 execute 未能收敛」= failed
    id: 'a1-spec-contract-on-disk',
    klass: 'anchored',
    recallQuery: 'spec 节点 契约 写入磁盘 下游 execute 收敛',
    prompt:
      '设计一个两段式 DAG plan:`spec` 节点产出实现契约,`execute` 节点照契约实现。' +
      '用 JSON 描述,形如 {"nodes":{"spec":{"output_type":"...","goal":"..."},' +
      '"execute":{"depends_on":["spec"],"goal":"..."}}}。' +
      'output_type 可取 "text" | "file" | "git"。' + JSON_TAIL,
    // 命中 = spec 的产物落到文件(而不是让下游读上游正文)。
    oracle: (out) => {
      const j = parseJson(out);
      const spec = (j?.nodes as Record<string, { output_type?: unknown }> | undefined)?.spec;
      return spec?.output_type === 'file';
    },
  },
  {
    // 靠 e047708f / b557cbab「verify 在实装前已通过 → O-6 vacuous-verify」= failed
    id: 'a2-verify-red-before-impl',
    klass: 'anchored',
    recallQuery: 'verify 实装前已通过 vacuous-verify 切片 冻结判据',
    prompt:
      '给一个**尚未实现**的功能写切片的 verify 命令列表(该功能将新增 src/foo/bar.ts 与 ' +
      'src/foo/bar.test.ts)。用 JSON: {"verify":["cmd1","cmd2"],"redBeforeImpl":true|false}。' +
      'redBeforeImpl 表示这组命令在实装之前是否必然失败。' + JSON_TAIL,
    // 命中 = 自己声明实装前必红, **且** verify 里真的引用了尚不存在的新测试文件。
    oracle: (out) => {
      const j = parseJson(out);
      const v = j?.verify;
      if (!Array.isArray(v) || j?.redBeforeImpl !== true) return false;
      return v.some((c) => typeof c === 'string' && c.includes('bar.test.ts'));
    },
  },
  {
    // 靠 80c6dc6a / df03d2f1「交付物闸节点未完成 → 声明的 outputs 未全部 done」= failed
    id: 'a3-outputs-exclude-gate',
    klass: 'anchored',
    recallQuery: 'outputs 声明 交付物闸 gate 节点 未完成 无法交付',
    prompt:
      '一个 plan 有三个节点:`impl`(写代码, output_type=file)、`gate`(跑 bun test 的闸, ' +
      'executor=command)、`doc`(写文档, output_type=file)。该把哪些节点列进 plan.outputs?' +
      '用 JSON: {"outputs":["..."],"why":"一句话"}。' + JSON_TAIL,
    // 命中 = 闸节点**不**进 outputs(它是判据不是交付物;进了就会因为它没 done 而整体判失败)。
    oracle: (out) => {
      const j = parseJson(out);
      const o = j?.outputs;
      if (!Array.isArray(o) || o.length === 0) return false;
      return !o.includes('gate') && o.includes('impl');
    },
  },

  // ── cold(与库里内容无关)────────────────────────────────────────────────
  //
  // ⚠ 首版三题(罗马数字 / 星期几 / GROUP BY)实测对照臂 **A=1.00** —— 协议 §4 判「任务校准
  // 失败」, 读数不得当结论用。换成下面三题:难度够(有多步算术/边界), oracle 仍是结构检查,
  // 且与库里那 145 条 plan-family / oracle 教训**毫无关系**。
  {
    id: 'c1-workdays-between',
    klass: 'cold',
    recallQuery: '工作日 天数 计算 节假日',
    prompt:
      '算 2026-03-02(含)到 2026-04-17(含)之间的工作日天数:周一至周五算工作日, ' +
      '但要扣掉这三天假期 2026-04-03、2026-04-06、2026-03-30(它们都落在工作日上)。' +
      '用 JSON: {"workdays": <整数>}。' + JSON_TAIL,
    // 真值 35:2026-03-02 是周一, 到 04-17 周五共 7 整周 = 35 个工作日, 扣 3 天假 = 32。
    oracle: (out) => parseJson(out)?.workdays === 32,
  },
  {
    id: 'c2-base-convert',
    klass: 'cold',
    recallQuery: '进制 转换 十二进制',
    prompt: '把十进制 48879 转成**十二进制**(用 0-9 与 A、B 两个字母)。用 JSON: {"base12":"..."}。' + JSON_TAIL,
    // 48879 = 2*12^4 + 4*12^3 + 3*12^2 + 5*12 + 3 → "24353"
    oracle: (out) => String(parseJson(out)?.base12 ?? '').toUpperCase() === '24353',
  },
  {
    id: 'c3-regex-boundary',
    klass: 'cold',
    recallQuery: '正则 匹配 边界',
    prompt:
      '写一个 JavaScript 正则(不带 / /,只给正则体),要求:匹配 "a1b" "a12b" "a123b",' +
      '但**不**匹配 "ab" "a1234b" "x1b" "a1bc"。用 JSON: {"re":"..."}。' + JSON_TAIL,
    // 机械判:真的把它编译出来跑一遍七个样本。不判它长什么样, 只判它的行为。
    oracle: (out) => {
      const src = String(parseJson(out)?.re ?? '');
      if (!src) return false;
      try {
        const re = new RegExp(src.startsWith('^') ? src : `^${src}$`);
        const yes = ['a1b', 'a12b', 'a123b'];
        const no = ['ab', 'a1234b', 'x1b', 'a1bc'];
        return yes.every((t) => re.test(t)) && no.every((t) => !re.test(t));
      } catch {
        return false;
      }
    },
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
  /** B 臂召回到几条(A 臂恒 0)。**0 与"没召回"要分得开** —— A 臂记 null。 */
  hits: number | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function runArm(task: AbTask, arm: ArmResult['arm'], seat: string, recallBlock: string | null): Promise<ArmResult> {
  const tokens: number[] = [];
  const walls: number[] = [];
  /** 前缀缓存命中 token —— 成本问题的另一半(缓存读价远低于新发)。 */
  const cacheHits: number[] = [];
  let hitCount = 0;
  for (let i = 0; i < N_REPEAT; i++) {
    const prompt = recallBlock ? `${recallBlock}\n\n${task.prompt}` : task.prompt;
    const t0 = Date.now();
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
