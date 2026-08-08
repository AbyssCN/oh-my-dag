/**
 * src/tui/approval/policy —— **审批层的分类判据**(切片①,v5 设计稿第六节)。纯函数,零 IO(除 loadApprovalConfig)。
 *
 * ## 四档
 *
 * | 档 | 处置 |
 * |---|---|
 * | `read` | 直接放行,**全程不弹框**(G-1 的判据之一) |
 * | `read_sensitive` | 凭证文件那一档 —— 2026-08-07 去掉的那道硬拒的正确形态:要继续得审批 |
 * | `write` | 暂停等审批(write / edit / omd_run 这类有后果的动作) |
 * | `admin` | 强制审批,**token 不覆盖**(bash 不可逆子集 · force push 一族) |
 *
 * ## 判据都从既有登记表来,不再造第二份
 *
 * - bash 的档位跟 `commandRiskTier`(command-leaf 的风险登记表)+ `classifyCommand`
 *   (dangerous-cmd 的不可逆模式表)走;
 * - 凭证文件跟 `secretBasenameOf` / `secretPathInCommand`(SECRET_BASENAMES 那张表)走。
 *   同一个判据散成两份必然漂移 —— 漂掉的那份就是下一个 `cat .env`。
 *
 * ## 四档配在 config,不硬编码(v5 明确要求)
 *
 * 工具→档位的登记表有默认值(DEFAULT_APPROVAL_CONFIG),`.omd/config.json` 的
 * `tui.approvals` 段能逐条覆盖。**未登记的工具默认 `write`**(fail-closed 方向:
 * 一个没人登记过的新工具宁可多问一次,不可静默放行)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { secretBasenameOf } from '../../harness/agent-tools';
import { commandRiskTier, secretPathInCommand } from '../../harness/command-leaf';
import { classifyCommand } from '../../harness/hooks/dangerous-cmd';
import { omdConfigPath } from '../../config/config-discovery';

export type ApprovalTier = 'read' | 'read_sensitive' | 'write' | 'admin';

/** 由轻到重 —— 多条判据同时命中时取最重的一档。 */
export const APPROVAL_TIER_ORDER: Readonly<Record<ApprovalTier, number>> = {
  read: 0,
  read_sensitive: 1,
  write: 2,
  admin: 3,
};

const TIER_VALUES = new Set<string>(Object.keys(APPROVAL_TIER_ORDER));

export interface ApprovalPolicyConfig {
  /** 工具名 → 基础档。未登记 = `write`(fail-closed)。bash 例外:按命令内容动态升降。 */
  tiers: Record<string, ApprovalTier>;
  /**
   * 受保护清单(路径前缀或精确文件)。write/admin 档的目标命中时**追加一条触发原因**,
   * 与 function 级判据**合并成一张单**(v5:「两级合并成一张单」)。
   */
  protectedPaths: string[];
  /** `a`(批准一段时间)的 token TTL 秒。默认 600(v5:TTL 600s)。 */
  tokenTtlSec: number;
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalPolicyConfig = {
  tiers: {
    // 读半区:约占一半的调用,不出审批 —— 这是「加审批不会变慢」的前提。
    read: 'read',
    ls: 'read',
    grep: 'read',
    skill: 'read',
    omd_status: 'read',
    omd_runs: 'read',
    omd_node_output: 'read',
    omd_map_tickets: 'read',
    omd_plans: 'read',
    omd_recall: 'read',
    // 写半区。omd_run / omd_solve 会派整张图出去真改文件,与 write 同档(v5 表)。
    write: 'write',
    edit: 'write',
    omd_run: 'write',
    omd_solve: 'write',
    omd_cancel: 'write',
    // bash 基础档 write;实际按命令内容分:read_only 命令降 read,不可逆升 admin。
    bash: 'write',
  },
  protectedPaths: [],
  tokenTtlSec: 600,
};

/**
 * 读 `.omd/config.json` 的 `tui.approvals` 段并与默认值合并。
 * 坏条目静默跳过(fail-open:配置写错不该让 TUI 起不来),但**只会收紧或平移,不会放松出四档之外**
 * (档位值不在四档里的覆盖被丢弃)。
 */
export function loadApprovalConfig(cwd: string, env: Record<string, string | undefined> = process.env): ApprovalPolicyConfig {
  const rel = omdConfigPath(env);
  const path = isAbsolute(rel) ? rel : join(cwd, rel);
  const merged: ApprovalPolicyConfig = {
    tiers: { ...DEFAULT_APPROVAL_CONFIG.tiers },
    protectedPaths: [...DEFAULT_APPROVAL_CONFIG.protectedPaths],
    tokenTtlSec: DEFAULT_APPROVAL_CONFIG.tokenTtlSec,
  };
  if (!existsSync(path)) return merged;
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return merged; // 坏 JSON:别的消费者(座位)自会响亮报;审批层用默认值继续
  }
  const tui = root.tui as Record<string, unknown> | undefined;
  const a = tui?.approvals as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return merged;
  if (a.tiers && typeof a.tiers === 'object') {
    for (const [tool, tier] of Object.entries(a.tiers as Record<string, unknown>)) {
      if (typeof tier === 'string' && TIER_VALUES.has(tier)) merged.tiers[tool] = tier as ApprovalTier;
    }
  }
  if (Array.isArray(a.protectedPaths)) {
    merged.protectedPaths = (a.protectedPaths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  if (typeof a.tokenTtlSec === 'number' && a.tokenTtlSec > 0) merged.tokenTtlSec = a.tokenTtlSec;
  return merged;
}

export interface ApprovalClassification {
  tier: ApprovalTier;
  /** 触发原因,按命中顺序;双级同时命中就是两条(合并成一张单)。`read` 档恒为空。 */
  reasons: string[];
  /** 目标(文件路径或命令串),卡片「要做什么」那一格用。 */
  target: string | null;
}

const maxTier = (a: ApprovalTier, b: ApprovalTier): ApprovalTier =>
  APPROVAL_TIER_ORDER[b] > APPROVAL_TIER_ORDER[a] ? b : a;

/** 受保护清单命中:精确文件,或目录前缀(`docs/plan/` 或 `docs/plan` 都盖住整个目录)。 */
export function protectedPathHit(target: string, list: readonly string[]): string | null {
  const t = target.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const e of list) {
    const p = e.replace(/\\/g, '/').replace(/^\.\//, '');
    if (t === p || t.startsWith(p.endsWith('/') ? p : `${p}/`)) return e;
  }
  return null;
}

/**
 * 一次工具调用 → 档位 + 触发原因。**纯函数**,config 注入。
 */
export function classifyToolCall(name: string, params: unknown, cfg: ApprovalPolicyConfig): ApprovalClassification {
  const p = (params ?? {}) as Record<string, unknown>;
  // codegraph_* 一族是只读符号查询, 逐个登记会漏新成员 → 前缀归 read;其余未登记 = write(fail-closed)。
  let tier: ApprovalTier = cfg.tiers[name] ?? (name.startsWith('codegraph') ? 'read' : 'write');
  const reasons: string[] = [];
  let target: string | null = typeof p.path === 'string' ? p.path : null;

  if (name === 'bash' && typeof p.command === 'string') {
    target = p.command;
    // ① 不可逆子集 → admin(强制审批,token 不覆盖)。分类器异常也按 admin —— fail-closed
    //    契约不能因为异常变 fail-open(与 agent-tools 内层闸同一条纪律)。
    let dangerous: ReturnType<typeof classifyCommand>;
    try {
      dangerous = classifyCommand(p.command);
    } catch {
      dangerous = { dangerous: true, label: 'classifier-error', reason: '命令分类器异常 (fail-closed)' };
    }
    if (dangerous.dangerous) {
      tier = 'admin';
      reasons.push(`不可逆命令 [${dangerous.label}]: ${dangerous.reason}`);
    } else {
      // ② 风险登记表:read_only 命令(cat/grep/git log …)降到 read —— 不弹框;
      //    其余(scoped_write / 未登记)按 write 走审批。
      const risk = commandRiskTier(p.command);
      if (risk === 'read_only') tier = 'read';
      else {
        tier = maxTier(tier, 'write');
        reasons.push(`bash 命令风险级 ${risk}`);
      }
    }
    // ③ 命令碰凭证文件 → 至少 read_sensitive(按分隔符拆段逐段查,`ls && cat .env` 的尾环也要被看见)。
    for (const seg of p.command.split(/[;&|]+|\n/)) {
      const s = seg.trim();
      if (!s) continue;
      const secret = secretPathInCommand(s);
      if (secret) {
        tier = maxTier(tier, 'read_sensitive');
        reasons.push(`命令读凭证文件 ${secret}`);
        break;
      }
    }
  }

  // 读类工具指向凭证文件 → read_sensitive(先给预览、继续需审批 —— 那道硬拒的正确形态)。
  if ((name === 'read' || name === 'grep' || name === 'ls') && typeof p.path === 'string' && secretBasenameOf(p.path)) {
    tier = maxTier(tier, 'read_sensitive');
    reasons.push(`目标是凭证文件 ${p.path}`);
  }

  // function 级基础原因放最前(排卡片时它是第一行判据)。
  if (APPROVAL_TIER_ORDER[tier] >= APPROVAL_TIER_ORDER.write && reasons.length === 0) {
    reasons.unshift(`function 级 ${tier}`);
  }

  // 受保护清单:双级同时命中 → 追加一条,**合并成一张单**(不弹两次)。
  if (APPROVAL_TIER_ORDER[tier] >= APPROVAL_TIER_ORDER.write && target) {
    const hit = protectedPathHit(target, cfg.protectedPaths);
    if (hit) reasons.push(`目标在受保护清单 (${hit})`);
  }

  if (tier === 'read_sensitive' && reasons.length === 0) reasons.push('read_sensitive');
  return { tier, reasons, target };
}

/** 卡片「要做什么」一行 + `d 看详情` 的正文。纯函数,不碰盘。 */
export function describeToolCall(name: string, params: unknown): { summary: string; preview: string[] } {
  const p = (params ?? {}) as Record<string, unknown>;
  const cap = (lines: string[], n: number): string[] =>
    lines.length > n ? [...lines.slice(0, n), `… 还有 ${lines.length - n} 行`] : lines;
  if (name === 'write' && typeof p.path === 'string') {
    const content = typeof p.content === 'string' ? p.content : '';
    return {
      summary: `write ${p.path} (${content.length} 字节)`,
      preview: cap(content.split('\n'), 30),
    };
  }
  if (name === 'edit' && typeof p.path === 'string') {
    const oldLines = typeof p.oldText === 'string' ? p.oldText.split('\n') : [];
    const newLines = typeof p.newText === 'string' ? p.newText.split('\n') : [];
    return {
      summary: `edit ${p.path} (-${oldLines.length} +${newLines.length} 行)`,
      preview: cap([...oldLines.map((l) => `- ${l}`), ...newLines.map((l) => `+ ${l}`)], 40),
    };
  }
  if (name === 'bash' && typeof p.command === 'string') {
    const first = p.command.split('\n')[0] ?? '';
    return {
      summary: `bash: ${first.length > 120 ? `${first.slice(0, 120)}…` : first}`,
      preview: cap(p.command.split('\n'), 30),
    };
  }
  let args = '';
  try {
    args = JSON.stringify(params ?? {});
  } catch {
    args = '(参数序列化失败)';
  }
  if (args.length > 120) args = `${args.slice(0, 120)}…`;
  return { summary: `${name} ${args}`, preview: cap(JSON.stringify(params ?? {}, null, 2).split('\n'), 30) };
}
