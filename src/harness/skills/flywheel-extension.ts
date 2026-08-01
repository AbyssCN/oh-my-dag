/**
 * src/harness/skills/flywheel-extension — skill 使用度自动采集 (TUI extension)。
 *
 * ① route_hit 自动采集: 模型对某 SKILL.md 调 `read` = 该 skill 被认真加载 → touchSkill
 *    (use_count++ + route_hit 事件)。substrate 的唯一自动输入。
 *    (R6: pi skills.md:67 "agent uses `read` to load full SKILL.md" + pi.on('tool_call') 可观测。
 *     注: 观测 skill 加载可行; 程序化强制 invoke skill 仍不可 → umbrella 仍 prompt-level。)
 *
 * ⚠ 本文件原本还驱动两件事, 已随自进化子系统一并停用 (ADR-0002,
 *   docs/adr/0002-self-evolution-parked.md):
 *   ② agent_end 自动治理提议 + 确认队 (curate skills / curate genes / dream proposer 候选 skill)
 *   ③ session_start 的 optimize advisory (action-driver)
 *   它们的实现全在 experimental/self-evolution/{skill-mining,curator}/ —— 信号源同是 pi 的
 *   per-turn hook, 纯 MCP 用法下一次都没跑过。此处**不再注册**这两条, 只留 ① 这条今天真在跑的。
 *
 * 只碰 skills substrate (R6/SK-INV-11)。失败软降级 (try/catch + debug log), 不阻断 agent。
 */
import { type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { SkillRegistry } from './registry';
import { skillId } from './scanner';
import { isCoreSkill } from './bundle';
import { logger } from '../../logger';

/** SKILL.md 路径 → skill 名 (父目录 basename)。`/x/skills/commit/SKILL.md` → `commit`。 */
const SKILL_MD_RE = /(?:^|\/)([^/]+)\/SKILL\.md$/i;
export function skillNameFromReadPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const m = path.match(SKILL_MD_RE);
  return m ? m[1]! : null;
}

export interface SkillFlywheelOpts {
  registry: SkillRegistry;
}

export function createSkillFlywheelExtension(opts: SkillFlywheelOpts): ExtensionFactory {
  const { registry } = opts;

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
  };
}
