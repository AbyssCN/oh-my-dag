/**
 * src/wright/skills/umbrella — prompt-level 长尾路由伞 (Phase 1 step 3)。
 *
 * **R6 ②**: pi 闭源, 不暴露 skill-invocation hook → umbrella **不能**是 code 拦截器。它是一段
 * **prompt 文本**: DMI 把长尾 skill 移出 prompt 省 token, 但留一条 umbrella 条目在 prompt 里告诉
 * 模型「这些隐藏能力存在 + 怎么够到」。模型读 umbrella → 自己决定 `/<name>` 唤起 (DMI 只挡自动列举,
 * `/skill:` 显式调用仍可达, lark Phase 1 已证)。
 *
 * 产物 = 一个 umbrella SKILL.md 的 body 文本 (该 umbrella 自身保持可见/进 prompt)。把它写进
 * skills/<umbrella-name>/SKILL.md 即生效, 纯 prompt 层, 零 pi 改动。
 */
import { SkillRegistry, type SkillRow } from './registry';

export interface UmbrellaOptions {
  /** umbrella 标题 (默认通用)。 */
  title?: string;
  /** 只收 description 前 N 字 (省 token, 默认 120)。 */
  descClip?: number;
}

/** 一行路由条目: `- /<name> — <desc 截断>`。 */
function umbrellaLine(s: SkillRow, clip: number): string {
  const desc = (s.description || '').replace(/\s+/g, ' ').trim();
  const clipped = desc.length > clip ? desc.slice(0, clip - 1).trimEnd() + '…' : desc;
  return `- \`/${s.name}\`${clipped ? ` — ${clipped}` : ''}`;
}

/**
 * 从 registry 当前态生成 umbrella body。收 **DMI 隐藏** (dmi=1) 的 active skill —— 正是被移出
 * prompt、需要伞来"重新可发现"的那批。core (dmi=0) 不收 (它们本就在 prompt)。
 */
export function buildUmbrella(registry: SkillRegistry, opts: UmbrellaOptions = {}): string {
  const clip = opts.descClip ?? 120;
  const title = opts.title ?? 'Hidden skills router (DMI umbrella)';
  // visibleOnly:true 给 dmi=0; 我们要反面 (dmi=1)。直接查。
  const hidden = registry.db
    .query(`SELECT * FROM skills WHERE status='active' AND dmi=1 ORDER BY name`)
    .all() as SkillRow[];

  const header =
    `# ${title}\n\n` +
    `以下技能为省 prompt token 已从自动列举中移除 (disable-model-invocation)。\n` +
    `它们依旧可用 —— 当任务匹配下方某条描述时, 用 \`/<name>\` 显式唤起。\n`;

  if (hidden.length === 0) {
    return header + `\n_(当前无隐藏技能。)_\n`;
  }
  return header + `\n${hidden.map((s) => umbrellaLine(s, clip)).join('\n')}\n`;
}
