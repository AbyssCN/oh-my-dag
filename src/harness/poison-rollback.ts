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
 * 3. 它在 **HEAD 里不存在**(是这次跑新建的)。跟踪文件一律不动 —— 撤销它就可能连你
 *    起跑前的未提交改动一起抹掉,而那是破坏不是还原;
 * 4. 它**不是任何存活 green 的产物** —— 别毁掉还作数的活;
 * 5. 路径在 repo 根内,且不在 `.omd/` 下(引擎自己的留痕库永远不动)。
 *
 * 三条都写在与门里而不是靠调用方小心,是因为**这类函数的错法是静默的**:删错一个文件,
 * 没有任何测试会红,人也要过很久才发现。
 *
 * ## 跟踪文件那一半刻意不做
 *
 * 判据 3 把「这个节点改了一个既有的、git 跟踪的文件」整个排除在外了 —— 那一半今天**不撤销**,
 * 只响亮留证并把事实写进重跑的判词。这是有意的取舍:安全的那半立刻能救回 run 1c9a4566 那类
 * (新建文件),不安全的那半需要起跑时的逐路径脏文件集才敢动,那是另一片的活。
 * ⚠ 「靠判词告诉 leaf 别把它当基线」是 **prompt 级缓解,按不住**(本仓 F4 已有四个实例)——
 * 写在这里是为了别把它读成"这半也解决了"。
 */
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { logger } from './logger';

/** 一条待撤销的路径 + 为什么它过了与门。 */
export interface PoisonRollbackAction {
  path: string;
  /** 产它的那个被丢弃节点(留证用:「谁的产物被撤了」)。 */
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
): PoisonRollbackPlan {
  const remove: PoisonRollbackAction[] = [];
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
      // ③ git 跟踪 → 不动 (撤它可能连起跑前的未提交改动一起抹掉, 见文件头)。
      if (deps.existsInHead(rel)) {
        skip('这是 git 跟踪的既有文件 — 撤它可能连你起跑前的未提交改动一起抹掉, 交给人裁');
        continue;
      }
      // ② 盘上这份必须**逐字就是**那个被否决的产物。
      const recorded = d.artifactHashes[p];
      if (!recorded) {
        skip('被丢弃的 checkpoint 没记这个路径的 hash — 证不出盘上这份是它写的');
        continue;
      }
      const now = deps.hashOf(abs);
      if (now === null) {
        skip('盘上已经没有这个文件 — 无需撤');
        continue;
      }
      if (now !== recorded) {
        skip('盘上内容与该节点写完时不同 — 有别的东西碰过, 不猜是谁的');
        continue;
      }
      remove.push({ path: p, node: d.node });
    }
  }
  return { remove, skipped };
}

/**
 * 执行撤销。**fail-open 且不吞证据**:删不掉不许把 run 带塌,但每一条都留一行
 * (撤了什么 / 没撤什么 / 为什么)—— 静默改盘与静默不改盘一样坏。
 */
export function applyPoisonRollback(plan: PoisonRollbackPlan, root: string): void {
  for (const s of plan.skipped) {
    logger.info({ node: s.node, path: s.path, why: s.why }, '[omd/executor-dag] 毒集回滚: 这条**没撤**');
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
