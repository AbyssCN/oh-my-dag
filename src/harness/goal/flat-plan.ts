/**
 * src/harness/goal/flat-plan —— L1 免仪式平铺 (SDD 2026-08-31, owner 已裁)
 *
 * 承接 `docs/research/2026-08-30-conductor-无训练编排设计.md` §3.5
 * (grill+council runId 8b20caab 已裁) + `runs/2026-08-31-编排分级口径审计.md`
 * 档位去留结论。本片 = 平铺规划与编译的**纯函数**, 不接 execute 段 (那是片 3)。
 *
 * D-1 L1 论据 = 免仪式, 不是掰直假串行。审计实测假串行 1/64 = 1.6%,
 * 「可并行被串行」近乎为零; L1 的空间在 oracle-L1 形状 (多 leaf、无跨步产物
 * 依赖、无写集交叠, 89/124) 的图仪式免除。
 *
 * D-2 挂既有直执接缝, 不造新执行路 (council I-5): 平铺 plan 就是一份
 * ConductorPlan 实例, 走 `runExecutorDagWithPlan` 预构造入口执行, 零新 IR。
 * 新增唯一 schema 字段 complexity (由本编译器写入, 不让重仪式 conductor 自己
 * 声明 —— 路由权在 config, 不在模型; 字段类型与枚举在片 2)。
 *
 * D-3 轻规划 = 单发 generate, 无 tool-loop。审计 Q1: conductor 输入大头是多
轮
 * tool-loop 上下文重发 (cache-hit 93.8%), 静态段只占 ~4% —— 省的办法是不开
环,
 * 不是削 prompt。
 *
 * D-4 合并步 schema_only, 同源自综合编译期拒 (council I-3): 平铺编译器**不生
成**
 * 任何「用 worker 同源模型综合子答案」的节点; 合并 = 引擎既有 fan-in 机械视图
 * + 验收节点。需要文本综合时交 verifier 家族座位, 不进本契约第一版。
 *
 * ## 三件套
 *
 *   ① `buildFlatPlanPrompt(goal, criteria)` → string
 *      单发轻规划 prompt 构造 (goal + 冻结判据块 + 2 个平铺 few-shot 样例,
      样例写死在文件内, owner 裁 §3.3: few-shot 保留, 论文消融 LCB -9.4)。
 *
 *   ② `parseFlatPlanOutput(text)` → readonly FlatSubtask[]
 *      三列表 (子任务文本 / leaf 类型 / 可见性) 的解析器, 表头/分隔/数据
      三段式, 缺段 → throw (与 sdd-direct 同款 fail-loud)。
 *
 *   ③ `compileFlatPlan(subtasks, opts)` → ConductorPlan
 *      纯函数: 解析后的子任务 → 合法 ConductorPlan。节点全 executor agent、
 *      depends_on 空 (D-1: 平铺 = 无依赖并行); 合并 = 机械 fan-in (accept
 *      节点 depends_on 收所有子任务), 不生成综合节点, 违规形状 (worker 同
源
 *      模型综合子答案) 具名拒, 错误文本含「同源综合」(GWT-2)。
 *
 * ## 反向自检的统一形状 (本仓惯例, 同 sdd-compile.test)
 *
 * 每条闸配一份**已知违规样本** (assertNotSynthesis / assertParseShape),
 * 证伪方式写在测试注释里 —— 把该闸删掉, test 当场由绿转红。
 */
import { PlanSchema, type ConductorPlan } from '../conductor-plan';

// ── 公开形状 ──────────────────────────────────────────────────────────────

/**
 * 平铺子任务 (轻规划输出的解析结果, 也是编译器的输入)。
 *
 * D-1: 「N 个无依赖 agent leaf」= 全部 executor:'agent' + depends_on 空,
 * 子任务彼此不互相等 —— 由 D-4 「合并 = 机械 fan-in」这条语义保证。
 */
export interface FlatSubtask {
  /** 子任务文本 (进 agent leaf goal, 不动一字)。 */
  readonly text: string;
  /**
   * leaf 类型 (agent 模板名 / profile 名 / 空字符串 = 不写节点字段)。
   * 编译时若非空 → 写进 `template` 字段, 由 agent-templates 注册表按名选卡
   * (TPL-2 未知名被 parsePlan 拒, 这里是字符串原样写入, 校验留给执行期)。
   */
  readonly kind: string;
  /**
   * 可见性 = output_type: file/structured/git/none。
   * 编译时直接进 `output_type` 字段, 缺失 = 'file' (默认)。
   */
  readonly visibility: 'file' | 'structured' | 'git' | 'none';
}

export interface FlatPromptOptions {
  /** 冻结判据块 (goal 之外的命令/路径/产物描述; 进 prompt 给轻规划看的「约束」)。 */
  readonly criteria: string;
}

export interface FlatCompileOptions {
  /** 终局验收命令 (与 compileBreakdown 同源: 全量回归只在这一节点跑一次)。 */
  readonly acceptCommand: string;
  /** 终局期望退出码 (缺省 0)。 */
  readonly acceptExpectExit?: number;
  /** plan 名 (缺省 'flat-plan')。 */
  readonly name?: string;
  /**
   * 共享写集 (各 agent leaf 都声明; 全片共同产出范围)。
   * 缺省 = 不写 write_set 字段 (节点级缺席语义, 与 MIRROR RULE 同源)。
   */
  readonly writeSet?: readonly string[];
  /** T-1b: spec anchor 进实施节点 (S-51 修, 跨片契约段变动的语义指纹)。 */
  readonly specAnchor?: string;
}

// ── 同源自综合的形态闸 (D-4) ───────────────────────────────────────────────
//
// 编译期拒的形状: 某个子任务文本自身就是「综合/汇总/合并各子答案」的意思
// —— 平铺编译器不该造这种节点, 真要做文本综合 = 走 verifier 家族座位
// (那是另一张图的另一条路, owner 裁「文本综合合并 = 第一版 schema_only」)。
//
// 形态闸是**文本字面判据**, 不是分类器: 任何让 worker 同源模型综合子答案的
// 形状 = 拒。判词含「同源综合」(GWT-2 逐字要求)。
//
// 触发词组 = 「综合|合并|汇总|synthesis|merge」+「子|各|上述|兄弟|outputs?」
// 这一族词**同时出现** = 综合型。单独出现 (如「综合测试结果」「合并 PR」)
// 不触发 —— 本仓其它契约也会写「合并」二字, 全拒会把合法表述误杀。
//
// 反向自检: 把 `assertNotSynthesis` 整段删掉 → flat-plan.test.ts 的
// 「闸 D-4 同源自综合节点 → 拒」当场红 (GWT-2)。

const SYNTHESIS_PATTERNS: readonly RegExp[] = [
  // 中文: 综合 + 各/子/上述/兄弟
  /综合[各子上述兄弟].{0,8}(答案|结果|意见|产出|输出)/,
  /综合[各子上述兄弟].{0,8}/,
  /合并[各子上述兄弟].{0,8}(答案|结果|意见|产出|输出)/,
  /合并[各子上述兄弟].{0,8}/,
  /汇总[各子上述兄弟].{0,8}/,
  // 英文: synthesis / merge / combine + sub-answer / sibling / outputs
  /synthesi[sz]e?\s+(the\s+)?(sub[-_ ]?answers?|sibling|outputs?)/i,
  /merge\s+(the\s+)?(sub[-_ ]?answers?|sibling|outputs?)/i,
  /combine\s+(the\s+)?(sub[-_ ]?answers?|sibling|outputs?)/i,
];

function assertNotSynthesis(text: string, where: string): void {
  for (const re of SYNTHESIS_PATTERNS) {
    if (re.test(text)) {
      throw new Error(
        `${where} 是同源综合节点 (D-4 / council I-3): "${text.slice(0, 80)}" — ` +
          '平铺编译器不生成「worker 综合子答案」形状的节点; 合并 = 机械 fan-in ' +
          '(accept 节点收所有子任务的 depends_on), 不写文本综合节点。需要文本综合时 ' +
          '走 verifier 家族座位, 不进 L1 第一版。',
      );
    }
  }
}

// ── ① 轻规划 prompt 构造 ──────────────────────────────────────────────────
//
// owner 裁 §3.3: few-shot 保留 (论文消融 LCB -9.4)。2 个平铺 few-shot 样例
// 写死在文件内, 不进 prompt 的 lint 面 / 调试面 —— 它们是模型看的样例,
// 不是给人看的代码。改 few-shot = 改平铺 prompt 的有效载荷, 比改 system
// prompt 风险小一档, 但仍要校验 (D-3: 静态段只占 ~4%, 但这几段是真有效载荷)。
//
// few-shot 设计原则:
//   · **形状对齐**: 子任务数 3-4 个 (L1 oracle-L1 主体), 全 executor agent
//     (不一棵 map / 不一个 conductor), 写集不交叠 (虽然 L1 内不强约束, 但
//     few-shot 把 D-2 「写集列声明」这件事教一遍)。
//   · **反例**: 第二个样例的「错形状」注解教会模型自己别画综合节点 (D-4)。

const FEW_SHOT_OK = `\
# 例子 1 (3 个子任务, 全部 agent, 无综合)
goal: 给 src/parser.ts 加 try/catch 并补 .test.ts
criteria: bun test src/parser.test.ts 退出码 0

| 子任务文本 | leaf 类型 | 可见性 |
|---|---|---|
| 在 src/parser.ts 的 parse() 函数加 try/catch, 未识别 token 返回 null 而非抛错 | refactor | file |
| 补 src/parser.test.ts 的覆盖: 缺右括号、缺关键字、未闭合字符串各一条断言 | test | file |
| 在 docs/plan/parser-try-catch.md 写一条新增契约不变量 (P-INV-2) | docs | file |`;

const FEW_SHOT_BAD = `\
# 例子 2 (反例: **不要**画综合节点 —— L1 合并 = 机械 fan-in, 不写 worker 综合)
goal: 重构 cache 模块
criteria: bun test src/cache.test.ts 退出码 0

| 子任务文本 | leaf 类型 | 可见性 |
|---|---|---|
| 改 src/cache.ts 的 LRU 实现, 用 doubly linked list 替掉数组 | refactor | file |
| 改 src/cache-evict.ts 的驱逐逻辑, TTL 与 LRU 二选一 | refactor | file |
| 综合上述两个子任务的输出, 产出最终 cache 模块代码 | synthesis | file |  ← 错: 综合节点不该出现在 L1

正确做法: 第 3 行删掉, 让 accept 节点 depends_on=[s1, s2] 收两条子答案; 真要做文本综合走 verifier 座位。`;

const FEW_SHOT_HEADER = `\
# 平铺规划 —— 三列表 (子任务文本 / leaf 类型 / 可见性), 全部 executor:'agent', depends_on 空。

## 形状纪律
- **全部 agent**: 不用 executor:'command' / 'conductor' / 'map' / 'research' / 'await'。
- **depends_on 全空**: 子任务彼此不互相等; 合并 = 机械 fan-in (accept 节点收全部)。
- **无综合节点**: 文本综合 (「综合各子答案」「merge sub-answers」「汇总上述」,
  任意「同源综合」形状) 不写进表, 那是 verifier 座位的事, 不是平铺编译器的事
  (D-4 / council I-3)。
- **写集不交叠**: 每个子任务独立写一个范围 (与 SDD 同款) —— 写集交叠的形状
  走 SDD 不走 L1。

## 输出格式
markdown 表格, 表头必须逐字: \`| 子任务文本 | leaf 类型 | 可见性 |\`, 分隔行
\`|---|---|---|\`, 数据行 N 行。**只输出这一张表, 不加解释、不加外层包装**。
leaf 类型 = agent 模板名 / profile 名 / 留空。`;

export function buildFlatPlanPrompt(goal: string, opts: FlatPromptOptions): string {
  return [
    '# 任务',
    goal.trim(),
    '',
    '# 冻结判据',
    opts.criteria.trim(),
    '',
    '# 平铺 few-shot',
    FEW_SHOT_HEADER,
    '',
    FEW_SHOT_OK,
    '',
    FEW_SHOT_BAD,
    '',
    '# 你的输出',
    '只输出下面的 markdown 表格 (表头 + 分隔 + N 行数据), 别的不写:',
    '',
    '| 子任务文本 | leaf 类型 | 可见性 |',
    '|---|---|---|',
  ].join('\n');
}

// ── ② 三列表解析 ──────────────────────────────────────────────────────────
//
// 形状: markdown 表格, 表头 + 分隔 + 数据行。表头列名 (子任务文本 / leaf 类型
// / 可见性) 不区分大小写、不区分全半角冒号、不要求严格相等 (与 sdd-direct
// 表格解析同款宽容) —— 但列数必须恰为 3 (D-1 三列表的字面契约)。
//
// 反向自检: 把表头列名校验摘掉 → 「闸 parse-shape 列名错 → 拒」当场红。
//           把列数校验摘掉 → 「闸 parse-shape 列数错 → 拒」当场红。

const HEADER_LINE = /^\s*\|\s*(?:子任务文本|subtask\s*text)\s*\|\s*(?:leaf\s*类型|leaf\s*type)\s*\|\s*(?:可见性|visibility)\s*\|\s*$/i;
const SEPARATOR_LINE = /^\s*\|[\s:|-]+\|\s*$/;

export function parseFlatPlanOutput(text: string): readonly FlatSubtask[] {
  const lines = text.split('\n');
  let headerIdx = -1;
  let sepIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerIdx === -1 && HEADER_LINE.test(lines[i]!)) headerIdx = i;
    else if (headerIdx !== -1 && sepIdx === -1 && SEPARATOR_LINE.test(lines[i]!)) {
      sepIdx = i;
      break;
    }
  }
  if (headerIdx === -1)
    throw new Error('平铺输出没有表头 (期望 `| 子任务文本 | leaf 类型 | 可见性 |` 三列)');
  if (sepIdx === -1 || sepIdx !== headerIdx + 1)
    throw new Error('平铺输出表头后缺分隔行 (`|---|---|---|`)');
  const out: FlatSubtask[] = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.includes('|')) break; // 表格结束
    const cells = raw.split('|').map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    if (cells.length !== 3)
      throw new Error(
        `平铺输出第 ${i + 1} 行列数 = ${cells.length} (期望恰 3): ${raw}`,
      );
    const [text, kind, visRaw] = cells as [string, string, string];
    if (!text)
      throw new Error(`平铺输出第 ${i + 1} 行「子任务文本」为空 —— 不接受空任务`);
    const vis = parseVisibility(visRaw, i + 1);
    out.push({ text, kind, visibility: vis });
  }
  if (!out.length)
    throw new Error('平铺输出数据行为 0 —— 至少要 1 个子任务');
  return out;
}

function parseVisibility(raw: string, line: number): FlatSubtask['visibility'] {
  const v = raw.toLowerCase();
  if (v === 'file' || v === 'structured' || v === 'git' || v === 'none') return v;
  throw new Error(
    `平铺输出第 ${line} 行「可见性」值 "${raw}" 不在 {file, structured, git, none}`,
  );
}

// ── ③ 编译为 ConductorPlan ────────────────────────────────────────────────

export function compileFlatPlan(
  subtasks: readonly FlatSubtask[],
  opts: FlatCompileOptions,
): ConductorPlan {
  if (!subtasks.length)
    throw new Error('平铺子任务数 = 0 —— 编译不出图 (空图把"什么都没干"读成"跑完了")');
  // 写集两两不相交 (与 SDD 同款纪律, GWT-1 隐含: 节点无跨步产物依赖 = 写集不交叠)
  // —— 浅校验: 同 opts.writeSet 时不重复断言 (那是调用方传进来的同一份), 各 subtask
  // 不带写集列 = 编译器看不到粒度, 跳过这道闸。
  if (opts.writeSet && opts.writeSet.length) {
    const dupes = opts.writeSet.filter((f, i) => opts.writeSet!.indexOf(f) !== i);
    if (dupes.length)
      throw new Error(
        `平铺写集含重复项: ${dupes.join(', ')} —— 写集是声明面, 重复 = 声明不清`,
      );
  }
  const nodes: Record<string, Record<string, unknown>> = {};
  subtasks.forEach((st, idx) => {
    const id = `s${idx + 1}`;
    assertNotSynthesis(st.text, `子任务 #${idx + 1}`);
    const node: Record<string, unknown> = {
      executor: 'agent',
      goal: st.text,
      output_type: st.visibility,
      depends_on: [],
    };
    if (opts.writeSet && opts.writeSet.length) node.write_set = [...opts.writeSet];
    if (st.kind) node.template = st.kind;
    if (opts.specAnchor !== undefined) node.spec_anchor = opts.specAnchor;
    nodes[id] = node;
  });
  // accept = 终局验收节点, depends_on 收全部子任务 (D-4 机械 fan-in, 不写 worker 综合节点)
  nodes['accept'] = {
    executor: 'command',
    command: opts.acceptCommand,
    expect_exit: opts.acceptExpectExit ?? 0,
    depends_on: subtasks.map((_, i) => `s${i + 1}`),
    output_type: 'none',
    goal: '终局全量回归 (flat-plan L1 · 机械 fan-in, 无文本综合节点)',
  };
  return PlanSchema.parse({
    name: opts.name ?? 'flat-plan',
    // D-2 / 片 2 schema 增量: complexity 标识本 plan 由平铺编译器产出, 路由权归 config。
    // 当前 PlanSchema 是 `.passthrough()`, 该写法照样过; 片 2 加枚举后被正式校验。
    complexity: 'flat',
    nodes,
  });
}