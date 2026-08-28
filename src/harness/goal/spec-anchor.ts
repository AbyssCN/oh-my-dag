/**
 * goal/spec-anchor —— 契约里那些**不进节点**的话的内容锚(T-1b,2026-08-28)。
 *
 * ## 它治的病(S-51)
 *
 * 契约改了某一片的语义,而那一片的 verify 命令没变、且修订前后都绿 →
 * `resume` 的绿节点复用把它整片跳过,契约修订**一行代码都没进**。
 * 两边都报成功:契约确实改了,run 确实重跑了,只有「改的那件事有没有做」这一格没人问。
 *
 * 实账:conductor S3 的 run `ded15ab4`。改了决策 D-8a 再 resume,片 4 的
 * `plan-critic-budget.test.ts` 前后都是 17 pass / 0 fail,verify 逐字未变 ⇒ 整片没跑。
 *
 * ## 为什么锚只装「共享规格段」这一块
 *
 * 每片**专属**的规格(切片名 / 写集 / 依赖 / verify)编译之后就在节点里了,而节点的这些字段
 * 早被 `plan-passes/semantic-key.ts` 的 `nodeFieldsKey` 逐个签过(T-1a 让 `shouldSkip`
 * 真去比那份指纹)。所以**唯一还没被任何东西签到的**,是契约里那些**没进节点**的话 ——
 * 决策段、契约不变量、反作弊条款、片细则。本模块只装这一块。
 *
 * 推论:同一份契约里所有片拿到的是**同一个**锚值。这不是「整份文档一份哈希」那种过宽 ——
 * 每片之间的差别已经由既有字段分开了,而共享段本来就是**全片共享的规格**:它变了,
 * 每一片的规格就都变了。
 *
 * ## 排除表:叙述段不进锚
 *
 * 「现场 (Evidence)」与「未决 (Open)」是**叙述**不是规格:前者记的是查到了什么,
 * 后者记的是还没定的事。改它们一个错别字不该作废任何片 —— 会那样的闸会被人关掉。
 *
 * ⚠ **认不出的段一律当规格**(fail-closed)。文档标题格式漂了 / 出现新段名时,
 * 闸只会变**严**(多算一段进锚,多重跑一次),不会变松。把这条写反了,
 * 一次改标题就能让整道闸静默失效。
 *
 * @module
 */
import { createHash } from 'node:crypto';

/**
 * 叙述段的标题判据。**这是一张排除表,不是包含表** —— 见文件头那条 fail-closed 纪律。
 *
 * 判的是 `## ` 那一级(`###` 子标题跟随它的父段)。中英两种写法都收,因为
 * `/omd-contract` 出的模板两种都出现过(`## 现场 (Evidence)` / `## Evidence`)。
 *
 * ⚠ 尾部用的是 `(?![A-Za-z])` 而**不是** `\b`。`\b` 按 `[A-Za-z0-9_]` 判词边界,
 * 而「现场」两个字都不是词字符 —— `/现场\b/` 对 `## 现场 (Evidence)` **不匹配**,
 * 整张排除表会静默失效(2026-08-28 实测:★①/★③/★⑧ 三条当场红)。
 * 换成负向前瞻既能挡住 `Openness` 这类前缀撞名, 又不依赖词字符。
 */
const NARRATIVE_HEADING = /^##\s*(现场|Evidence|未决|Open)(?![A-Za-z])/;

/** `## ` 一级标题行。`###` 及更深的不切段 —— 它们属于上一个 `##`。 */
const TOP_HEADING = /^##\s+/;

/**
 * 契约全文 → **规格段**全文(逐段拼回,叙述段整段丢掉)。
 *
 * 首个 `## ` 之前的前言(标题行、日期、一句话摘要)算规格:它常写着这份契约到底要干什么。
 */
export function governingSpecText(sddText: string): string {
  const lines = sddText.split('\n');
  const kept: string[] = [];
  /** 当前所在的 `##` 段是不是叙述段。首段(前言)默认算规格。 */
  let inNarrative = false;
  for (const line of lines) {
    if (TOP_HEADING.test(line)) inNarrative = NARRATIVE_HEADING.test(line);
    if (!inNarrative) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 规格段的内容锚(sha256 前 16 hex)。
 *
 * 截 16 hex 与仓里另两处同长(`hashText` / `hashArtifact`)—— 锚是**判等**用的,
 * 不是防篡改用的,长度按既有惯例走。
 */
export function specAnchor(sddText: string): string {
  return createHash('sha256').update(governingSpecText(sddText)).digest('hex').slice(0, 16);
}
