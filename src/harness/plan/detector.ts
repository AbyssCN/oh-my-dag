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
 * **`executor:'command'` 的检测者最硬** (`echo "REJECT: write-a"` 是确定性的, 比第三次 LLM 调用
 * 便宜且可信), 但它有一条**按构造的限制**: 命令串在规划期就写死了, 那时兄弟的内容寻址 id 还
 * 不存在 —— 所以命令检测者只能用**规划期的可读 id** 点名 (引擎负责翻译, 见 parseDetectorVerdict
 * 的 aliases), 否则它一个 `REJECT:` 都发不出来, 只剩 `BLOCKED:` 这种静态字符串能喊。
 * LLM 检测者没这个限制 (它在 prompt 里看得见运行期 id), 引擎会把协议附在它的 prompt 末尾。
 *
 * ⚠ **进 conductor 的明示形状是被迫的** (2026-07-30 当天推翻了自己前一版的"刻意不明示"):
 * 这个字段只在 conductor 自己画的子图里有消费者, 而子图只有 conductor 画得出来 —— 不告诉它,
 * 它就没有任何生产者, 那正是本仓一直在猎杀的空旋钮。代价用 prompt 里比 when 更长的 whenNot 压。
 */

/** 检测者节点的输出协议 (引擎附在 detector 节点的 prompt 末尾, 省得每张手写 plan 抄一遍)。 */
export const DETECTOR_PROTOCOL = [
  '',
  '## 检测者输出协议 (逐字照抄这两种行, 引擎按裁决读)',
  '你是这一轮的**检测者**: 上游各节点的产出都在上面, 你的活是看它们**相互之间**对不对得上',
  '(一个节点自己看不见别的节点, 这是你独有的视角)。除了正常的分析文字, 按需追加:',
  '',
  '- `REJECT: <上游节点 id>` —— 这一段产出本身错了/缺了/是编的。一行一个。',
  '  id 写**你在这张 plan 里给那个节点起的名字**即可 (引擎会翻成运行期 id); 上面出现的那个长 id 也认。',
  '  宁可多点名不可漏点名 (没被点名的产出会被当作已批准结果带进下一轮)。',
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
 *
 * `aliases` = conductor 规划期写的**可读 id** → 运行期的内容寻址 id。**这条映射是必需的,
 * 不是方便**: 内容寻址 id 是展开那一刻才算出来的, 而 `executor:'command'` 的命令串在规划期
 * 就写死了 —— 于是一个命令检测者**永远点不出兄弟的名字**, 除非它能用自己刚写下的那个可读名。
 * (2026-07-30 撞出来的: 前一版 prompt 写着"首选 command 检测者", 而那种检测者按构造只能喊
 * `BLOCKED:`, 一个 `REJECT:` 都发不出来。)
 *
 * ⚠ 与 judge 视图**刻意不给别名**那条不冲突, 方向相反: 那边是不让模型**看见**别名 (看见就会
 * 照抄, 而 judge 的点名必须落在内容寻址 id 上); 这边是**接受**别名并翻译回去 —— 检测者写的
 * 别名不是幻觉, 是它自己在这张子图里给节点起的名字。翻译不出来的仍按幽灵处理。
 */
export function parseDetectorVerdict(
  text: string,
  knownIds: readonly string[],
  aliases?: ReadonlyMap<string, string>,
): DetectorVerdict {
  const known = new Set(knownIds);
  const resolve = (name: string): string | null => (known.has(name) ? name : (aliases?.get(name) ?? null));
  const rejected: string[] = [];
  const ghosts: string[] = [];
  let blocked: string | undefined;
  for (const line of text.split('\n')) {
    const r = REJECT_LINE.exec(line);
    if (r?.[1]) {
      const named = r[1];
      const id = resolve(named);
      if (id) {
        if (!rejected.includes(id)) rejected.push(id);
      } else if (!ghosts.includes(named)) {
        ghosts.push(named);
      }
      continue;
    }
    const b = BLOCKED_LINE.exec(line);
    // 首条 BLOCKED 为准: 多条 = 同一件事的不同说法, 取第一条比拼接更像人写的话。
    if (b?.[1] && blocked === undefined) blocked = b[1];
  }
  return { rejected, ghosts, ...(blocked !== undefined ? { blocked } : {}) };
}
