/**
 * plan/detector —— **图内 fan-in 检测者** (P3 D-Q) 的输出协议。
 *
 * D-Q 的三件套里, 这是"图**内**"那一件: 一个 `depends_on` 挂着若干兄弟节点的节点, 天然看得见
 * 它们全部的产出 —— 那正是普通节点做不到的"观察边"。缺的从来不是这个形状 (今天就画得出来),
 * 缺的是**它的判断落不进环**: 一个 fan-in 检查节点跑完只留下一段文本, 环下一轮该拒谁、该不该
 * 停下来等人, 全靠轮末那次 LLM judge 从散文里再读一遍。
 *
 * 于是这里只加**一个协议**, 不加节点类 (D-13: 剩余 gate 用现有节点表达, 不新造节点类):
 * 节点上写 `detector: true`, 输出里出现下面两种行, 引擎就当裁决读:
 *
 * ```
 * REJECT: <子节点 id>        ← 这一段产出不作数 (等价于 judge 点名, 直接进毒集)
 * BLOCKED: <原因>            ← 没有外部输入推不动 (环提前退出, 见 LeafResult.blocked)
 * ```
 *
 * **首选 producer 是 `executor:'command'`** —— 一个脚本 `echo "REJECT: x"` 是确定性的, 而
 * "谁坏了"由确定性 oracle 说出来比由第三次 LLM 调用说出来既便宜又可信 (D-13 不加新 gate 层的
 * 同一条理由)。LLM 检测者也能用: 引擎会把协议附在它的 prompt 末尾 (见 DETECTOR_PROTOCOL)。
 *
 * ⚠ **刻意不进 conductor prompt** —— 与 `thinking` 同待遇, 是**手写 plan 的逃生口**。理由是
 * 明示它就等于请 conductor 每张图都塞一个检测者, 而那是一笔没有证据支持的常驻开销
 * (D-M/N 的图式引导已经在管"该画什么", 不该由一个新字段再劝一次)。
 */

/** 检测者节点的输出协议 (引擎附在 detector 节点的 prompt 末尾, 省得每张手写 plan 抄一遍)。 */
export const DETECTOR_PROTOCOL = [
  '',
  '## 检测者输出协议 (逐字照抄这两种行, 引擎按裁决读)',
  '你是这一轮的**检测者**: 上游各节点的产出都在上面, 你的活是看它们**相互之间**对不对得上',
  '(一个节点自己看不见别的节点, 这是你独有的视角)。除了正常的分析文字, 按需追加:',
  '',
  '- `REJECT: <上游节点 id>` —— 这一段产出本身错了/缺了/是编的。id **逐字照抄**上面出现的那个,',
  '  一行一个。宁可多点名不可漏点名 (没被点名的产出会被当作已批准结果带进下一轮)。',
  '- `BLOCKED: <一句话原因>` —— **没有外部输入就推不动** (前提缺失/要求自相矛盾/需要人拍板)。',
  '  只在"再试多少轮都一样"时写它; 单纯"这轮没做好"用 REJECT, 别用它。',
].join('\n');

export interface DetectorVerdict {
  /** 点名拒绝且**图里真有**的子节点 id。 */
  rejected: string[];
  /** 点名了但图里没有的 id (幻觉; 留痕不入毒集, 同内环 judge 的幽灵处理)。 */
  ghosts: string[];
  /** BLOCKED 原因 (首条为准)。缺席 = 没喊阻塞。 */
  blocked?: string;
}

/** `REJECT:` / `BLOCKED:` 行 —— 行首 (允许前导空白), 大写关键词, 避免正文里的普通句子误命中。 */
const REJECT_LINE = /^\s*REJECT:\s*(.+?)\s*$/;
const BLOCKED_LINE = /^\s*BLOCKED:\s*(.+?)\s*$/;

/**
 * 解析检测者输出。**没有协议行 = 没有裁决** (空 verdict), 不是"全批准也不是全拒绝" ——
 * 检测者不喊话时环照原样走 (它是加一层观察, 不是新增一道必过的闸)。
 */
export function parseDetectorVerdict(text: string, knownIds: readonly string[]): DetectorVerdict {
  const known = new Set(knownIds);
  const rejected: string[] = [];
  const ghosts: string[] = [];
  let blocked: string | undefined;
  for (const line of text.split('\n')) {
    const r = REJECT_LINE.exec(line);
    if (r?.[1]) {
      const id = r[1];
      if (known.has(id)) {
        if (!rejected.includes(id)) rejected.push(id);
      } else if (!ghosts.includes(id)) {
        ghosts.push(id);
      }
      continue;
    }
    const b = BLOCKED_LINE.exec(line);
    // 首条 BLOCKED 为准: 多条 = 同一件事的不同说法, 取第一条比拼接更像人写的话。
    if (b?.[1] && blocked === undefined) blocked = b[1];
  }
  return { rejected, ghosts, ...(blocked !== undefined ? { blocked } : {}) };
}
