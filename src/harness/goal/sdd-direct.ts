/**
 * src/harness/goal/sdd-direct —— solve 直通入口的 SDD 装载件 (SDD 2026-08-10-solve-sdd-direct-entry)。
 *
 * 已结晶的 SDD 即契约: `sddPath` 给了就跳过 research 轮与契约段子图 (specPath/evidence 直接
 * 取自文件, 与闸 C「契约段产物复用」同一条消费通路)。实测背景: 对一份 8KB 的已结晶 SDD,
 * 契约段转录税 ~224.5k tokens / ~15 分钟 (run b4989a06), 产出自述「GWT 逐条收录, 语义未改」。
 *
 * **fail-loud 是这里的全部性格** (D-3): 缺契约段的文档不是 SDD —— 拒起跑, 不静默降级回全程
 * goal (静默降级 = 调用方以为省了税, 实际付了全价, 比不支持更坏)。
 */
import { readFileSync } from 'node:fs';

/** 直通契约的最小结构要求: 六段式里这两段是执行与验收的地基, 缺任一 = 不是可执行契约。 */
const REQUIRED_SECTIONS: readonly { key: string; pattern: RegExp }[] = [
  { key: '契约 (Contracts)', pattern: /^##\s*契约|^##\s*Contracts/m },
  { key: '分解 (Breakdown)', pattern: /^##\s*分解|^##\s*Breakdown/m },
];

export interface SddContract {
  /** SDD 原文 (原样进 execute 任务文本, 含并行波形)。 */
  readonly text: string;
  /** 装载路径 (= specPath, 契约已落盘的那份就是它)。 */
  readonly path: string;
}

/**
 * 装载并校验直通 SDD。读不到 / 缺必备段 → throw (错误信息指名缺什么, G-2)。
 * 校验是结构级不是语义级: 段在就行, GWT 写没写好由 execute 的验收面兜 —— 这里挡的是
 * 「拿一篇散文冒充契约」那一档。
 */
export function loadSddContract(path: string): SddContract {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`sddPath 读不到: ${path} — ${(e as Error).message}`);
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !s.pattern.test(text)).map((s) => s.key);
  if (missing.length) {
    throw new Error(
      `sddPath 不是可执行契约 (缺段: ${missing.join('、')}): ${path} — ` +
        '缺契约段的文档回 /omd-contract 补齐, 不静默降级回全程 goal。',
    );
  }
  return { text, path };
}

// ── Breakdown 表解析 (内环 v2 切片 1 · SDD 2026-08-11-inner-loop-v2, D-1) ─────────────
//
// D-1 说的「编译器机械、零 LLM」从这里开始: 已结晶 SDD 的分解段本来就是结构化的
// (/omd-contract 规范钉死四列 + 一行波形), 把它读成结构是**纯字符串工作**, 不需要请一次
// conductor。解析器只管形状, 跨列的引用完整性 (依赖/波形指向的 id 存不存在、写集相不相交)
// 归编译器 —— 那是画图时才需要成立的事 (见 ./sdd-compile)。

/** 分解表的一行 = 平铺图上的一个执行节点 (编译在 ./sdd-compile)。 */
export interface SddSlice {
  /** 切片编号 (表里的前导数字, 也是波形/依赖列引用它的方式)。 */
  readonly id: number;
  /** 切片名 (去掉编号与 ✅/** 等进度装饰后的那句话)。 */
  readonly name: string;
  /** 写集: 本片预期写入的路径清单。**并行安全的机器判据** (/omd-contract: 写集两两不相交)。 */
  readonly writeSet: readonly string[];
  /** 依赖的切片 id。「带理由」的括号是给人读的, 结构里只留 id。 */
  readonly deps: readonly number[];
  /** verify 列原文 (D-4 定向 TDD 的 RED/GREEN 命令串; 是否可跑由编译器判)。 */
  readonly verify: string;
}

export interface SddBreakdown {
  readonly slices: readonly SddSlice[];
  /**
   * 并行波形 = 作者**声明**的层序 (`并行波形:{1,3,4} → {2} → {5}`)。没写 → undefined,
   * **刻意不从依赖列反推**: 反推出来的层序与依赖列同源, 而它唯一的消费者 (sdd-compile 的
   * 乱序闸) 正是拿它去校对依赖列的 —— 自己推自己, 闸恒绿。
   * NULL ≠ 0 ≠ 不适用: undefined 在这里明确是「作者没声明」, 不是「只有一层」。
   */
  readonly waves?: readonly (readonly number[])[];
}

/** 分解段起点 (与 REQUIRED_SECTIONS 同一族匹配; 段止于下一个 `## `)。 */
const BREAKDOWN_HEADING = /^##\s*(?:分解|Breakdown)/m;
/** 波形行: `并行波形:{1,3} → {2}` (允许 backtick / 引用前缀 / 全半角冒号)。 */
const WAVE_LINE = /^[>\s*-]*(?:并行波形|波形|Waves?)\s*[:：]\s*(.+)$/m;
/** 表格分隔行 `|---|:--:|`。 */
const SEPARATOR_CELL = /^:?-{2,}:?$/;
/** 表头行 (列名由 /omd-contract 规范钉死)。 */
const HEADER_CELL = /^(切片|slice)$/i;
/** 写集/依赖列的项分隔 (半角与全角并列 —— 中文表里两种都会出现)。 */
const ITEM_SEP = /[+,，、;；]/;

/** 括号内是给人读的理由/注解 (`—(消费 blame.ts)` · `sdd-compile.ts(新)`), 解析前剥掉。 */
const stripAnnotations = (cell: string): string =>
  cell.replace(/`/g, '').replace(/[(（][^)）]*[)）]/g, ' ');

/**
 * 写集列 → 路径清单。「+ test」是 /omd-contract 表的惯例简写「连同它的测试」, 展开成同名
 * `.test.ts` 兄弟 —— 不展开等于把「这片也写测试」这条事实丢掉, 而写集相交闸靠的正是这份清单。
 */
function parseWriteSet(cell: string, id: number): string[] {
  const out: string[] = [];
  for (const raw of stripAnnotations(cell).split(ITEM_SEP)) {
    const t = raw.trim();
    if (!t || t === '—' || t === '-') continue;
    if (/^tests?$/i.test(t)) {
      const last = out[out.length - 1];
      if (!last)
        throw new Error(`分解表切片 ${id}: 写集里的 "test" 简写前面没有它所属的路径`);
      const sibling = last.replace(/\.(tsx?)$/, '.test.$1');
      if (sibling !== last && !out.includes(sibling)) out.push(sibling);
      continue;
    }
    if (!t.includes('/'))
      throw new Error(`分解表切片 ${id}: 写集有不像路径的项 "${t}" (写集只收相对路径)`);
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length)
    throw new Error(`分解表切片 ${id}: 写集为空 —— 写集是并行安全的机器判据, 不许留白`);
  return out;
}

/** 依赖列 → id 清单 (括号理由已剥, 剩下的数字就是 id; `—` → 空)。 */
function parseDeps(cell: string, id: number): number[] {
  const out: number[] = [];
  for (const n of stripAnnotations(cell).match(/\d+/g) ?? []) {
    const dep = Number(n);
    if (dep === id) throw new Error(`分解表切片 ${id}: 自依赖 (自己等自己, 永远跑不起来)`);
    if (!out.includes(dep)) out.push(dep);
  }
  return out;
}

/**
 * 解析「## 分解 (Breakdown)」段: 四列表 + 可选波形行 → 结构 (G-1 前半)。
 *
 * fail-loud 承 loadSddContract 的性格 (G-6): 解析不了的行**不跳过**——跳过 = 整片切片凭空
 * 消失, 图少一个节点而台账上什么都看不出来 (silent-failures 图鉴那一族)。
 */
export function parseBreakdown(text: string): SddBreakdown {
  const head = BREAKDOWN_HEADING.exec(text);
  if (!head) throw new Error('分解 (Breakdown) 段缺失 —— 无表可解析');
  const after = text.slice(head.index + head[0].length);
  const nextHeading = /^##\s/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;

  const slices: SddSlice[] = [];
  const seen = new Set<number>();
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    if (HEADER_CELL.test(cells[0] ?? '')) continue;
    if (cells.length < 4)
      throw new Error(`分解表这一行不足四列 (切片|写集|依赖|verify): ${trimmed}`);
    const idMatch = /^(\d+)/.exec(cells[0]!);
    if (!idMatch)
      throw new Error(`分解表这一行的切片列不以编号开头 (编号是波形/依赖引用它的唯一方式): ${trimmed}`);
    const id = Number(idMatch[1]);
    if (seen.has(id)) throw new Error(`分解表切片编号重复: ${id} (两片会被并成一片, 少跑的那片没人发现)`);
    seen.add(id);
    slices.push({
      id,
      name: cells[0]!
        .slice(idMatch[0].length)
        .replace(/✅/g, '')
        .replace(/\*\*/g, '')
        .replace(/^[\s:：.、]+/, '')
        .trim(),
      writeSet: parseWriteSet(cells[1]!, id),
      deps: parseDeps(cells[2]!, id),
      verify: cells[3]!.replace(/`/g, '').trim(),
    });
  }
  if (!slices.length)
    throw new Error('分解段里没有切片行 —— 空表会编译成一张只有 accept 的图 ("什么都没干" 被读成 "跑完了")');

  const waveLine = WAVE_LINE.exec(section);
  const waves = waveLine
    ? [...waveLine[1]!.matchAll(/[{｛]([^}｝]*)[}｝]/g)].map((g) =>
        (g[1]!.match(/\d+/g) ?? []).map(Number),
      )
    : undefined;
  return waves?.length ? { slices, waves } : { slices };
}
