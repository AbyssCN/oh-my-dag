/**
 * harness/claim-anchor —— **产物里的「file:line + 字面量」声称,能不能在那个文件里找到**
 * (2026-08-16,#145 附录 §9.5)。
 *
 * ## 现场
 *
 * `VoiceCommandScreen.tsx` 的代码早已换成 token(`light.primarySoft` / `light.primaryDeep` /
 * `dark.primary`),而**同一个文件的文件头简报**仍写着:
 *
 * > 屏底 navy 渐变 `#1d3a72 → #10203F` …… **此为屏内唯一允许的裸 hex**
 *
 * 终审节点验了**代码**干净(「S9 clean: no bare hex」),**但没交叉核文件头的声称**。
 *
 * **这类缺陷比代码写错更隐蔽**:简报是**给下一个人做决定用的**,失真的简报会让后续判断
 * 建立在错误前提上 —— 而代码是对的,所有 oracle 都绿。
 *
 * ## 与 `claimed-actions` / `review/anchor-check` 的分工
 *
 * 同一族(**声称 ⊆ 事实**),三条各验一样东西,不合并:
 * - `claimed-actions`:声称的**引擎动作** ⊆ 引擎记录的动作;
 * - `review/anchor-check`:审查 finding 的锚点(文件存在 + line ≤ 行数);
 * - **本模块**:产物文本里的**内容声称** —— 不止锚点在不在,还问**那句话在不在**。
 *
 * ## 三级,按误报风险分,出口不同
 *
 * | 级 | 判什么 | 误报 | 出口 |
 * |---|---|---|---|
 * | L1 | 点名的路径存在 | 几乎零 | **判红** |
 * | L2 | 行号 ≤ 文件行数 | 零(纯算术) | **判红** |
 * | L3 | 声称的字面量能在文件里找到 | ⚠ **有** | **report-only** |
 *
 * L3 才是上面那个现场的形态,但它也是唯一会误报的 —— 简报完全可能在描述"改之前是什么样"
 * "应当避免的写法",或引用别的仓。所以 L3 **只报不判**,同 §8.5 那条 no-op 指标的做法。
 *
 * ⚠ **但这次给 L3 定了结案条件**:`L3_REVIEW_AFTER` 个样本之后必须看一次假阳性率,
 * 要么升成闸要么删掉。§8.5 那条注写着「得先有分布」,然后攒了一年没人回来结案 ——
 * 一笔无人认领的账和没有这笔账一样没用。
 *
 * ## 收敛面:只判**带完整文件锚**的声称
 *
 * 判据故意窄:必须是 `路径:行号` 紧跟着一个反引号字面量(或同一行内)。
 * 散在散文里的裸 hex 一律不判 —— 那是把 L3 的误报面砍掉大半的地方,
 * 而不是"漏了"(拿不准一律不报,同 static-lint / g1 闸)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** L3 攒够这么多样本必须回来结案(升闸 or 删掉)。别再让它变成第二笔无人认领的账。 */
export const L3_REVIEW_AFTER = 30;

export type ClaimLevel = 'L1-path' | 'L2-line' | 'L3-literal';

export interface ClaimViolation {
  level: ClaimLevel;
  /** 声称里点名的路径(原文)。 */
  path: string;
  /** 声称里点名的行号(L1 无行号时缺席)。 */
  line?: number;
  /** L3:声称里那个字面量。 */
  literal?: string;
  /** 人话,给下游 leaf / 重规划轮直接消费。 */
  message: string;
}

/**
 * `路径:行号` 后面(同一行内)跟着一个反引号字面量。
 *
 * 路径段要求含 `/` 或带扩展名 —— 与 `leaf-tier-gate.extractPathTokens` 同一条词法保守口径:
 * 真正的过滤靠 stat,词法只负责别把 `1:30`(时间)当路径。
 */
const ANCHORED_CLAIM = /([A-Za-z0-9._\-/]*[A-Za-z0-9._-]\.[A-Za-z0-9]{1,8})(?::(\d+))?([^\n`]{0,80}`([^`\n]{1,80})`)?/g;

export interface ClaimAnchorOpts {
  root: string;
  /** 注入式读文件(测试用)。返回 `null` = 读不到。 */
  readFile?: (absPath: string) => string | null;
  /** 一次最多判多少条声称(防一份长报告把节点末拖慢)。 */
  limit?: number;
}

const defaultRead = (p: string): string | null => {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};

/**
 * 判一段产物文本。返回违规;**判不了的一律不返**(路径不像仓内路径 / 读不到 / 没有锚)。
 *
 * ⚠ 路径读不到 ≠ L1 违规:`readFile` 返 `null` 分两种 —— 文件不存在(L1 红)与读失败
 * (跳过)。这里用 `existsSync` 与读内容分开判,免得把权限问题报成"你说的文件不存在"。
 */
export function checkClaimAnchors(text: string, opts: ClaimAnchorOpts): ClaimViolation[] {
  const read = opts.readFile ?? defaultRead;
  const limit = opts.limit ?? 40;
  const out: ClaimViolation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ANCHORED_CLAIM)) {
    if (out.length >= limit) break;
    const path = m[1]!;
    const lineNo = m[2] ? Number(m[2]) : undefined;
    const literal = m[4];
    // 只判**看起来是仓内相对路径**的。`node:fs` / `https://x.com/a.js` 之类一律跳过。
    if (isAbsolute(path) || path.includes('://')) continue;
    const key = `${path}:${lineNo ?? ''}:${literal ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const abs = resolve(opts.root, path);
    const content = read(abs);
    if (content === null) {
      // L1 **必须带行号**(2026-08-16 接线时补的收敛):没有行号的路径提及大量是
      // 「建议新建 `src/foo.ts`」「产物将写到 `out/x.json`」这类**面向未来**的话,
      // 报它们是纯误报。带了 `:行号` 才是在**断言一个已存在的位置** —— 那才判得了真假。
      if (lineNo === undefined) continue;
      // 还要词法上像仓内路径 (含 `/`), 拿不准不报。
      if (!path.includes('/')) continue;
      out.push({
        level: 'L1-path',
        path,
        ...(lineNo !== undefined ? { line: lineNo } : {}),
        message: `声称点名了 \`${path}\`, 但这个路径在盘上找不到 —— 产物里的引用必须指向真实存在的文件。`,
      });
      continue;
    }
    const lines = content.split('\n');
    if (lineNo !== undefined && lineNo > lines.length) {
      out.push({
        level: 'L2-line',
        path,
        line: lineNo,
        message: `声称点名了 \`${path}:${lineNo}\`, 而该文件只有 ${lines.length} 行 —— 行号指向文件之外。`,
      });
      continue;
    }
    // L3: 声称的字面量在不在。**只报不判** —— 简报可能在描述"改之前"或"应当避免的写法"。
    if (literal && !content.includes(literal)) {
      out.push({
        level: 'L3-literal',
        path,
        ...(lineNo !== undefined ? { line: lineNo } : {}),
        literal,
        message:
          `声称 \`${path}\`${lineNo !== undefined ? `:${lineNo}` : ''} 里有 \`${literal}\`, ` +
          `但当前文件里找不到这个串 —— 若这句是在描述**改之前**的样子, 请在文中写明; ` +
          `否则简报与文件已经对不上, 而**简报是给下一个人做决定用的**。`,
      });
    }
  }
  return out;
}

/**
 * L1/L2 在**判据上**是零误报的(路径存在性、行号算术),L3 不是。
 *
 * ⚠ 但**接线上今天三级全部只进观察面**,一条都不判红。接线时才看见的那个误报源:
 * 判据的零误报是**相对于 root** 的 —— 而节点输出里的路径未必以引擎那个 root 为基
 * (monorepo 里常写成 `apps/mobile/src/...` 或反过来只写 `src/...`)。root 对不上的时候,
 * L1 会把一句正确的引用报成"文件不存在"。
 *
 * 所以先用 observation 攒分布:等看得见「L1 报出来的里有多少是 root 错配」再决定升不升闸。
 * 这与我原本的建议(L1/L2 直接判红)不同,改的理由就是上面这一条 —— 写在这里,免得
 * 后来的人以为它本来就是只报不判。
 */
export const isBlockingLevel = (l: ClaimLevel): boolean => l !== 'L3-literal';
