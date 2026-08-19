/**
 * src/harness/goal/design-review —— P4 设计审核政策模块 (纯核, 不依赖 run-goal 内部状态机)。
 *
 * 职责:
 * - 判定写集是否命中前端 glob → 若命中则调度审核叶 (advisory, 不上关键路径)
 * - finding 校验 (强制 uncertainty, where/evidence/fingerprint 完整性)
 * - 台账去重 (已裁项不重报, D-8; 指纹去重跨轮, G-5)
 * - 一波一修 / 同因熔断 / 存活转票 (D-7)
 * - 可选截图命令输入, 无则 diff-only 退化 (D-10)
 * - P0/P1 升档 Sonnet 5 复审 (D-4)
 *
 * INV-3: 审核失败/timeout → 调用方的 converged 结论与无审核节点逐位相同。
 * INV-6 / G-4: 写集与前端 glob 不相交 → 零模型调用。
 */
import { join } from 'node:path';
import { resolveProfile, type LeafProfile } from '../profiles/profile';
import { appendFindings, fingerprintOf, loadLedger, type ReviewFinding } from '../profiles/review-ledger';
import { runMechanicalLayer, type MechanicalDeps } from './design-review-mechanical';
import { logger } from '../logger';

/** 默认前端文件 glob (profile.frontendGlob 缺席时的回退)。 */
export const DEFAULT_FRONTEND_GLOB = '**/*.{tsx,jsx,css,html,vue,svelte}';

export interface DesignReviewResult {
  /** 本轮是否调度了审核 (写集与前端 glob 有相交)。 */
  scheduled: boolean;
  /** 真正落账的 finding 条数 (去重后, 不含 fused/tickets)。 */
  added: number;
  /** 指纹已存在被跳过的条数 (含同批内重复, G-5 前半)。 */
  deduped: number;
  /** 本轮新报的 findings (已落账, 供调用方决策修复)。repairAttempted 时恒空。 */
  findings: ReviewFinding[];
  /** 同指纹类二次出现 → 熔断 (D-7: 不再修复, 应转 suggested 票)。 */
  fused: ReviewFinding[];
  /** 修复后仍存活的 findings → 转 suggested 票 (D-7)。 */
  tickets: ReviewFinding[];
  /** P0/P1 findings → 需升档 Sonnet 5 复审 (D-4)。 */
  escalated: ReviewFinding[];
  /** 审核叶的 token 用量 (未调度 = {in:0,out:0})。 */
  usage: { in: number; out: number };
}

export interface DesignReviewOpts {
  cwd: string;
  /** execute 后改动的文件列表 (相对 cwd 的路径)。 */
  changedFiles: string[];
  /** 岗位档案名 (默认 'design-review')。 */
  profile?: string;
  /** 本 goal 是否已执行过一轮修复 (D-7: 每 goal ≤1 轮修复, 二次出现 → 熔断/转票)。 */
  repairAttempted?: boolean;
  /** 可选截图命令 (D-10: 有则走截图审, 无则 diff-only 退化)。如 `./.omd/screenshot.sh`。 */
  screenshotCommand?: string;
  /** Sonnet 5 座位名 (D-4: P0/P1 升档目标, 如 'sonnet-5')。缺省不升档。 */
  escalationSeat?: string;
  /**
   * 注入式审核 runner (测试用): 给 diff 文本 + cwd, 返回 findings 与用量。
   * 默认实现走 agent leaf 调度 (需 agentRunner)。
   */
  runReview?: (diff: string, cwd: string) => Promise<{ findings: ReviewFinding[]; usage: { in: number; out: number } }>;
  /** #98 机械层的注入面 (测试用: 永不起真进程)。缺省 = 真跑 `.omd/skills/impeccable/scripts/detect.mjs`。 */
  mechanical?: MechanicalDeps;
}

/**
 * 简易 glob → RegExp (`*` 不跨 `/`, `**` 跨目录, `{a,b}` = 择一)。
 * 同 write-set.ts 语义 + brace 扩展。brace 先展开并用 sentinel 保护, 防后续字符转义。
 */
function globToRegExp(glob: string): RegExp {
  const S = '\x00';
  const braceParts: string[] = [];
  const pre = glob.replace(/\{([^{}]+)\}/g, (_m, alts: string) => {
    braceParts.push(`(${alts.replace(/,/g, '|')})`);
    return `${S}${braceParts.length - 1}${S}`;
  });
  let re = '';
  for (let i = 0; i < pre.length; i++) {
    const c = pre[i]!;
    if (c === S) {
      const end = pre.indexOf(S, i + 1);
      const idx = parseInt(pre.slice(i + 1, end), 10);
      re += braceParts[idx]!;
      i = end;
    } else if (c === '*') {
      if (pre[i + 1] === '*') {
        re += '.*';
        i++;
        if (pre[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`(^|/)${re}$`);
}

/** 校验单条 finding: 返回 null=通过, 字符串=拒绝原因。强制 uncertainty 非空 (D-5)。 */
function validateFinding(f: ReviewFinding): string | null {
  if (!f.where || typeof f.where !== 'string') return 'where 缺失/非字符串';
  if (!f.evidence || typeof f.evidence !== 'string') return 'evidence 缺失/非字符串';
  if (!f.suggestion || typeof f.suggestion !== 'string') return 'suggestion 缺失/非字符串';
  if (!f.uncertainty || typeof f.uncertainty !== 'string') return 'uncertainty 缺失 (D-5: 不确定就写, 不许装确定)';
  if (!f.fingerprint || typeof f.fingerprint !== 'string') return 'fingerprint 缺失/非字符串';
  if (!['p0', 'p1', 'p2'].includes(f.severity)) return `severity 非法: ${f.severity} (允许 p0/p1/p2)`;
  const expected = fingerprintOf(f.where, f.evidence);
  if (f.fingerprint !== expected) return `fingerprint 不匹配 (期望 ${expected.slice(0, 12)}…)`;
  return null;
}

/** 解析台账路径: 相对路径以 cwd 为基, 绝对/显式相对路径原样。 */
function resolveLedgerPath(cwd: string, prof: LeafProfile | undefined): string {
  const raw = prof?.ledgerPath
    ? (prof.ledgerPath.startsWith('/') || prof.ledgerPath.startsWith('.')
        ? prof.ledgerPath
        : `.omd/${prof.ledgerPath}`)
    : '.omd/review-ledger.json';
  return raw.startsWith('/') ? raw : join(cwd, raw);
}

/**
 * 判定写集是否命中前端 glob, 命中则调度审核叶。
 *
 * 政策机 (D-7):
 * - repairAttempted=false → 首轮: 去重落账, 返回 findings 供调用方决策修复。
 * - repairAttempted=true  → 修复后: 台账已有首轮指纹; 同指纹 → fused (熔断转票),
 *   新指纹 → tickets (存活转票, 每 goal ≤1 轮修复); 不再落账。
 *
 * D-4 升档: P0/P1 finding → 进 escalated[] (调用方决定是否调 Sonnet 5 复审)。
 *
 * @returns DesignReviewResult (scheduled=false 时各项零值)。
 */
export async function maybeRunDesignReview(opts: DesignReviewOpts): Promise<DesignReviewResult> {
  const profileName = opts.profile ?? 'design-review';
  const prof: LeafProfile | undefined = resolveProfile(profileName, opts.cwd);
  const glob = prof?.frontendGlob ?? DEFAULT_FRONTEND_GLOB;
  const re = globToRegExp(glob);

  const frontendFiles = opts.changedFiles.filter((f) => re.test(f));
  if (frontendFiles.length === 0) {
    return { scheduled: false, added: 0, deduped: 0, findings: [], fused: [], tickets: [], escalated: [], usage: { in: 0, out: 0 } };
  }

  const ledgerPath = resolveLedgerPath(opts.cwd, prof);
  const existing = loadLedger(ledgerPath);
  const seen = new Set(existing.map((f) => f.fingerprint));
  const repairMode = opts.repairAttempted === true;

  let result: DesignReviewResult;
  try {
    // 收集原始 findings (跑审核或 diff-only 退化)
    const rawFindings: ReviewFinding[] = [];
    let usage = { in: 0, out: 0 };

    // ── #98 (persona 判序①): 机械层**先跑** ──────────────────────────────────
    //
    // `impeccable` 那套自带一个确定性、零 LLM 的反模式检测器, 它认得出边框/动效/辉光/排版/
    // 布局那一族「AI 生成界面的口音」。**规则命中是事实不是意见** —— 拿模型去重新发现一遍
    // 既慢又贵, 而且模型还可能漏。机械层拦得住的不进模型, 模型只审整读与品味。
    //
    // 顺序上放在模型审**之前**是刻意的: 机械 finding 与模型 finding 走同一套指纹去重
    // (见 design-review-mechanical.ts 的说明), 先落的那批能把模型重复报的同一条吃掉。
    // fail-open: 机械层跑不起来只 warn, 模型层照审 —— 它是加固不是前置条件。
    rawFindings.push(...runMechanicalLayer(frontendFiles, opts.cwd, opts.mechanical ?? {}));

    if (opts.runReview) {
      const diff = frontendFiles.map((f) => `# ${f}\n(文件路径: ${f})`).join('\n\n');
      const review = await opts.runReview(diff, opts.cwd);
      rawFindings.push(...review.findings);
      usage = review.usage;
    } else if (opts.screenshotCommand) {
      // 有截图命令却没有 runner 时不能冒充 diff-only 看过截图。run-goal 生产装配会为这条路挂
      // profile agent; 其它调用方漏装配则响亮失败, 由外层 advisory catch 收成零 finding。
      throw new Error(`截图命令已配置但 screenshot review runner 缺席: ${opts.screenshotCommand}`);
    } else {
      // D-10 退化路径: 无截图命令 → diff-only 文本审
      rawFindings.push(...buildDiffOnlyFindings(frontendFiles));
    }

    // 校验 findings, 不合法者过滤并 warn
    const validated: ReviewFinding[] = [];
    for (const f of rawFindings) {
      const err = validateFinding(f);
      if (err) {
        logger.warn({ finding: { where: f.where, severity: f.severity }, err }, '[omd/design-review] finding 校验不通过 → 丢弃');
        continue;
      }
      validated.push(f);
    }

    if (repairMode) {
      // D-7 修复后: 台账已有首轮指纹 → 同指纹=fused, 新指纹=tickets; 均不落账。
      const fused: ReviewFinding[] = [];
      const tickets: ReviewFinding[] = [];
      for (const f of validated) {
        if (seen.has(f.fingerprint)) {
          fused.push(f);
        } else {
          tickets.push(f);
        }
      }
      result = {
        scheduled: true,
        added: 0,
        deduped: 0,
        findings: [],
        fused,
        tickets,
        escalated: classifyEscalation(fused, tickets, opts.escalationSeat),
        usage,
      };
    } else {
      // 首轮: 去重 → 落账
      const fresh: ReviewFinding[] = [];
      let deduped = 0;
      for (const f of validated) {
        if (seen.has(f.fingerprint)) {
          deduped++;
          continue;
        }
        seen.add(f.fingerprint);
        fresh.push(f);
      }

      let added = 0;
      let ledgerDeduped = 0;
      if (fresh.length > 0) {
        const ledgerResult = appendFindings(ledgerPath, fresh);
        added = ledgerResult.added;
        ledgerDeduped = ledgerResult.deduped;
      }

      result = {
        scheduled: true,
        added,
        deduped: deduped + ledgerDeduped,
        findings: fresh.slice(0, added), // 只返回真正落账的
        fused: [],
        tickets: [],
        escalated: classifyEscalation(fresh.slice(0, added), [], opts.escalationSeat),
        usage,
      };
    }
  } catch (err) {
    // INV-3: 审核失败不掀桌, converged 结论与无审核节点逐位相同。
    logger.warn(
      { err: String(err instanceof Error ? err.message : err).slice(0, 160) },
      '[omd/design-review] 审核叶失败 (advisory, 不影响收敛)',
    );
    result = { scheduled: true, added: 0, deduped: 0, findings: [], fused: [], tickets: [], escalated: [], usage: { in: 0, out: 0 } };
  }

  return result;
}

/**
 * D-4 升档分类: P0/P1 findings → escalated (需 Sonnet 5 复审); P2 不升档。
 * escalationSeat 缺席 → escalated 恒空 (调用方未配升档座位则无升档可言)。
 */
function classifyEscalation(
  fused: ReviewFinding[],
  tickets: ReviewFinding[],
  escalationSeat: string | undefined,
): ReviewFinding[] {
  if (!escalationSeat) return [];
  const all = [...fused, ...tickets];
  return all.filter((f) => f.severity === 'p0' || f.severity === 'p1');
}

/** D-10 退化路径: 无 agent runner 时基于文件路径生成 findings (diff-only 文本审)。 */
function buildDiffOnlyFindings(files: string[]): ReviewFinding[] {
  return files.map((f) => {
    const evidence = `diff-only 文本审 (D-10): 文件 ${f} 在前端写集中, 无截图命令故仅审文件名/路径。`;
    const fp = fingerprintOf(f, evidence);
    return {
      where: f,
      severity: 'p2' as const,
      evidence,
      suggestion: `人工复查 ${f} 的层级/间距/对比/一致性。`,
      uncertainty: 'diff-only 审无像素级证据, 假阳率高于截图审。',
      fingerprint: fp,
    };
  });
}