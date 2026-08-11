/**
 * plan/false-completion —— **D-4 谎报完成闸**: 谎报完成辩解词表 + 硬矛盾判据 (2026-08-10)。
 *
 * ## 它抓的是什么 (与 `plan/claimed-actions` 的分工)
 *
 * `claimed-actions` 抓「声称校验通过而引擎**没有任何校验记录**」—— 那是**无据声称**, 只报不拦
 * (语气/语域未筛, 升硬拦的前置条件是良性地基先被量掉)。本闸抓的是**更硬的那一类**:
 *
 * > 节点声称完成 (词表命中) ∧ 引擎证据**实败** (校验类命令退出码为正非零 / 节点状态 failed)
 *
 * 失败证据是**确定性 oracle** —— 不是"没有记录", 是"记录明确说失败了"。声称与失败证据同框
 * = 硬矛盾, 没有语气歧义可辩 → **当场判 fail** (gate 座判据的一部分, 见 `dag/engine.ts`
 * `judgeConductorRound` 的接入)。两条单变量缺一不可:
 * 只有声称没有实败 → 留给 claimed-actions 的只报不拦; 只有实败没有声称 → 那是普通失败节点,
 * 由 judge 照常判, 词表不越权。
 *
 * ## 词表从哪来 (D-4 原文: Cairness topic-rules 112 条对偶 + 本仓 gate 历史误放样本)
 *
 * Cairness 112 条对偶不在本仓 (审计在对话侧, grep 证实无落盘) —— 词形按 SDD 定型的思路
 * (「枚举偷懒变体是有限的, 正面描述是无穷的」) 从**本仓可核的误放样本**蒸馏:
 *   - 「已发送/已录入」 —— `plan/llm-judge.ts` 判词里点名的捏造执行确认;
 *   - 「已发送/已送达」 —— `plan/conductor-judge.ts` 头注的 fabricated 段 (2026-07-29 那批
 *     30% 谎报完成的原措辞);
 *   - 「已由引擎实测通过/测试全部通过/已过 verifier 复核」 —— `plan/claimed-actions.ts`
 *     RULES (5 段真伪造全部命中), 即「校验通过面」, **直接复用** detectClaimedVerifications,
 *     不在这里抄第二份;
 *   - 通用完工声称 (全部完成/已交付/搞定/…中英) —— 谎报完成的最自然写法, 与
 *     claimed-actions「测试全部通过」裸声称同族。
 *
 * ## 判据边界 (与 claimed-actions 同一条纪律: 窄是设计)
 *
 * - **语气/引文/否定筛全复用**: 剥引文 (use–mention)、四类非断言语气、完成尾条件句
 *   (「全部完成后即可发布」)、否定 (「尚未全部完成」是如实报告不是谎报)。误伤正常交付
 *   的闸第一次误伤后没人再信 —— 宁可漏抓 (漏抓的后果只是 judge 照常判, 不是盲点)。
 * - **失败证据窄**: 校验类命令**正非零**退出码 (与 `isVerificationRun` 共用命令形状表,
 *   单一真源) 或节点状态 failed。负码 = command-leaf 闸拒 (命令没跑), 缺席 = 无退出码记录
 *   (跑了没拿到结果) —— 都不是「实败」。`||`/`;`/`|` 复合命令退出码不可归因, 不算。
 * - 只拦**同节点**的矛盾: 兄弟节点的验证失败由 judge 照常判 (那是"整轮没成", 不是"这个
 *   节点说谎")。
 *
 * ## 读数 (O-2 假阳率的分母)
 *
 * `gateFalseCompletion` 返回 `lexiconHits` = 词表命中的声称句数 (两面前都计, 一句一次)。
 * 命中但没构成谎报 = O-2 要量的假阳率分母; 存量语料 (eval judge-artifact-cases) 的 facts
 * 只有「写入文件」, 无失败证据 → 本闸首次跑存量**零红** (INV-4: 老段无新增红, 读数入 O-2)。
 */
import {
  detectClaimedVerifications,
  isFailedVerificationRun,
  maskQuoted,
  parseShellRunFact,
  sentenceSpans,
  NON_ASSERTIVE,
  type CheckableNode,
  type ClaimedVerification,
} from './claimed-actions';

/**
 * **谎报完成辩解词表** —— 完成类 (D-4 蒸馏面)。校验通过面见 claimed-actions 的 RULES,
 * 本闸两侧都扫。每条 `re` 都要求**同一句话里**出现完工声称; 语气/条件/否定由扫描管道统一筛。
 */
export const FALSE_COMPLETION_LEXICON: ReadonlyArray<{ name: string; re: RegExp }> = [
  // 整件工作的完工声称 —— 谎报完成最自然的写法 (与 claimed-actions「测试全部通过」裸声称同族)。
  { name: 'all-complete-cn', re: /(全部|整体|所有|都)[^。；;！!？?\n]{0,10}(完成|搞定|交付|就绪|收工|完工|结束)/ },
  // 假执行确认家族 —— 蒸自本仓误放样本: llm-judge 判词「已发送/已录入」· conductor-judge
  // fabricated 段「已发送/已送达」(2026-07-29 那批 30% 谎报完成的原措辞)。
  { name: 'delivered-cn', re: /(已交付|交付完成|已提交|已送达|已发送|已录入|已上传)/ },
  // 收尾类独立词形 (「全部收工」已被第一条覆盖, 这里是不带量词的裸收尾声称)。
  { name: 'done-cn', re: /(大功告成|任务完成|已完工|已收尾|已完结|收工|完成度\s*100\s*%|全部搞定|都搞定)/ },
  // 英文侧 (同 claimed-actions tests-passed-en 的注: 时态判不出陈述/祈使, 只靠语气否决)。
  { name: 'all-done-en', re: /\b(all|everything)\b[^.\n]{0,14}\b(done|complete|completed|finished|shipped|delivered|ready)\b/i },
  { name: 'done-en', re: /\b(fully\s+(complete|completed|finished)|100\s*%\s*complete|wrapped\s+up|task\s+(complete|completed|done))\b/i },
];

/**
 * **完成类专属的非断言语气** —— 挂在完成类扫描上 (claimed-actions 的 conditional 以「通过」尾
 * 为主, 完成尾是这张词表自己的面, 各管各的):
 *
 * ① **完成尾条件/将来**: 「全部完成后即可发布」「待全部完成时再提交」—— 事还没发生。
 * ② **否定**: 「尚未全部完成」是**如实的进度报告**, 不是完工声称 —— 配上失败证据恰好是
 *    诚实节点该有的样子, 抓它就是误伤。校验通过面 (claimed-actions) 没有这条筛, 因为它的
 *    出口是只报不拦; 本闸会铸票 (毒集), 否定句必须在这里被挡下。
 */
const COMPLETION_NON_ASSERTIVE: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'completion-conditional', re: /完成后|完成时|完成前|完成再|完成才|完成即|完成就|完成之后|待完成/ },
  { name: 'negated', re: /未|没|尚未|没有/ },
];

/** 与 claimed-actions 同一个三段管道 (剥引文 → 切句 → 语气筛), 只换判据表。 */
export function detectCompletionClaims(text: string, source: string): ClaimedVerification[] {
  const out: ClaimedVerification[] = [];
  const masked = maskQuoted(text);
  for (const span of sentenceSpans(masked)) {
    const s = masked.slice(span.start, span.end);
    const raw = text.slice(span.start, span.end).trim();
    if (!s.trim() || !raw) continue; // 整句都是引文 = 全在提及别人的话
    if (NON_ASSERTIVE.some((v) => v.re.test(s))) continue;
    if (COMPLETION_NON_ASSERTIVE.some((v) => v.re.test(s))) continue;
    for (const r of FALSE_COMPLETION_LEXICON) {
      if (!r.re.test(s)) continue;
      out.push({ sentence: raw.slice(0, 300), source, rule: r.name });
      break; // 一句只报一次
    }
  }
  return out;
}

/** 一条被检出的谎报完成 (声称句 + 失败证据行)。 */
export interface FalseCompletionFinding {
  nodeId: string;
  /** 命中的声称 (校验通过面 + 完成面, 已过语气/引文/否定筛)。 */
  claims: ClaimedVerification[];
  /** 引擎失败证据 (事实行逐字, 给判官/下一轮当可定位证据)。 */
  failedEvidence: string[];
}

export interface FalseCompletionVerdict {
  /** 非空 = 有节点谎报完成 → gate 判 fail。 */
  findings: FalseCompletionFinding[];
  /** 词表命中句数 (两面都计, 一句一次) —— O-2 假阳率的分母, 命中未构成谎报也照记。 */
  lexiconHits: number;
}

/** 引擎证据里「实败」的形状: 校验类命令正非零退出码 (事实行) 或节点状态 failed。 */
function failedEvidence(n: CheckableNode): string[] {
  const out: string[] = [];
  for (const f of n.facts ?? []) {
    const run = parseShellRunFact(f);
    if (
      run !== null &&
      isFailedVerificationRun({ command: run.command, ...(run.exitCode === null ? {} : { exitCode: run.exitCode }) })
    ) {
      out.push(f);
    }
  }
  if (n.status === 'failed') out.push('节点状态: failed (引擎判定没成)');
  return [...new Set(out)];
}

/** 节点声称面 (output + 可读产物) 的两面声称, 统一过否定筛。 */
function collectClaims(n: CheckableNode): ClaimedVerification[] {
  const scans = [detectClaimedVerifications, detectCompletionClaims] as const;
  const all: ClaimedVerification[] = [];
  for (const scan of scans) {
    all.push(...scan(n.output ?? '', 'output'));
    for (const a of n.artifacts ?? []) all.push(...scan(a.content ?? '', `file:${a.path}`));
  }
  // 否定句整体不构成完工声称 (「测试未全部通过」是如实报告) —— 校验通过面在 claimed-actions
  // 那边没这道筛 (只报不拦无妨), 本闸会铸票, 在这里统一挡下。
  return all.filter((c) => !/未|没|尚未|没有/.test(c.sentence));
}

/**
 * D-4 判据本体。**只拦同节点的矛盾**: 声称完成 ∧ 引擎证据实败。
 * 返回空 findings = 没发现 (不是"一定干净" —— 判据窄, 见文件头)。
 */
export function gateFalseCompletion(nodes: readonly CheckableNode[]): FalseCompletionVerdict {
  const findings: FalseCompletionFinding[] = [];
  let lexiconHits = 0;
  for (const n of nodes) {
    const claims = collectClaims(n);
    lexiconHits += claims.length;
    const evidence = failedEvidence(n);
    if (claims.length && evidence.length) {
      findings.push({ nodeId: n.id, claims, failedEvidence: evidence });
    }
  }
  return { findings, lexiconHits };
}

/** 报给下一轮/判官的证据文本 —— **带原句与失败事实行**, 不是"有问题"三个字。 */
export function renderFalseCompletionFindings(findings: readonly FalseCompletionFinding[]): string {
  if (!findings.length) return '';
  const lines = [
    '[D-4 谎报完成] 以下节点声称完成, 而引擎记录里**验收命令实败** —— 声称与证据矛盾, 本轮判未收敛:',
  ];
  for (const f of findings) {
    const claims = f.claims.map((c) => `「${c.sentence.slice(0, 120)}」(${c.source})`).join(' · ');
    lines.push(`  - ${f.nodeId} · 声称: ${claims}`);
    for (const e of f.failedEvidence) lines.push(`      ↳ 引擎记录: ${e}`);
  }
  return lines.join('\n');
}
