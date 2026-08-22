/**
 * harness/poison-rollback —— **毒集重跑时把工作区一起退回去**(A,2026-08-16,#145 评论① 复盘)。
 *
 * ## 它治的那个病(有完整现场)
 *
 * run `1c9a4566`:S9/S11/S12/S14/S15 五个节点第一轮**真写了、真判 done**
 * (`s09_voice.__r1.json` 里 `status:done` + `artifactHashes` 有值)。随后 D-4 毒集生效,
 * `dropPoisonedGreens` 丢掉它们的已绿 checkpoint 强制重跑 —— **但工作区没跟着退回去**。
 *
 * 于是第二轮的 leaf 面对的是「活已经干完」的现场。它只读不写(`read`/`ls`/`wc -l`/`cat`/
 * `tsc --noEmit`/`git status`,一条写命令都没有)—— **这是理性行为,不是偷懒**。
 * 产物闸问的是「**本轮**改了文件吗」(`engine.ts` 的 `after !== declaredHashPre`),
 * 于是五个真交付被判 `empty-artifact`,连带下游因 quorum 不足 skip。
 *
 * **丢 checkpoint 而不动盘 = 让"重跑"这个词名不副实。** 这里补的就是那一半。
 *
 * ## 只撤销**能证明是它写的**那些 —— 五条与门
 *
 * 回滚是破坏性动作,判据必须窄到不可能误伤。`rollback-anchor.ts` 已经把风险讲透了:
 * `dirty-tracked` 那一态「没有回滚对象 —— 这次跑的写与你的改动混在同一片 diff 里,分不开」。
 * 所以本模块**不碰 git 跟踪的文件**,只撤销同时满足下面五条的:
 *
 * 1. 它在**被丢弃的那份 checkpoint** 的 `outputPaths` 里(= 那个节点自己声明写了它);
 * 2. 它**当前内容的 hash,与该 checkpoint 记的 `artifactHashes` 逐字相同**
 *    —— 即盘上这份**就是**那个被否决的产物。变了 = 有别的东西碰过,一律不动;
 * 3. 它在 **HEAD 里不存在**(是这次跑新建的)→ 删。**在 HEAD 里存在**(跟踪文件)→
 *    只有拿到轮基线 commit 才动,且动法是**还原到基线**而不是删(见下一节);
 *    没有基线一律不动 —— 撤销它就可能连你起跑前的未提交改动一起抹掉,那是破坏不是还原;
 * 4. 它**不是任何存活 green 的产物** —— 别毁掉还作数的活;
 * 5. 路径在 repo 根内,且不在 `.omd/` 下(引擎自己的留痕库永远不动)。
 *
 * 三条都写在与门里而不是靠调用方小心,是因为**这类函数的错法是静默的**:删错一个文件,
 * 没有任何测试会红,人也要过很久才发现。
 *
 * ## 跟踪文件那一半:靠**轮基线 commit** 解开(2026-08-21,run 58df6b9e 复盘)
 *
 * 判据 3 原先把「这个节点改了一个既有的、git 跟踪的文件」整个排除在外,理由是
 * 「需要起跑时的逐路径脏文件集才敢动」。run `58df6b9e` 就死在这一半上:9 条声明产物
 * **全部**是跟踪文件 → 全部「没撤」→ 重跑的 leaf 看见实装还在,判「已经做完了」,
 * 一次写工具都没用 → `empty-artifact` → 5 个下游 dep-skip,含最终验收节点。
 *
 * 解开它的不是"更聪明的判据",是**换一个前提**:与其去证明树在起跑时是干净的
 * (run 58df6b9e 是 `resume`,它**不干净**),不如在每轮开跑前**打一个 commit 把它变干净**。
 * 有了这个轮基线,「这条路径自基线以来的改动」就是**本轮自己写的**,按构造成立 ——
 * 于是 `git checkout <基线> -- <路径>` 是原子的、可 `git diff` 的、不可能误伤起跑前的活。
 *
 * 所以本模块出两种动作,**刻意不合并成一个**(语义不同,留证也要分开):
 *   · `remove`  —— 本次跑**新建**的文件,删掉。不需要基线,老行为原样。
 *   · `restore` —— git 跟踪的既有文件,**还原到轮基线**。⚠ 只在 `baseline` 给了才产出;
 *                  没给 = 老行为(跳过并留证),不是"零跟踪文件"。
 *
 * ⚠ 「靠判词告诉 leaf 别把它当基线」是 **prompt 级缓解,按不住**(本仓 F4 已有四个实例)——
 * 留着这句是因为它仍然是**没有基线时**的唯一处境,别把它读成"这半在哪都解决了"。
 */
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { logger } from '../logger';

/** 一条待撤销的路径 + 为什么它过了与门。 */
export interface PoisonRollbackAction {
  path: string;
  /** 产它的那个被丢弃节点(留证用:「谁的产物被撤了」)。 */
  node: string;
}

/**
 * 一条待**还原到轮基线**的跟踪文件(2026-08-21)。与 `remove` 分开列而不是加个 `kind` 字段:
 * 两者的失败模式不同(删错 = 丢掉新写的活;还原错 = 覆盖既有代码),日志各印各的才看得出是哪一种。
 */
export interface PoisonRollbackRestore {
  path: string;
  /** 产它的那个被丢弃节点。 */
  node: string;
}

/** 没撤的那些 —— **必须留下来**,否则「没撤」与「没这条路径」在事后长得一样。 */
export interface PoisonRollbackSkip {
  path: string;
  node: string;
  why: string;
}

export interface PoisonRollbackPlan {
  remove: PoisonRollbackAction[];
  /** 跟踪文件 → 还原到轮基线。**无基线时恒空**(= 老行为,那些路径落在 `skipped` 里)。 */
  restore: PoisonRollbackRestore[];
  skipped: PoisonRollbackSkip[];
}

/** 被丢弃 checkpoint 里我们需要的两位(避免把整个 NodeCheckpoint 类型拖进来)。 */
export interface DroppedArtifact {
  node: string;
  outputPaths: readonly string[];
  /** 路径 → 该节点写完时的内容 hash。 */
  artifactHashes: Readonly<Record<string, string>>;
}

export interface PoisonRollbackDeps {
  /** 路径 → 当前盘上内容 hash;不存在/读不到 → `null`。 */
  hashOf: (absPath: string) => string | null;
  /** 这个 repo 相对路径在 HEAD 里有没有。查不了 → 视为**有**(保守,宁可不撤)。 */
  existsInHead: (relPath: string) => boolean;
}

/**
 * 纯判定:被丢弃的产物 → 撤哪些、跳哪些。**零 IO**(全经 deps 注入),便于逐条钉用例。
 *
 * 抽成纯函数与 `classifyRollbackAnchor` 同一理由:这一段的全部价值在于五条与门一条都不许塌,
 * 而塌得最容易的地方是"顺手在调用点补一个 if"。
 */
export function planPoisonRollback(
  dropped: readonly DroppedArtifact[],
  keepPaths: ReadonlySet<string>,
  root: string,
  deps: PoisonRollbackDeps,
  /**
   * **本轮开跑前打的基线 commit**(2026-08-21)。给了 → 跟踪文件可以还原到它;
   * 省略 = 老行为(跟踪文件一律不动)。
   *
   * 给它的人必须能保证一件事:**这棵树自该 commit 以来的改动全是本次跑写的**。
   * 今天唯一满足这条的是"每轮开跑前在隔离 worktree 里 commit 一次"——
   * 不是"隔离树是干净 checkout"(run 58df6b9e 是 resume,它不干净)。
   */
  baseline?: string,
): PoisonRollbackPlan {
  const remove: PoisonRollbackAction[] = [];
  const restore: PoisonRollbackRestore[] = [];
  const skipped: PoisonRollbackSkip[] = [];
  const seen = new Set<string>();
  for (const d of dropped) {
    for (const p of d.outputPaths) {
      if (seen.has(p)) continue;
      seen.add(p);
      const skip = (why: string): void => void skipped.push({ path: p, node: d.node, why });

      // ⑤ 越界 / 引擎留痕库 —— 先判, 后面几条都要先落到一个安全的绝对路径上。
      const abs = isAbsolute(p) ? p : resolve(root, p);
      const rel = relative(root, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        skip('路径在 repo 根之外 — 引擎不撤自己管不着的地方');
        continue;
      }
      if (rel === '.omd' || rel.startsWith(`.omd/`)) {
        skip('`.omd/` 是引擎自己的留痕库 — 永远不动');
        continue;
      }
      // ④ 还有存活节点声明写它 → 撤了就是毁掉还作数的活。
      if (keepPaths.has(p)) {
        skip('还有未被毒的节点声明写这个路径 — 撤它会毁掉仍然作数的产物');
        continue;
      }
      // ② 盘上这份必须**逐字就是**那个被否决的产物。
      //
      // ⚠ 2026-08-21 把 ② 挪到 ③ **前面**。原先 ③ 先判, 于是跟踪文件在"有没有被别人碰过"
      // 这个问题上**从来没被问过** —— 它一律以「git 跟踪」的理由出局。现在两种动作
      // (删 / 还原) 都要先过 ②, 判据面才是同一个。对 `remove` 那条路结论逐字不变
      // (跟踪文件本就出局, 只是理由行文换了一次), 反向自检见 poison-rollback.test。
      const recorded = d.artifactHashes[p];
      if (!recorded) {
        skip('被丢弃的 checkpoint 没记这个路径的 hash — 证不出盘上这份是它写的');
        continue;
      }
      const now = deps.hashOf(abs);
      if (now === null) {
        // 跟踪文件被节点**删掉**的情形也落这里 —— 还原得回来, 但 `artifactHashes` 记不了
        // "删除"这件事, 证不出是谁删的。不猜, 留证交给人 (与整个模块的保守方向一致)。
        skip('盘上已经没有这个文件 — 无需撤');
        continue;
      }
      if (now !== recorded) {
        skip('盘上内容与该节点写完时不同 — 有别的东西碰过, 不猜是谁的');
        continue;
      }
      // ③ git 跟踪 → 有轮基线才敢动, 且动法是**还原**不是删除。
      // 没基线 = 老行为: 撤它可能连起跑前的未提交改动一起抹掉 (见文件头)。
      if (deps.existsInHead(rel)) {
        if (!baseline) {
          skip('这是 git 跟踪的既有文件, 而本轮没有基线 commit — 撤它可能连你起跑前的未提交改动一起抹掉, 交给人裁');
          continue;
        }
        restore.push({ path: p, node: d.node });
        continue;
      }
      remove.push({ path: p, node: d.node });
    }
  }
  return { remove, restore, skipped };
}

/**
 * 把跟踪文件还原到轮基线。注入而不是在本模块直接 spawn git,理由同 `planPoisonRollback` 的零 IO:
 * 这一步是**破坏性**的,要能在测试里逐条钉住"到底对哪些路径动了手"。
 *
 * @returns 失败原因原文;`null` = 成功。**不抛** —— 回滚失败不许把 run 带塌(fail-open),
 *          但失败要留证(调用方负责印)。
 */
export type PoisonRestoreRunner = (baseline: string, relPaths: readonly string[], root: string) => string | null;

/** 默认还原实现:`git checkout <基线> -- <路径…>`。整批一条命令 —— 部分成功部分失败最难事后读。 */
export const defaultPoisonRestore: PoisonRestoreRunner = (baseline, relPaths, root) => {
  try {
    const p = Bun.spawnSync(['git', 'checkout', baseline, '--', ...relPaths], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode === 0) return null;
    return new TextDecoder().decode(p.stderr).trim() || `git checkout 退出码 ${p.exitCode}`;
  } catch (err) {
    return (err as Error).message;
  }
};

/**
 * 执行撤销。**fail-open 且不吞证据**:删不掉不许把 run 带塌,但每一条都留一行
 * (撤了什么 / 还原了什么 / 没撤什么 / 为什么)—— 静默改盘与静默不改盘一样坏。
 */
export function applyPoisonRollback(
  plan: PoisonRollbackPlan,
  root: string,
  /** 还原跟踪文件用。`plan.restore` 非空时必给 —— 缺席则那些路径降级成"没撤"并留证。 */
  o: { baseline?: string; restoreWith?: PoisonRestoreRunner } = {},
): void {
  for (const s of plan.skipped) {
    logger.info({ node: s.node, path: s.path, why: s.why }, '[omd/executor-dag] 毒集回滚: 这条**没撤**');
  }
  if (plan.restore.length) {
    const runner = o.restoreWith ?? defaultPoisonRestore;
    const paths = plan.restore.map((r) => r.path);
    // 缺席 = 闸没接上, **不是**"零跟踪文件"。降级留证, 不静默当成撤过了。
    const err = o.baseline ? runner(o.baseline, paths, root) : '本轮没有基线 commit (还原口未接线)';
    if (err === null) {
      logger.warn(
        { baseline: o.baseline, count: paths.length, nodes: [...new Set(plan.restore.map((r) => r.node))], paths },
        '[omd/executor-dag] 毒集回滚: 跟踪文件**已还原到轮基线** → 重跑时它才真有活干 (A, run 58df6b9e 复盘)',
      );
    } else {
      for (const r of plan.restore) {
        logger.warn(
          { node: r.node, path: r.path, baseline: o.baseline, err },
          '[omd/executor-dag] 毒集回滚: 跟踪文件还原**失败**, 这条没撤 (fail-open; 该节点重跑时仍会看见旧产物)',
        );
      }
    }
  }
  for (const a of plan.remove) {
    const abs = isAbsolute(a.path) ? a.path : resolve(root, a.path);
    try {
      if (existsSync(abs)) rmSync(abs, { force: true });
      logger.warn(
        { node: a.node, path: a.path },
        '[omd/executor-dag] 毒集回滚: 撤销被否决节点新建的产物 → 重跑时它才真有活干 (A, #145 评论①)',
      );
    } catch (err) {
      logger.warn(
        { node: a.node, path: a.path, err: (err as Error).message },
        '[omd/executor-dag] 毒集回滚: 撤销失败 (fail-open; 该节点重跑时可能仍看见旧产物)',
      );
    }
  }
}
