/**
 * dag/veto-guard —— **外层 verifier 否决"已拿到机器绿"的一轮时,判词必须可证伪**
 * (C,2026-08-21,run `58df6b9e` 复盘)。
 *
 * ## 它治的那个 fail-open
 *
 * P2 那跑的完整形状(全部有日志):
 *
 * ```
 * 内环: stop={kind:'success', evidence:'冻结判据绿'}, poisoned=[]   ← 四片都做完了
 *   ↓ 内环 judge 的点名因为「点了子图中不存在的 id」被丢弃 (engine.ts:1234)
 *   ↓ 外层 verifier 未过 → 静默升级重规划
 * D-4 毒集 → 丢弃已绿 checkpoint → 重跑的 leaf 面对半个已完成世界 → empty-artifact
 *   ↓ 5 个 dep-skip (含最终 tsc + `bun test .` 的验收节点)
 * ```
 *
 * 扎人的一条在末尾:**重规划之后 verifier 的最终判词抱怨「5/7 成功、2 个失败」——
 * 而那两个失败正是它自己那次否决造成的。判词在给自己制造的残骸打分。**
 *
 * 这是一个 fail-open:**无效的 blame 也能推翻已绿的轮次**。本仓的口径本来就相反 ——
 * 「finding ≠ ground truth,oracle 证伪可驳」—— 只是这条链上一直没接。
 *
 * ## 判据窄到只挡"什么都没点名"
 *
 * 刻意**不去判判词对不对**(那要另一个模型,而且就是它在错)。只判一件可机械验证的事:
 * **这条否决有没有指向盘上一个能去核对的东西** —— 一个图里真实存在的节点 id,
 * 或一个长得像文件路径的串(可带 `:行号`)。
 *
 * 窄成这样是有意的:
 *   · 判据越窄,假阳性越少;而**假阳性的代价是有人把整条闸关掉**(S-45 收窄时买过一次)。
 *   · 真正没有合法解释的只有「否决了机器绿,却一个可核对的东西都说不出来」。
 *   · 判词点名了不存在的 id → 也算不可证伪。那正是 P2 的形状(ghost id 被丢弃)。
 *
 * ## 它**不**做的事
 *
 * · 不拦「这一轮没拿到机器绿」的否决 —— 那种否决本来就该放行(活确实没干完)。
 * · 不拦 `[verifier-error]` 这类基础设施故障判词 —— 那条路自己 fail-closed,不归这里管。
 * · 不判判词的对错、不判严重度、不给建议。
 *
 * @module
 */

/** 一条否决判词的可证伪性裁定。 */
export interface VetoVerdict {
  /** `true` = 判词点到了能去核对的东西 → 放行重规划(老行为)。 */
  falsifiable: boolean;
  /** 判据命中的那个东西(留证用:「凭什么放行/凭什么拦」)。`falsifiable:false` 时为空数组。 */
  anchors: string[];
  /** 人话版,直接进日志与回执。 */
  why: string;
}

/**
 * 长得像文件路径的串:至少一层 `/` 或一个已知代码后缀,可带 `:行号`。
 *
 * ⚠ 不用「含 `/` 就算」:判词里 `5/7 成功` 这种比例串会命中,而那**恰恰是 P2 那条判词的原文** ——
 * 拿它当锚就等于给这条闸开了个后门(闸会在它最该红的那个样本上放行)。所以要求斜杠两侧都是
 * 路径字符且整体带后缀,或者干脆是个带后缀的文件名。
 */
const PATH_LIKE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,6}(?::\d+)?|\b[\w.@-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|sql|sh|yaml|yml|toml)(?::\d+)?\b/;

/**
 * 这条否决判词可不可证伪。
 *
 * @param reason      verifier 的判词原文。
 * @param knownNodeIds 图里**真实存在**的节点 id —— 点名不存在的 id 不算锚(P2 的 ghost 形状)。
 */
export function classifyVeto(reason: string, knownNodeIds: Iterable<string>): VetoVerdict {
  const text = (reason ?? '').trim();
  if (!text) {
    return { falsifiable: false, anchors: [], why: '判词为空 —— 没有任何可核对的东西' };
  }
  const anchors: string[] = [];
  for (const id of knownNodeIds) {
    // 空 id 不当锚(它 `includes` 恒真,会让整条闸恒放行 —— 这类"恒真谓词"是本仓的常见静默错法)。
    if (id && text.includes(id)) anchors.push(`node:${id}`);
  }
  const m = PATH_LIKE.exec(text);
  if (m) anchors.push(`path:${m[0]}`);
  if (anchors.length === 0) {
    return {
      falsifiable: false,
      anchors: [],
      why: '判词没点到图里任何一个真实节点 id, 也没点到任何文件路径 —— 它说不出该去核对什么',
    };
  }
  return { falsifiable: true, anchors, why: `判词点到了 ${anchors.join(' · ')}` };
}

/** 基础设施故障判词(verifier 自己调不通)——**不归本闸管**,那条路自有 fail-closed。 */
export function isInfraVerdict(reason: string): boolean {
  return (reason ?? '').includes('[verifier-error]');
}
