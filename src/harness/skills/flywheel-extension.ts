/**
 * src/harness/skills/flywheel-extension — skill 复利飞轮的**自驱动**接线 (TUI extension)。
 *
 * "自动感知 + 自动产生提议, 人只在 session 空档点 yes/no" (the owner 2026-06-03):
 *   ① route_hit 自动采集: 模型对某 SKILL.md 调 `read` = 该 skill 被认真加载 → touchSkill
 *      (use_count++ + route_hit 事件)。飞轮第一个输入自动喂。
 *      (R6: pi skills.md:67 "agent uses `read` to load full SKILL.md" + pi.on('tool_call') 可观测。
 *       注: 观测 skill 加载可行; 程序化强制 invoke skill 仍不可 → umbrella 仍 prompt-level。)
 *   ② 自动产生治理提议 + 排队 + 空档弹确认: 每个 `agent_end` (回合间, 非回合中) 刷新 curate 提议入队,
 *      逐个弹 `ctx.ui.confirm` yes/no。**绝不打断回合** (agent_end = agent 已停, 用户回合);
 *      **一次一个** (ConfirmationQueue showing 闸); **拒过不再问** (dismissed)。headless (hasUI=false) 跳过。
 *      apply 走 curate (DEDUP/PRUNE, core/rare 豁免, 可 restore) —— 机器测量+提议自动, 人确认才动手。
 *   ③ session_start: optimize 类**不可自动 apply** 的建议作 advisory notify (信息, 不入 yes/no 队)。
 *
 * 全程只碰 skills substrate (R6/SK-INV-11)。失败软降级 (try/catch + debug log), 不阻断 agent。
 */
import { type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { SkillRegistry } from './registry';
import { skillId } from './scanner';
import { isCoreSkill } from './bundle';
import { suggestActions, type SkillAction } from './action-driver';
import { curateSkills } from './skill-curator-adapter';
import { curateGenes } from './gene-curator-adapter';
import { ConfirmationQueue } from './confirmation-queue';
import { enqueueProposals, enqueuePromotions, type SkillCandidate } from './skill-proposer';
import { logger } from '../../logger';

/** SKILL.md 路径 → skill 名 (父目录 basename)。`/x/skills/commit/SKILL.md` → `commit`。 */
const SKILL_MD_RE = /(?:^|\/)([^/]+)\/SKILL\.md$/i;
export function skillNameFromReadPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const m = path.match(SKILL_MD_RE);
  return m ? m[1]! : null;
}

/** session_start advisory 文案 (只 optimize/add-eval — 不可自动 apply, 故只提示不入确认队)。空→''。 */
export function summarizeSuggestions(actions: SkillAction[], max = 4): string {
  const advisory = actions.filter((a) => a.kind === 'optimize' || a.kind === 'add-eval');
  if (advisory.length === 0) return '';
  const head = advisory.slice(0, max).map((a) => `[${a.kind}] ${a.skill}`).join(' · ');
  const more = advisory.length > max ? ` …+${advisory.length - max}` : '';
  return `⚠ ${advisory.length} skill 待优化: ${head}${more} (\`omd skill suggest-actions\` 看详情)`;
}

/** curate dry-run → 若有可清理的 skill, 入确认队 (dedup by 该批 id)。 */
export async function refreshCurateProposal(registry: SkillRegistry, queue: ConfirmationQueue): Promise<void> {
  const dry = await curateSkills(registry, { dryRun: true });
  if (dry.tombstonedIds.length === 0) return;
  const ids = [...dry.tombstonedIds].sort();
  queue.enqueue({
    key: `curate:${ids.join(',')}`,
    title: '清理 skill?',
    message: `${ids.length} 个 skill 可清理 (近义/陈旧; core/rare 已豁免; 可 restore 回退): ${ids.join(', ')}`,
    apply: async () => {
      const applied = await curateSkills(registry, { dryRun: false });
      logger.info({ tombstoned: applied.tombstonedIds }, '[skill-flywheel] curate applied via confirm');
    },
  });
}

/**
 * gene curate dry-run → 若有可清理的 gene, 入确认队 (gene DEDUP/PRUNE, human_approved 豁免, 可 restore)。
 * 解锁前提: staleness created_at-floor 已统一 (2026-06-04) → fresh 迁入 gene 不被误判 stale, 故现可安全自动提议。
 */
export async function refreshGeneCurateProposal(registry: SkillRegistry, queue: ConfirmationQueue): Promise<void> {
  const dry = await curateGenes(registry, { dryRun: true });
  if (dry.tombstonedIds.length === 0) return;
  const ids = [...dry.tombstonedIds].sort();
  queue.enqueue({
    key: `curate-genes:${ids.join(',')}`,
    title: '清理 gene?',
    message: `${ids.length} 个 gene 可清理 (近义/陈旧; human_approved 已豁免; 可 restore 回退): gene_id ${ids.join(', ')}`,
    apply: async () => {
      const applied = await curateGenes(registry, { dryRun: false });
      logger.info({ deprecated: applied.tombstonedIds }, '[skill-flywheel] gene curate applied via confirm');
    },
  });
}

export interface SkillFlywheelOpts {
  registry: SkillRegistry;
  /** session_start 是否 advisory notify optimize 建议 (默认 true)。 */
  surfaceOnStart?: boolean;
  /** 注入确认队 (默认新建; 测试可注入观测)。 */
  queue?: ConfirmationQueue;
  /**
   * Dream proposer 注入点: 产候选新 skill (从 episodic 模式)。每 agent_end 调一次 → 候选排确认队 (起草进
   * quarantine)。**未注入 → 不产候选** (seam dormant, 真 LLM miner 后续接)。SK-INV: 候选必经人工确认。
   */
  proposer?: () => SkillCandidate[];
}

export function createSkillFlywheelExtension(opts: SkillFlywheelOpts): ExtensionFactory {
  const { registry } = opts;
  const surfaceOnStart = opts.surfaceOnStart ?? true;
  const queue = opts.queue ?? new ConfirmationQueue();

  return (pi) => {
    // ① route_hit 自动采集 (观测, 不 block)。
    pi.on('tool_call', (event) => {
      try {
        if (event.toolName === 'read') {
          const name = skillNameFromReadPath(event.input.path);
          if (name) {
            if (!registry.getSkill(name)) {
              registry.upsertSkill({ id: skillId(name), name, tier: isCoreSkill(name) ? 'core' : 'on-demand' });
            }
            registry.touchSkill(name);
          }
        }
      } catch (e) {
        logger.debug({ e: String(e) }, '[skill-flywheel] route_hit skip');
      }
      return {};
    });

    // ② agent_end (回合间空档): 刷新所有自动提议入队 + 弹一个确认。绝不在回合中; headless 跳过。
    //    提议三源 (全 dedup by key): Dream 提新 skill (proposer) · quarantine 升级 (eval 过) · curate 清理。
    pi.on('agent_end', async (_event, ctx) => {
      try {
        if (!ctx.hasUI) return; // print/RPC 模式无弹窗
        if (opts.proposer) enqueueProposals(registry, queue, opts.proposer());
        enqueuePromotions(registry, queue);
        await refreshCurateProposal(registry, queue);
        await refreshGeneCurateProposal(registry, queue);
        await queue.drainOne((title, message) => ctx.ui.confirm(title, message));
      } catch (e) {
        logger.debug({ e: String(e) }, '[skill-flywheel] confirm skip');
      }
    });

    // ③ session_start: optimize 类 advisory (不可自动 apply → 不入 yes/no 队)。
    if (surfaceOnStart) {
      pi.on('session_start', (_event, ctx) => {
        try {
          const msg = summarizeSuggestions(suggestActions(registry));
          if (msg && ctx.hasUI) ctx.ui.notify(msg, 'info');
        } catch (e) {
          logger.debug({ e: String(e) }, '[skill-flywheel] surface skip');
        }
      });
    }
  };
}
