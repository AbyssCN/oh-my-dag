/**
 * plan/plan-doc-gaps —— 一份计划文档 (SDD) 的**缺口清单**, 按严重度排序。零 LLM, 纯静态解析, 纯函数。
 *
 * ## 与 `plan-doc-score` 的分工 (这条线不划清就会变成两个互相打架的闸)
 *
 * - **打分** 回答「已经有的东西**够不够硬**」—— 比率 + 阈值, 分母为 0 一律不适用。
 * - **找缺口** 回答「**该有的东西在不在**」—— 结构性判定, 与比率无关。
 *
 * 所以"根本没有契约段"是这里的 blocker, 而不是打分里的 0%; 反过来"GWT 写得糊"是打分的事,
 * 这里不重复报。前身 momus-gate 把两件事揉在一个数里, 于是任何一种缺失都表现成"分低",
 * 报告读不出该先修哪个。
 *
 * ## 严重度口径
 *
 * - **blocker** —— 交给执行器就一定出事: 没有验收面, 或者验收面判不了 pass/fail。
 * - **major** —— 能跑但会漂: 边界没写、落点指向不存在的文件。
 * - **minor** —— 追溯性 / 卫生问题, 不拦交付。
 *
 * ## 一条纪律: **拿不准不报**
 *
 * 承 `plan/static-lint` 那条 —— 静态检查一旦开始猜, 它就变成了第三个 judge, 而且是个没有证据的。
 * 文件存在性检查因此走**注入**({@link PlanDocGapsOptions.fileExists}): 不给注入就不查,
 * 而不是自己去猜 cwd 在哪儿。
 */
import { parsePlanDoc, type PlanDoc } from './plan-doc-score';
import { parseBreakdown } from '../goal/sdd-direct';

export type GapSeverity = 'blocker' | 'major' | 'minor';

export interface PlanDocGap {
  /** 稳定编号 (测试与抑制都靠它, 不靠文案)。 */
  id: string;
  severity: GapSeverity;
  /** 描述: 缺的是什么。 */
  title: string;
  /** 影响面: 不修会怎样。 */
  impact: string;
  /** 建议修法: 具体到动作, 不是"请完善"。 */
  fix: string;
  /** 点名 (不变量编号 / 文件路径 / 节名), 最多 8 条; 空 = 整篇性质的缺口。 */
  evidence: string[];
}

export interface PlanDocGapsOptions {
  /**
   * 判一个仓内相对路径存不存在。**不给 = 跳过存在性检查** —— 本模块保持纯函数,
   * 读盘的权力留在调用方 (`scripts/plan-doc-check.ts` 传 `existsSync`)。
   */
  fileExists?: (repoRelPath: string) => boolean;
}

const SEVERITY_ORDER: Record<GapSeverity, number> = { blocker: 0, major: 1, minor: 2 };

const CAP = 8;

/**
 * 找出一份计划文档的缺口, 已按 blocker > major > minor 排好序 (同级按发现顺序)。
 *
 * @param md 计划文档全文
 * @param opts 可选注入 (文件存在性)
 */
/**
 * 分解段里有没有 markdown 表格。
 *
 * 判据取「至少两行以 `|` 开头」—— 一行 `|` 可能是别处的散文, 两行才是表 (表头 + 分隔行起步)。
 * 段的边界与 `parseBreakdown` 同法: 从分解标题起到下一个 `## ` 止。
 */
function breakdownHasTable(md: string): boolean {
  const head = /^##\s+.*(分解|Breakdown|切片|施工序|实施计划).*$/im.exec(md);
  if (!head) return false;
  const after = md.slice(head.index + head[0].length);
  const next = /^##\s/m.exec(after);
  const section = next ? after.slice(0, next.index) : after;
  return section.split('\n').filter((l) => l.trim().startsWith('|')).length >= 2;
}

export function findPlanDocGaps(md: string, opts: PlanDocGapsOptions = {}): PlanDocGap[] {
  const doc = parsePlanDoc(md);
  const gaps: PlanDocGap[] = [];
  const add = (g: PlanDocGap) => gaps.push({ ...g, evidence: g.evidence.slice(0, CAP) });

  // ---------- 先判它到底是不是一份 SDD ----------
  // `docs/plan/` 里躺着的不全是 SDD: 还有台账 (`NOTES.md`)、参考表 (`2026-07-30-schema-field-registry`)、
  // 实测记录 (`eval-findings`)。拿 SDD 的骨架去要求它们, 出来的一串 blocker 全是假的 ——
  // 而**假 blocker 会让人把整个闸关掉**, 这比没有闸更坏。
  // 判据刻意极粗: 六个骨架节 (目标/决策/契约/分解/非目标/未决) 认出**不足两个** → 不是 SDD, 只报一条,
  // 其余结构性检查一概不做 (拿不准不报)。
  // 为什么是 2 而不是 1: 调研笔记常常带一个 `## 未决`、参考表常常带一个 `## 目标`, 只有一个骨架节
  // 说明它是"顺手写了一段", 不是照骨架写的。实测本仓 24 份, 这个阈值恰好把 SDD 与笔记切开。
  const skeleton = Object.values(doc.has).filter(Boolean).length;
  if (skeleton < 2) {
    return [
      {
        id: 'not-an-sdd',
        severity: 'minor',
        title: `这份文档只认出 ${skeleton} 个 SDD 骨架节 (目标 / 决策 / 契约 / 分解 / 非目标 / 未决), 按"不是 SDD"处理, 不做结构检查。`,
        impact: '本闸的判据只对 SDD 成立。若它本该是 SDD, 那么缺的不是某一段, 是整个骨架。',
        fix: '确实不是 SDD (台账 / 参考表 / 实测记录) → 不必送检; 本该是 SDD → 照骨架重写: 目标 / 决策 / 契约 / 分解 / 非目标 / 未决。',
        evidence: doc.sections.map((s) => s.title).slice(0, CAP),
      },
    ];
  }

  // ---------- blocker: 没有验收面 ----------

  if (!doc.has.contracts) {
    add({
      id: 'contracts-missing',
      severity: 'blocker',
      title: '没有契约段 (`## 契约 (Contracts)` 或等价的「上线闸 / 验收」段)。',
      impact: '整份文档没有可判 pass/fail 的面。执行器跑完之后, "成没成"只能由散文决定 —— 也就是由它自己决定。',
      fix: '加一段 `## 契约 (Contracts)`, 每条不变量写成 `- **INV-X 名称**:…`, 下面挂一条 `- GWT:*Given* … *When* … *Then* …`。',
      evidence: [],
    });
  } else if (doc.invariants.length === 0 && doc.gwts.length === 0) {
    add({
      id: 'contracts-empty',
      severity: 'blocker',
      title: '契约段在, 但一条不变量、一条 GWT 都没有。',
      impact: '有验收的样子而没有验收 —— 比没有这一段更坏, 因为读的人会以为已经写过了。',
      fix: '把这段里的散文改写成 `- **INV-X …**` + `- GWT:*Given* … *Then* …`; 一条都提不出来, 说明方案还没想清楚, 别急着交给执行器。',
      evidence: doc.sections.filter((s) => s.kind === 'contracts').map((s) => s.title),
    });
  } else if (doc.invariants.length > 0 && doc.gwts.length === 0) {
    add({
      id: 'inv-without-gwt',
      severity: 'blocker',
      title: `契约段有 ${doc.invariants.length} 条不变量, 但一条 GWT 都没有。`,
      impact: '不变量是**声明**, GWT 才是**判定动作**。只有声明的不变量在执行侧不会被检查, 它只会被当背景散文读过去。',
      fix: '每条不变量下挂一条 `- GWT:*Given* … *When* … *Then* …`, Then 里写机器能判的东西 (命令 / 数字 / 文件路径)。',
      evidence: doc.invariants.map((i) => i.id),
    });
  }

  // ---------- blocker: 有验收但没有任何能跑的东西 ----------

  // ⚠ **这条是本文件里假阳性风险最高的一条** (2026-08-01)。检测器只认反引号 / 围栏 / 少数裸命令名
  //    (`bun` / `tsc` / `ugrep` / `pytest`), 一份用**散文**描述 oracle 的文档会被误判成"零命令"。
  //    当前语料里唯一命中的是真阳性(那份文档全篇确实一条命令都没有)。
  //    **将来若误伤: 先把它降成 major, 别去调检测器** —— 放宽检测器会让"散文式验收"重新蒙混过关,
  //    而那正是这条规则要抓的东西; 降级只损失优先级, 不损失信号。
  if (doc.gwts.length > 0 && doc.oracleCommands.length === 0) {
    add({
      id: 'no-oracle-command',
      severity: 'blocker',
      title: '全篇有 GWT, 却没有任何一条可跑的 oracle 命令 (`bun test` / `bun run tsc --noEmit` / 具体脚本 / `ugrep …`)。',
      impact: '所有 Then 最终都要落到某个人 (或某个模型) 的判断上。没有可跑的命令 = 没有可复现的判定 = 验收随判的人变。',
      fix: '至少给一条硬闸写出确切命令, 例如 `bun run tsc --noEmit` / `bun test src/harness/plan` / `ugrep -c "x" src/`, 让它能直接当 command 节点的判据。',
      evidence: [],
    });
  }

  // ---------- major: 结构性缺失 ----------

  if (!doc.has.nongoals) {
    add({
      id: 'nongoals-missing',
      severity: 'major',
      title: '没有非目标段 (`## 非目标 (Non-goals)`)。',
      impact: '范围没有下边界。执行器会顺手把"顺便也该做的"一起做了, 而那正是一轮跑成三轮、审查面失控的来源。',
      fix: '加一段 `## 非目标 (Non-goals)`, 把已经想到但**这次刻意不做**的写下来 (含为什么不做)。',
      evidence: [],
    });
  }

  if (!doc.has.breakdown) {
    add({
      id: 'breakdown-missing',
      severity: 'major',
      title: '没有分解段 (`## 分解 (Breakdown)` / `## 切片`)。',
      impact: '没有切片 = 没有依赖序 = 无法判断哪些能并行、哪些必须串。整份文档只能一口气交出去。',
      fix: '加一张切片表: 每片写「内容 / 闸 / 依赖」, 至少指出改哪几个文件或哪几个符号。',
      evidence: [],
    });
  }

  // 分解表能不能被**真正吃它的那个编译器**吃下 (S-45)。
  //
  // ⚠ 这一条治的是「同一段文字两套解析器」: 本闸对切片的定义是「表行或顶层列表项」(见文件头
  // §切片), 而 `solve --sddPath` 的直通编译器 `parseBreakdown` 要的是**四列 + 首列以编号开头**。
  // 2026-08-20 实盘: 一份 `plan-doc-check` 判 PASS 的契约点火时编译失败, fail-open 回落
  // conductor 现画图 —— 白付一次铺图的钱, 而回执上什么都看不出来 (日志里有一行, 但人只看回执)。
  // 两个函数本来就都在仓里, 缺的只是把它们接上。
  // ⚠ 只在分解段**真的写成表格**时才要求它能编译。散文/列表式的分解段是合法的
  //    (本仓多数 SDD 如此), 它们没有在主张「我能直通」—— 对它们开火就是误报,
  //    而一个假 major 会让人把整个闸关掉 (比没有闸更坏, 见本文件头注)。
  if (doc.has.breakdown && breakdownHasTable(md)) {
    try {
      parseBreakdown(md);
    } catch (err) {
      add({
        id: 'breakdown-not-compilable',
        severity: 'major',
        title: '分解段过不了直通编译器 (`solve --sddPath` 会 fail-open 回落 conductor 铺图)。',
        impact:
          '本闸绿 ≠ 能直通。回落是**静默于回执**的 (只写日志), 于是你以为走了零契约段的直通,' +
          ' 实际付了一次 conductor 铺图的钱, 而且图的形状由模型定而不是由你这张表定。',
        fix:
          '按编译器的形状改: 四列 `切片 | 写集 | 依赖 | verify`, **首列以编号开头** (`1` / `2` …,' +
          ' 编号是波形与依赖引用它的唯一方式), 依赖列填编号, 可选再加一行波形 `{1,2}{3}`。',
        evidence: [String((err as Error).message ?? err)],
      });
    }
  }

  // 分解段点名的文件在不在 (仅当调用方注入了存在性判定)。
  if (opts.fileExists) {
    const missing = new Map<string, string>(); // path -> 出处切片
    for (const s of doc.slices) {
      for (const p of s.paths) {
        // 只查**带目录**的路径。裸文件名 (`_fixpoint.json` / `config.json`) 在文档里多半指的是
        // 运行期产物或某目录下的约定名, 拿仓根去查它必然"不存在" —— 那是假缺口, 不报 (拿不准不报)。
        if (!p.includes('/')) continue;
        if (!missing.has(p) && !opts.fileExists(p)) missing.set(p, s.label);
      }
    }
    if (missing.size > 0) {
      add({
        id: 'breakdown-path-missing',
        severity: 'major',
        title: `分解段点名了 ${missing.size} 个仓里不存在的文件路径。`,
        impact:
          '两种可能, 两种都得管: ① 路径写错 → 执行器照着建了一个新文件, 真正该改的那个原封不动;' +
          ' ② 这是**要新建**的文件 → 那读的人分不出"写错了"和"还没建", 判不了。',
        fix: '改对路径; 确实是新建的, 在切片里明写「新建」两个字, 让静态检查与读的人都不必猜。',
        evidence: [...missing].map(([p, label]) => `${p} (切片 ${label})`),
      });
    }
  }

  // ---------- 直通可编译性: 这份文档机器吃不吃得下 (2026-08-18) ----------
  //
  // 与这个模块其余判据的分野: 上面那些问「写得好不好」, 这一格问「`solve --sddPath` 能不能
  // 消费它」。两次实测都是在**点火那一刻**才响 —— 一次 `S1` 切片列当场拒, 一次波形被静默丢掉,
  // 而这个闸当时**一次都没跑过 `parseBreakdown`**: 评分全绿, 文档吃不下。
  //
  // ⚠ **判据刻意收窄到「自称直通契约」** —— 分解段的表头同时声明「写集」与 verify。
  // 不是所有分解段都打算走直通 (实验契约 / 对比报告 / `| 序 | 切片 | 内容 |` 这类人读表),
  // 拿这把尺子量它们是**尺子量错对象**: 全量实测会一次红 38 份, 而那正是让人把闸关掉的原因。
  // 收窄之后的实测面: 149 份里 23 份自称直通, 其中 9 份抛错 · 6 份波形读不到。
  const breakdownSection = (() => {
    const sec = md.split(/^##\s+/m).find((p) => /^(分解|Breakdown)/.test(p));
    if (!sec) return null;
    const header = /^\s*\|.*$/m.exec(sec)?.[0] ?? '';
    return /写集/.test(header) && /verify/i.test(header) ? sec : null;
  })();
  if (breakdownSection) {
    try {
      const bd = parseBreakdown(md);
      // 波形读不到**不拦交付**: 图会退回按依赖边排, 只是文档里那句"并行波形"没人消费 ——
      // 一句写了没人读的话, 与写错同样危险, 但代价小一档。
      if (!bd.waves) {
        add({
          id: 'sdd-waves-unread',
          severity: 'minor',
          title: '声明了并行波形, 但机器读不到 (`WAVE_LINE` 锚行首)。',
          impact:
            '写成「写集两两不相交 ✓。并行波形:…」这种同行形式会被**静默忽略** —— 文档上写着波形,' +
            ' 引擎实际按依赖边排, 而两者不一致时没有任何提示。',
          fix: '把「并行波形:`{1,2} → {3}`」放到**独占的一行**上。',
          evidence: [],
        });
      }
    } catch (err) {
      add({
        id: 'sdd-breakdown-unparseable',
        severity: 'major',
        title: '分解表自称直通契约 (表头有写集 + verify), 但 `sddPath` 解析不了。',
        impact:
          '`solve --sddPath` 会在**点火那一刻**当场拒 —— 夜批空跑一次才发现。' +
          ' 真源判据在 `src/harness/goal/sdd-direct.ts`: 切片列裸数字开头 · 写集只收相对路径且不许留空。',
        fix: '照判词改表; 改完当场 `bun run plan-doc-check <本文档>` 复验 (一秒, 比夜批便宜)。',
        evidence: [String(err instanceof Error ? err.message : err).slice(0, 200)],
      });
    }
  }

  // ---------- minor: 追溯性与卫生 ----------

  const unpaired = doc.invariants.filter((i) => i.gwtIds.length === 0);
  if (unpaired.length > 0 && doc.gwts.length > 0) {
    add({
      id: 'gwt-untraceable',
      severity: 'minor',
      title: `${unpaired.length} 条不变量没有**逐条对应**的 GWT (既没嵌套, 也没有任何 GWT 点它的编号)。`,
      impact:
        '验收点在, 但对不上号。改一条不变量时, 无法确定该同步改哪条 GWT ——' +
        ' 于是要么两边漂移, 要么每次都得把整段重读一遍。',
      fix: '把 GWT 挂到对应不变量下面当子项, 或在 GWT 正文里点名它验的是哪一条 (如 `*Then* …(INV-3)`)。',
      evidence: unpaired.map((i) => i.id),
    });
  }

  if (!doc.has.decisions) {
    add({
      id: 'decisions-missing',
      severity: 'minor',
      title: '没有决策段 (`## 决策 (Decisions)`)。',
      impact: '关掉的门没有记录。半年后没人知道某个写法是查过才这么定的、还是当时随口拍的, 于是要么被无脑遵守要么被无脑推翻。',
      fix: '加一段 `## 决策 (Decisions)`, 每条编号 `D-N`, 正文写「定了什么 + 为什么 + 证据 (链接 / `file:line` / 实测读数 / owner 拍板)」。',
      evidence: [],
    });
  }

  if (!doc.has.open) {
    add({
      id: 'open-missing',
      severity: 'minor',
      title: '没有未决段 (`## 未决 (Open)`)。',
      impact: '没写下来的疑问不会消失, 只会在执行到一半时以"这里怎么办"的形式冒出来, 那时改契约的代价最高。',
      fix: '加一段 `## 未决 (Open)`, 每条标清 [待 owner] / [待实测] —— 待谁、待什么。',
      evidence: [],
    });
  }

  const vague = doc.gwts.filter((g) => g.vague.length > 0);
  if (vague.length > 0) {
    add({
      id: 'gwt-vague-words',
      severity: 'minor',
      title: `${vague.length} 条 GWT 的 Then 里有判不了的词 (「合理」「符合预期」这类)。`,
      impact: '一个模糊验收点 = 一个执行器和你各自解读的裂缝。这类 Then 永远判得过, 也永远判不出问题。',
      fix: '把形容词换成读数: 「结果合理」→「`bun test src/x` 全绿」/「命中 0 条」/「≤ 3 轮收敛」。',
      evidence: vague.map((g) => `${g.id}: ${g.vague.join('/')}`),
    });
  }

  return gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** 便利读数: 各严重度各几条。 */
export function countGaps(gaps: PlanDocGap[]): Record<GapSeverity, number> {
  const out: Record<GapSeverity, number> = { blocker: 0, major: 0, minor: 0 };
  for (const g of gaps) out[g.severity]++;
  return out;
}

export type { PlanDoc };
