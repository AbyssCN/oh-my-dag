/**
 * plan/plan-doc-score —— 一份计划文档 (SDD) 的**确定性质量分**。零 LLM, 纯静态解析 markdown, 纯函数。
 *
 * ## 它量的是什么
 *
 * `/omd-sdd` 自己的文档里写着那句判据: **「一个模糊验收点 = 一个执行器和你各自解读的裂缝」**。
 * 一份 SDD 交给执行器之后, 唯一还能替我们说话的东西是**验收判据**: 它要么能被机器判 pass/fail,
 * 要么就是一句散文, 而散文在执行器那边会被解读成任何它喜欢的样子。所以本模块量的不是"写得好不好",
 * 是**这份文档里有多少东西是可被证伪的**。五项判据全部能从文档里**数出来**, 每一项的理由见下。
 *
 * ## 判据 (为什么这项值得量)
 *
 * 1. **不变量配 GWT 率** —— 一条没有 GWT 的不变量, 在 `/omd-execute` 那边**没有对应的判定动作**,
 *    它只会被当成背景散文读过去。这是最贵的一格: 缺的不是文字, 是一整条验收路径。
 * 2. **GWT 可判定率** —— Then 里写"结果正确"和写"`ugrep 'x' src/` 0 命中"是两件事。前者要人再判一次
 *    (而且判的人和写的人各有一套标准), 后者是命令的退出码。这一项直接对应上面那句"裂缝"。
 * 3. **决策带证据率** —— D-N 是**已经关掉的门**。一条没有证据的决策, 半年后没人知道它是查过才定的、
 *    还是当时随口拍的, 于是要么被无脑遵守要么被无脑推翻。链接 / `file:line` / 实测读数 就是那把锁。
 * 4. **落点具体率** —— 分解段的切片如果不指向具体文件, "改哪儿"这个问题就留给了执行器猜, 而它猜错的
 *    代价是一整轮白烧。这一项刻意给**低阈值**: 早期切片本来就允许只有方向 (依据见默认值那节)。
 *    ⚠ **诚实的天花板** (2026-08-01 实测语料下沿 33%): 这一项现在是**地板闸** —— 它抓的是
 *    "一个文件都没点名"这个真实失败形态, 抓不到"点了两个凑数"。要让它有分辨力, 得先改**分解表的约定**
 *    (加一列「改哪些文件」), 再把阈值抬到 0.6。**在改约定之前别抬阈值** —— 那只会把写得好的文档一起拦掉
 *    (`2026-08-03-goal-engine-upgrade` 那份零缺口的文档这一项只有 33%, 因为我们的分解表本来就写
 *    "阶段名 + 闸 + 依赖", 落点要到实装期才长出来)。
 * 5. **未决段非空** —— 空的未决段几乎从来不是"全想清楚了", 是没认真想。但它**判不出对错** (确实存在
 *    该收尾的文档), 所以**只报不拒** —— 走 `softFlags`, 不进 `failures`。
 *
 * ## 防"每份都报 blocker"的那条纪律: **分母为 0 = 不适用, 不是 0 分**
 *
 * 这两个文件的前身 (momus-gate / metis-stage) 是从别的仓整体搬来的, 解析的是别的文档格式,
 * 接上去对每一份 SDD 都报 blocker。根因不只是正则写错, 还有一条**结构性**的:
 * 把"这份文档里没有这类东西"算成"这项得 0 分"。所以本模块的比率一律用 {@link Ratio}:
 * `total === 0 → value === null`, 而 `null` **永不构成 failure**。结构性缺失 (根本没有契约段)
 * 是 `plan-doc-gaps` 的活 —— 打分负责"有的东西够不够硬", 找缺口负责"该有的东西在不在"。
 *
 * ## 解析口径 (照本仓 `docs/plan/` 的真实格式定, 不是通用 markdown SDD)
 *
 * - **节** 按 `## ` 切, `### ` 归属其上级节 (决策段的 D-R..D-AL 就是 `###`)。围栏代码块内的行不参与结构判定。
 * - **不变量** = 契约段里 `- **INV-xxx ...**` 形态的列表项。
 * - **GWT** = 同时含 `Given` 与 `Then` 标记的列表项 (含其续行)。**刻意不认 "GWT" 这个词** ——
 *   本仓实际写法至少三种 (`- GWT:*Given*…` / `- **GWT-1** *Given*…` / `- **G-1**:Given…),
 *   认词会漏掉第三种; 认 Given+Then 才是认这件事本身。
 * - **决策** = 决策段里的 `- **D-N …**` 列表项 / `### D-N …` 子节 / `| D-N | … |` 表行 三种形态。
 * - **切片** = 分解段里的表行 (去掉表头与分隔行) 或顶层列表项。
 */

// ============================== 通用 markdown 结构 ==============================

/** 一行 + 它是否落在围栏代码块里 (围栏内的 `#`/`-` 不算结构)。 */
interface Ln {
  text: string;
  fenced: boolean;
}

function toLines(md: string): Ln[] {
  const out: Ln[] = [];
  let fence: string | null = null;
  for (const text of md.split(/\r?\n/)) {
    const m = text.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      // 围栏行本身算 fenced, 收尾后退出
      out.push({ text, fenced: true });
      if (m && m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      out.push({ text, fenced: true });
      continue;
    }
    out.push({ text, fenced: false });
  }
  return out;
}

function indentOf(text: string): number {
  return (text.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/;

function isHeading(l: Ln): boolean {
  return !l.fenced && HEADING_RE.test(l.text);
}
function isBullet(l: Ln): boolean {
  return !l.fenced && BULLET_RE.test(l.text);
}

/**
 * 从 `start` 行起的列表项块的结束行 (exclusive)。
 * 续行 = 缩进更深的行 / 空行后仍更深; 遇到同级或更浅的列表项、任何标题、顶格新段落即止。
 */
function blockEnd(lines: Ln[], start: number): number {
  const base = indentOf(lines[start]!.text);
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.text.trim() === '') {
      let k = j;
      while (k < lines.length && lines[k]!.text.trim() === '') k++;
      const next = lines[k];
      if (next && !isHeading(next) && indentOf(next.text) > base) {
        j = k;
        continue;
      }
      break;
    }
    if (isHeading(l)) break;
    const ind = indentOf(l.text);
    if (ind > base) {
      j++;
      continue;
    }
    break; // 同级列表项 / 顶格段落 / 表格
  }
  return j;
}

function blockText(lines: Ln[], start: number, end: number): string {
  return lines
    .slice(start, end)
    .map((l) => l.text)
    .join('\n');
}

// ============================== 节 ==============================

export type SectionKind = 'goal' | 'decisions' | 'contracts' | 'breakdown' | 'nongoals' | 'open';

export interface DocSection {
  /** `## ` 后的原文标题。 */
  title: string;
  /** 归一化的节类型; 认不出 = `null` (自由散文节, 不参与判据)。 */
  kind: SectionKind | null;
  /** 该节的行 (不含标题行本身), 含其下所有 `###` 子节。 */
  lines: Ln[];
  /** 标题行在全文中的 0-based 行号。 */
  startLine: number;
}

/**
 * 标题 → 节类型。**顺序有意义**: 非目标必须先于目标判 (前者含后者)。
 * 别名照本仓实况收:「上线闸 (Ship Gates)」与「契约」是同一件事 (一张判据表),
 *「切片」与「分解」同理 —— 认死一个词等于对半数文档判缺节。
 */
function classifySection(title: string): SectionKind | null {
  const t = title.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => t.includes(x.toLowerCase()));
  if (has('非目标', 'non-goal', 'nongoal', 'out of scope')) return 'nongoals';
  if (has('未决', '开放问题', 'open question', '(open)', '待决')) return 'open';
  if (has('契约', 'contract', '上线闸', 'ship gate', '验收', '不变量', 'invariant')) return 'contracts';
  if (has('分解', 'breakdown', '切片', '施工序', '实施计划')) return 'breakdown';
  if (has('决策', 'decision', 'adr')) return 'decisions';
  if (has('目标', 'destination', 'goal')) return 'goal';
  return null;
}

function splitSections(lines: Ln[]): DocSection[] {
  const out: DocSection[] = [];
  let cur: DocSection | null = null;
  lines.forEach((l, i) => {
    const m = l.fenced ? null : l.text.match(HEADING_RE);
    if (m && m[1]!.length <= 2) {
      cur = { title: m[2]!.trim(), kind: classifySection(m[2]!), lines: [], startLine: i };
      out.push(cur);
      return;
    }
    if (cur) cur.lines.push(l);
  });
  return out;
}

function linesOfKind(sections: DocSection[], kind: SectionKind): Ln[] {
  // 同一类型可能有多个节 (如「契约」+「上线闸」), 全部合并。
  return sections.filter((s) => s.kind === kind).flatMap((s) => s.lines);
}

// ============================== 条目抽取 ==============================

export interface InvariantEntry {
  /** 如 `INV-MODEL-1`。 */
  id: string;
  /** 整块原文 (含续行与嵌套子项)。 */
  text: string;
  /** 该块在**契约段行数组**中的 [start, end)。 */
  span: [number, number];
  /** 配到的 GWT 编号 (嵌套或交叉引用)。 */
  gwtIds: string[];
}

export interface GwtEntry {
  /** 如 `GWT-1` / `G-3`; 无编号时用 `GWT@<契约段行号>`。 */
  id: string;
  text: string;
  span: [number, number];
  /** 最后一个 Then 标记之后的文字 —— 判定面就这一段。 */
  then: string;
  /** 命中的可判定锚 (为空 = 判不了)。 */
  anchors: string[];
  /** 命中的"判不了的词"。 */
  vague: string[];
  decidable: boolean;
}

export interface DecisionEntry {
  /** 如 `D-0` / `D-AB`。 */
  id: string;
  text: string;
  /** 命中的证据类型 (为空 = 无证据)。 */
  evidence: string[];
}

export interface SliceEntry {
  /** 表行取首格, 列表项取首句; 仅用于点名。 */
  label: string;
  text: string;
  /** 抽到的仓内相对文件路径 (`plan-doc-gaps` 拿去核实在不在仓里)。 */
  paths: string[];
  /**
   * 落点是否可定位 = 有文件路径 **或** 代码锚 (反引号里的 / 裸标识符)。
   * 为什么不只认文件路径: 实测本仓分解表的落点常写成 `max_retry` / `plan.outputs` / `settle/pump`
   * 而不是文件名 —— 它们一样能让执行器**指得出改哪儿**, 只认文件路径会把写得好的切片判成糊的
   * (这正是前身"接上去每份都报 blocker"的同一种错: 拿一种写法当唯一合法写法)。
   */
  anchored: boolean;
}

/** 源码文件扩展名。多点文件名 (`inner-loop-fault.test.ts`) 必须能整段吃下 —— 本仓测试文件全是这个形态。 */
const FILE_EXT = String.raw`(?:ts|tsx|js|mjs|cjs|json|md|sh|py|ya?ml|html|svg|sql|txt)`;
const FILE_EXT_RE = new RegExp(String.raw`[\w@-]+(?:[./][\w@-]+)*\.${FILE_EXT}\b`);
/** 反引号里的代码标识符 (≥4 字符): 在本仓, 一个被反引号框住的符号名就是可核查的落点。 */
const CODE_IDENT_RE = /`[^`\n]*[A-Za-z_][A-Za-z0-9_.:$-]{3,}[^`\n]*`/;
/**
 * 裸标识符锚 (没打反引号但**指得出唯一的东西**): `plan.outputs` / `settle/pump` / `max_retry`。
 * 门槛刻意收紧到「字母开头 + 内部有 `_` `.` `/` 分隔 + 总长够」, 为的是把分解表里的噪声挡在外面:
 * `A/B`(方法名不是落点)、`G-1/G-4`(数字开头的交叉引用)、`e.g.` 都命不中。
 */
const BARE_IDENT_RE = /[A-Za-z][A-Za-z0-9]+[_./][A-Za-z0-9][A-Za-z0-9_./-]{2,}/;

const INV_RE = /^\s*(?:[-*+]|\d+\.)\s+\*\*\s*(INV-[A-Za-z0-9][A-Za-z0-9._-]*)/;
const GIVEN_RE = /(^|[^A-Za-z])\*{0,2}Given\*{0,2}([^A-Za-z]|$)/;
const THEN_RE = /(^|[^A-Za-z])\*{0,2}Then\*{0,2}([^A-Za-z]|$)/;
const GWT_ID_RE = /\*\*\s*(GWT[-–][^\s*]+|G-[A-Za-z0-9]+)\s*\*\*/;

/** 可判定锚: Then 里出现任一即认为"机器能判"。 */
const DECIDABLE_ANCHORS: readonly { key: string; re: RegExp }[] = [
  { key: 'code', re: /`[^`\n]+`/ },
  { key: 'path', re: FILE_EXT_RE },
  // 数字必须带**量纲**才算锚 —— 光有个数字 (「第 2 节」) 判不了任何东西。
  // 中文数字一并收: 本仓 Then 里「恰好一轮」「两次调用」与「3 次」是同一类判据, 只认阿拉伯数字会漏掉一半。
  {
    key: 'count',
    re: /(?:\d+|[一二两三四五六七八九十零])\s*(?:次|个|条|轮|秒|分钟|ms|s\b|%|行|字符|token|源|url|节点|文件|命中|错误|字段|座位|张|份)/i,
  },
  { key: 'compare', re: /[<>≥≤=]\s*\d|\d+\s*(?:以上|以内|以下)|不超过|至少|至多|恰好/ },
  // 刻意**不**收「必须 / 不得 / 禁止」: 那是语气不是判据, 收了等于给「Then 必须正常工作」发通行证。
  { key: 'zero', re: /(?:0|零)\s*(?:命中|次|条|个|行|回归|错误)|无任一|无任何|一个都(?:不|没)/ },
  { key: 'exit', re: /退出码|返回码|exit\s*code|非零|typecheck|tsc|bun test|pass\s*\/\s*fail/i },
  // 具名实体 / 技术标识符: 「解析到 Kimi(Allegretto 渠道)」「每个循环节点有 max_attempts/timeout 界」
  // 这类 Then **没有数字也没有反引号, 但指得出唯一的东西**, 照样能判。判据是形态而非词表:
  // 大写开头的拉丁专名 (≥3 字符) 或内部带 `-_./` 的技术 token。纯中文形容词 (「合理」) 一个都不会命中。
  { key: 'named', re: /\b[A-Z][A-Za-z0-9]{2,}|[A-Za-z0-9]+[-_./][A-Za-z0-9]+/ },
];

/**
 * 判不了的词。命中即**不可判定** —— 这是判据 2 的反面, 也是本模块唯一一处"看词不看数"的地方。
 * 收词纪律: 只收**把判定权交回给人**的词。像「正确读」这种带宾语的用法不在内 (会误伤), 只收
 * 「正确性/结果正确」这类当形容词用的; 拿不准的词不收 —— 误报一条模糊词等于逼人改一句好句子。
 */
const VAGUE_WORDS: readonly RegExp[] = [
  /合理/,
  /符合预期/,
  /结果正确|正确性|完全正确/,
  /恰当|适当(?!的时机)/,
  /良好|完善|优雅|顺畅|健壮/,
  /清晰(?!度)/,
  /更好|尽量|大致|基本上|足够|差不多/,
  /高质量|有意义|可读性好|用户满意/,
];

/** 命中的"判不了的词"**原文** (刻意不用 `RegExp.source`: 运行时会把中文转义成 `\\u5408\\u7406`, 报告里没法读)。 */
function matchVague(then: string): string[] {
  const out: string[] = [];
  for (const re of VAGUE_WORDS) {
    const m = then.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

function sliceThen(text: string): string {
  const flat = text.replace(/\n\s*/g, ' ');
  const idx = flat.search(/\*{0,2}Then\*{0,2}/);
  if (idx < 0) return '';
  return flat.slice(idx).replace(/^\*{0,2}Then\*{0,2}[::,,\s]*/, '');
}

function collectGwts(lines: Ln[]): GwtEntry[] {
  const out: GwtEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!isBullet(l)) continue;
    const end = blockEnd(lines, i);
    const text = blockText(lines, i, end);
    if (!GIVEN_RE.test(text) || !THEN_RE.test(text)) continue;
    const then = sliceThen(text);
    const anchors = DECIDABLE_ANCHORS.filter((a) => a.re.test(then)).map((a) => a.key);
    const vague = matchVague(then);
    out.push({
      id: text.match(GWT_ID_RE)?.[1] ?? `GWT@${i + 1}`,
      text,
      span: [i, end],
      then,
      anchors,
      vague,
      // 有锚且不含判不了的词 = 可判定。两个条件缺一不可: 只有锚会把
      //「Then 结果合理, 见 `x.ts`」放过去, 只查词会把「Then 一切正常」放过去。
      decidable: anchors.length > 0 && vague.length === 0,
    });
    // GWT 块内部可能还有嵌套项, 但一条 GWT 只记一次 —— 直接跳过整块。
    i = end - 1;
  }
  return out;
}

/** 表格里的闸 id: `**G1**` / `INV-3` / `G-2` / `C-1`。 */
const GATE_ID_RE = /^\*{0,2}\s*((?:INV|GWT|G|C)-?[A-Za-z0-9]+)\s*\*{0,2}$/;
/** 判据列的表头关键词 —— 找不到就退回"除首列外全行"。 */
const CRITERION_HEADER_RE = /判据|验收|标准|criteri|accept/i;

/**
 * **表格形态的闸** (`2026-08-03-goal-engine-upgrade` 的 `## 上线闸 (Ship Gates)`):
 * 一行 = 一条不变量 + 它的判据, 语义上与「`- **INV-x**` + 下挂 `- GWT:`」完全一样, 只是排成了表。
 *
 * 不认这种形态的代价是具体的: 那份文档会被判成"契约段在, 但一条不变量一条 GWT 都没有" ——
 * 一个 blocker, 而它其实有六条硬闸。这正是前身 momus-gate 的死法 (拿一种写法当唯一合法写法), 不重犯。
 *
 * 判据列按表头找 (`判据`/`验收`/`criteria`); 找不到就取除首列外的整行 —— 宁可宽一点, 也不去猜是哪一列。
 */
function collectGateRows(lines: Ln[]): { inv: InvariantEntry; gwt: GwtEntry }[] {
  const out: { inv: InvariantEntry; gwt: GwtEntry }[] = [];
  let header: string[] | null = null;
  let prevCells: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const t = l.text.trim();
    if (!t.startsWith('|')) {
      header = null;
      prevCells = null;
      continue;
    }
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (/^\|[\s:|-]+\|$/.test(t)) {
      header = prevCells; // 分隔行的上一行是表头
      continue;
    }
    prevCells = cells;
    if (!header || cells.length < 3) continue;
    const id = cells[0]!.match(GATE_ID_RE)?.[1];
    if (!id) continue;
    const col = header.findIndex((h) => CRITERION_HEADER_RE.test(h));
    const then = col > 0 && cells[col] ? cells[col]! : cells.slice(1).join(' ');
    const anchors = DECIDABLE_ANCHORS.filter((a) => a.re.test(then)).map((a) => a.key);
    const vague = matchVague(then);
    const gwt: GwtEntry = {
      id,
      text: t,
      span: [i, i + 1],
      then,
      anchors,
      vague,
      decidable: anchors.length > 0 && vague.length === 0,
    };
    out.push({ inv: { id, text: t, span: [i, i + 1], gwtIds: [id] }, gwt });
  }
  return out;
}

function collectInvariants(lines: Ln[], gwts: GwtEntry[]): InvariantEntry[] {
  const out: InvariantEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const m = l.text.match(INV_RE);
    if (!m) continue;
    const end = blockEnd(lines, i);
    const text = blockText(lines, i, end);
    const id = m[1]!;
    // 配对两条路: ① GWT 嵌在这条不变量的块里 ② 任一 GWT 的正文点了这条不变量的编号
    //   (本仓两种写法都在用: goal-engine 是嵌套, channel-aware 是分离列表)。
    const idRe = new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`);
    const gwtIds = gwts
      .filter((g) => (g.span[0] >= i && g.span[0] < end) || idRe.test(g.text))
      .map((g) => g.id);
    out.push({ id, text, span: [i, end], gwtIds });
    i = end - 1;
  }
  return out;
}

const DECISION_BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+\*\*\s*(D-[A-Za-z0-9][A-Za-z0-9./-]*)/;
const DECISION_HEADING_RE = /^#{3,6}\s+\*{0,2}\s*(D-[A-Za-z0-9][A-Za-z0-9./-]*)/;
const DECISION_ROW_RE = /^\s*\|\s*\*{0,2}\s*(D-[A-Za-z0-9][A-Za-z0-9./-]*)\s*\*{0,2}\s*\|/;

/** 证据锚: 一条决策"查过了"的可见痕迹。 */
const EVIDENCE_ANCHORS: readonly { key: string; re: RegExp }[] = [
  { key: 'link', re: /\[[^\]]+\]\([^)]+\)|https?:\/\/\S+|\[\[[^\]]+\]\]/ },
  { key: 'file:line', re: new RegExp(FILE_EXT_RE.source + String.raw`\s*[::]\s*\d+`) },
  // 反引号里的符号名算证据: 「因为 `computeDagGeneration` 只哈希 plan-time 节点」是**可核查**的断言,
  // 与「因为这样更好」有本质区别 —— 前者指得出仓里的一个东西, 后者指不出任何东西。
  { key: 'code', re: CODE_IDENT_RE },
  { key: 'commit', re: /`[0-9a-f]{7,40}`|提交\s*`?[0-9a-f]{7}/ },
  { key: 'measured', re: /实测|实证|实跑|读数|教训|本 session|live|benchmark|基准|eval|n\s*=\s*\d/i },
  { key: 'external', re: /arxiv|论文|外部标杆|对标|报告(?:说|明确|自己)/i },
  // 仓内核查: 「全仓零命中」「已查证」是**可复现的检索结果**, 与"我觉得"不是一类东西。
  { key: 'codebase-check', re: /全仓|零命中|已查证|查证|复核|扫过|枚举/ },
  // 出处登记: 「owner 定」/「自裁」不是实证, 但它回答了本项判据真正要问的那个问题 ——
  // **半年后还知不知道这条是谁凭什么定的**。写「owner 拍」是诚实登记, 与什么都不写有本质差别。
  { key: 'provenance', re: /owner\s*(?:定|拍|裁决|锁|要求)|自裁|已锁|承\s*D-|owner:/i },
];

function collectDecisions(lines: Ln[]): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  const push = (id: string, text: string) => {
    out.push({ id, text, evidence: EVIDENCE_ANCHORS.filter((a) => a.re.test(text)).map((a) => a.key) });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const bullet = l.text.match(DECISION_BULLET_RE);
    if (bullet) {
      const end = blockEnd(lines, i);
      push(bullet[1]!, blockText(lines, i, end));
      i = end - 1;
      continue;
    }
    const heading = l.text.match(DECISION_HEADING_RE);
    if (heading) {
      const level = l.text.match(HEADING_RE)![1]!.length;
      let j = i + 1;
      while (j < lines.length) {
        const nx = lines[j]!;
        const hm = nx.fenced ? null : nx.text.match(HEADING_RE);
        if (hm && hm[1]!.length <= level) break;
        j++;
      }
      push(heading[1]!, blockText(lines, i, j));
      i = j - 1;
      continue;
    }
    const row = l.text.match(DECISION_ROW_RE);
    if (row) push(row[1]!, l.text);
  }
  return out;
}

/** 仓内相对路径 (排除 URL / 含占位符的模板名 / 纯扩展名)。 */
const PATH_TOKEN_RE = new RegExp(
  String.raw`(?:^|[\s\`(（「'"|,,])((?:src|scripts|docs|skills|templates|substrate|client-skills|tests?)\/[\w./@-]+|` +
    FILE_EXT_RE.source +
    `)`,
  'g',
);

function extractPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const p = m[1]!.replace(/[.,,。;;)）」'"`]+$/, '');
    if (/[<>*?]/.test(p)) continue; // `_loop-<nodeId>.json` 这类模板名不是真路径
    if (!/\.\w+$/.test(p) && !p.includes('/')) continue;
    out.add(p);
  }
  return [...out];
}

function mkSlice(label: string, text: string): SliceEntry {
  const paths = extractPaths(text);
  return {
    label,
    text,
    paths,
    anchored: paths.length > 0 || CODE_IDENT_RE.test(text) || BARE_IDENT_RE.test(text),
  };
}

function collectSlices(lines: Ln[]): SliceEntry[] {
  const out: SliceEntry[] = [];
  let tableHeaderSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const t = l.text.trim();
    if (t.startsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(t)) {
        tableHeaderSeen = true; // 分隔行 → 它上面那行是表头
        continue;
      }
      if (!tableHeaderSeen) continue; // 表头行本身不是切片
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length === 0) continue;
      out.push(mkSlice(cells[0]!.replace(/\*/g, '') || `行${i + 1}`, t));
      continue;
    }
    tableHeaderSeen = false;
    if (!isBullet(l) || indentOf(l.text) > 0) continue;
    const end = blockEnd(lines, i);
    const text = blockText(lines, i, end);
    out.push(mkSlice((text.match(BULLET_RE)?.[2] ?? '').replace(/\*/g, '').slice(0, 40), text));
    i = end - 1;
  }
  return out;
}

/** 全篇可跑的 oracle 命令 (反引号 / 围栏内)。`plan-doc-gaps` 用它判"有 GWT 但没有任何能跑的东西"。 */
const ORACLE_CMD_RE =
  /\b(?:bun\s+(?:test|run|x)|bunx|tsc\b|npm\s+(?:run|test)|pnpm\s+\w+|yarn\s+\w+|node\s+\S+|ugrep\b|rg\b|grep\s+-|pytest|make\s+\w+|git\s+\w+|\.\/scripts\/\S+)/;

/**
 * 散文里裸写的命令名。收得比 {@link ORACLE_CMD_RE} 窄得多 —— 只收**名字本身就等于一条可跑检查**的那几个,
 * 因为散文里的 `git`/`node` 多半在说别的事。`*When* grep 全仓,*Then* 无残引` 是本仓常见写法, 不该判成"没有 oracle"。
 */
const BARE_CMD_RE = /\b(?:bun\s+(?:test|run|x)|bunx|tsc\b|npm\s+(?:run|test)|pytest|u?grep\b|rg\b)/;

function collectOracleCommands(lines: Ln[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.fenced) {
      if (ORACLE_CMD_RE.test(l.text)) out.add(l.text.trim());
      continue;
    }
    for (const m of l.text.matchAll(/`([^`\n]+)`/g)) {
      const cmd = m[1]!.trim();
      if (ORACLE_CMD_RE.test(cmd)) out.add(cmd);
    }
    const bare = l.text.replace(/`[^`\n]*`/g, '').match(BARE_CMD_RE);
    if (bare) out.add(bare[0]);
  }
  return [...out];
}

// ============================== 解析结果 ==============================

export interface PlanDoc {
  sections: DocSection[];
  /** 各类节是否存在 (给 `plan-doc-gaps` 判结构缺失)。 */
  has: Record<SectionKind, boolean>;
  invariants: InvariantEntry[];
  gwts: GwtEntry[];
  decisions: DecisionEntry[];
  slices: SliceEntry[];
  oracleCommands: string[];
  /** 未决段里的实质内容行数 (已排除 `~~划掉~~` 的条目)。 */
  openItems: number;
}

/** markdown → 结构。`plan-doc-score` 与 `plan-doc-gaps` 共用这一份解析, 避免两套正则漂移。 */
export function parsePlanDoc(md: string): PlanDoc {
  const lines = toLines(md);
  const sections = splitSections(lines);
  const contractLines = linesOfKind(sections, 'contracts');
  const gateRows = collectGateRows(contractLines);
  const gwts = [...collectGwts(contractLines), ...gateRows.map((r) => r.gwt)];
  const invariants = [...collectInvariants(contractLines, gwts), ...gateRows.map((r) => r.inv)];
  const openLines = linesOfKind(sections, 'open');

  const has = {
    goal: false,
    decisions: false,
    contracts: false,
    breakdown: false,
    nongoals: false,
    open: false,
  } as Record<SectionKind, boolean>;
  for (const s of sections) if (s.kind) has[s.kind] = true;

  return {
    sections,
    has,
    invariants,
    gwts,
    decisions: collectDecisions(linesOfKind(sections, 'decisions')),
    slices: collectSlices(linesOfKind(sections, 'breakdown')),
    oracleCommands: collectOracleCommands(lines),
    // 「~~P0 pathfinder 票~~:已交付」这类划掉条目不算未决 —— 它们是已关的门。
    openItems: openLines.filter((l) => isBullet(l) && !/^\s*[-*+]\s+~~/.test(l.text)).length,
  };
}

// ============================== 打分 ==============================

export type MetricKey = 'gwtCoverage' | 'gwtDecidable' | 'decisionEvidence' | 'sliceAnchors';

/**
 * 「有验收的不变量」条数 —— 这一项的定义是本模块唯一一处**刻意放宽**的地方, 理由要写清楚。
 *
 * 本仓实际存在两种写法:
 * - **嵌套式** (`2026-07-28-omd-goal-engine`): 每条 `- **INV-x**` 下面挂一条 `- GWT:…` → 逐条可追溯;
 * - **分离式** (`2026-07-24-channel-aware`): `INV-1..7` 一张表, `G-1..G-6` 另一张表, 互不点名。
 *
 * 只认嵌套 → 分离式那几份直接 0%, 而它们**明明有验收点**, 判据就变成在量写法而不是量质量
 * (这正是前身 momus-gate 的死法)。所以分子取 `max(强配对数, min(不变量数, GWT 数))`:
 * 强配对能证明的照算, 证不出逐条对应时退回**数量覆盖** —— 6 条 GWT 撑不起 10 条不变量, 这层信号仍在。
 *
 * 代价说清楚: 分离式下"哪条 GWT 验哪条不变量"本模块判不了。那条**追溯性**缺口由 `plan-doc-gaps`
 * 以 minor 报出 (`gwt-untraceable`), 不混进分数里 —— 分数管"够不够", 缺口管"追不追得到"。
 */
function coveredInvariants(parse: PlanDoc): number {
  const paired = parse.invariants.filter((i) => i.gwtIds.length > 0).length;
  return Math.max(paired, Math.min(parse.invariants.length, parse.gwts.length));
}

export interface Ratio {
  hit: number;
  total: number;
  /** `total === 0` → `null` (**不适用**, 永不构成 failure)。 */
  value: number | null;
  /**
   * 样本够不够大到能判。`false` → **只展示不判**。
   * 为什么要这条: 一份只写了 2 条决策的文档, 少一条证据就是 50% —— 那是分母噪声, 不是质量信号。
   * 拿噪声去拦一份文档, 与前身"每份都报 blocker"是同一类错, 只是概率低一点。
   */
  gated: boolean;
}

/** 判据生效所需的最小样本数 (低于此只展示读数)。 */
export const MIN_SAMPLE = 3;

function ratio(hit: number, total: number): Ratio {
  return { hit, total, value: total === 0 ? null : hit / total, gated: total >= MIN_SAMPLE };
}

export interface PlanDocThresholds {
  gwtCoverage: number;
  gwtDecidable: number;
  decisionEvidence: number;
  sliceAnchors: number;
}

/**
 * 默认阈值 —— **依据是 2026-08-01 跑 `docs/plan/*.md` 24 份的真实分布**, 不是拍脑袋的整数。
 * 定盘纪律: 阈值卡在"我们自己写得好的那几份能过、写得糙的那几份不过"的位置。
 * 阈值定高了会让每份都红 (这正是前身被删的死法), 定低了闸就是装饰。
 *
 * | 判据 | 实测分布 (有该项的文档) | 阈值 | 说明 |
 * |---|---|---|---|
 * | gwtCoverage | 80 / 86 / 100 / 100 / 100 | 0.80 | 允许一两条不变量暂时没配 (交付记录里常见"这条现在不成立"的诚实条目), 不允许一半没有验收路径 |
 * | gwtDecidable | 67 / 83 / 83 / 87 / 90 / 93 / 100 | 0.70 | 卡在分布次低点之上 —— 唯一被拦的那份 (`2026-07-21-conductor-eval`) 是真读数: 两条 Then 写的是「端到端不崩」「输出客观分」 |
 * | decisionEvidence | 29 / 30 / 55 / 63 / 65 / 77 / 83 / 89 / 100 ×3 | 0.60 | 决策里天然有一部分是**取舍**而非**事实**, 不该被逼着编一个链接。被拦的三份都是 2026-07-19/22 的早期文档 |
 * | sliceAnchors | 33 / 50 / 55 / 75 / 75 / 80 / 86 / 100 / 100 | 0.30 | **最松的一格且刻意如此**: 分解表在规划期常常只有方向 (「P0 鲁棒性」), 落点要到实装期才长出来。取分布下沿 = 它是趋势指标不是闸 |
 *
 * 改阈值前请先重跑 `bun run plan-doc-check docs/plan/*.md` 看分布 —— 这几个数只对本仓的写法成立。
 */
export const DEFAULT_PLAN_DOC_THRESHOLDS: PlanDocThresholds = {
  gwtCoverage: 0.8,
  gwtDecidable: 0.7,
  decisionEvidence: 0.6,
  sliceAnchors: 0.3,
};

export interface MetricFailure {
  metric: MetricKey;
  /** 中文名, 直接进报告。 */
  label: string;
  value: number;
  threshold: number;
  /** 点名: 是哪几条拖的。 */
  offenders: string[];
}

export interface SoftFlag {
  key: 'open-empty';
  message: string;
}

export interface PlanDocScore {
  /** 所有**适用**的判据都达标 = true。不适用 (分母 0) 的项不参与。 */
  pass: boolean;
  metrics: Record<MetricKey, Ratio>;
  /** 每项判据的中文名 (打表用)。 */
  labels: Record<MetricKey, string>;
  failures: MetricFailure[];
  /** 只报不拒的软标记。 */
  softFlags: SoftFlag[];
  thresholds: PlanDocThresholds;
  parse: PlanDoc;
}

const LABELS: Record<MetricKey, string> = {
  gwtCoverage: '不变量配 GWT 率',
  gwtDecidable: 'GWT 可判定率',
  decisionEvidence: '决策带证据率',
  sliceAnchors: '落点具体率',
};

/**
 * 给一份计划文档打分 + 判过不过。纯函数: markdown 字符串进, 结构体出, 不读盘不调网。
 *
 * @param md 计划文档全文
 * @param thresholds 可覆盖的阈值 (只写要改的那几项)
 */
export function scorePlanDoc(md: string, thresholds: Partial<PlanDocThresholds> = {}): PlanDocScore {
  const th = { ...DEFAULT_PLAN_DOC_THRESHOLDS, ...thresholds };
  const parse = parsePlanDoc(md);

  const unpaired = parse.invariants.filter((i) => i.gwtIds.length === 0);
  const undecidable = parse.gwts.filter((g) => !g.decidable);
  const noEvidence = parse.decisions.filter((d) => d.evidence.length === 0);
  const noAnchor = parse.slices.filter((s) => !s.anchored);

  const metrics: Record<MetricKey, Ratio> = {
    gwtCoverage: ratio(coveredInvariants(parse), parse.invariants.length),
    gwtDecidable: ratio(parse.gwts.length - undecidable.length, parse.gwts.length),
    decisionEvidence: ratio(parse.decisions.length - noEvidence.length, parse.decisions.length),
    sliceAnchors: ratio(parse.slices.length - noAnchor.length, parse.slices.length),
  };

  const offenders: Record<MetricKey, string[]> = {
    gwtCoverage: unpaired.map((i) => i.id),
    gwtDecidable: undecidable.map((g) => (g.vague.length > 0 ? `${g.id}(判不了的词)` : `${g.id}(无判据锚)`)),
    decisionEvidence: noEvidence.map((d) => d.id),
    sliceAnchors: noAnchor.map((s) => s.label),
  };

  const failures: MetricFailure[] = [];
  for (const key of Object.keys(metrics) as MetricKey[]) {
    const r = metrics[key];
    if (r.value === null || !r.gated) continue; // 不适用 / 样本太小 ≠ 不及格
    if (r.value + 1e-9 < th[key]) {
      failures.push({
        metric: key,
        label: LABELS[key],
        value: r.value,
        threshold: th[key],
        // 点名上限 8 条 —— 报告要能一眼扫完, 全量在 `parse` 里。
        offenders: offenders[key].slice(0, 8),
      });
    }
  }

  const softFlags: SoftFlag[] = [];
  if (parse.has.open && parse.openItems === 0) {
    softFlags.push({
      key: 'open-empty',
      message: '未决段是空的。空的未决段通常不是"全想清楚了", 是没认真想 —— 只报不拒, 请自查一遍。',
    });
  }

  return { pass: failures.length === 0, metrics, labels: LABELS, failures, softFlags, thresholds: th, parse };
}
