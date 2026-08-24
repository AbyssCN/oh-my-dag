/**
 * command-policy —— **黑名单 + 白名单**(2026-08-13,owner 裁:TUI 默认 yolo)。
 *
 * ## 这一层是"删掉审批"之后剩下的那一层
 *
 * 四档审批(`tui/approval/*`,2026-08-13 删)判错的地方在于:它把**未登记**当成
 * **需要人看一眼**。而 `COMMAND_RISK_TIER` 只登记了 25 个 bin,于是 `which omd` 都要弹框
 * (owner 截图实测:一轮 6 条工具调用全部停在等人按键上,24s 里绝大部分不是模型在想)。
 *
 * 新的分野只有两档,与 `command-risk-tier.test.ts` 早就记下的那条读数一致 ——
 * 「omd 只有『随便做』和『一律不许』两档」:
 *
 * | 档 | 判据 | 处置 |
 * |---|---|---|
 * | 允许 | 不在黑名单里,**或**命中白名单 | 直接跑(在 bwrap 围栏里) |
 * | 拒绝 | 命中黑名单且未被白名单赦免 | 抛错,模型看得见理由 |
 *
 * ## 白名单是**赦免**不是"提前放行"
 *
 * 默认全放行,所以"提前放行"没有意义。白名单存在的唯一理由是**黑名单误报**:
 * `git reset --hard` 在一棵一次性 worktree 上是日常操作,而黑名单不认识"一次性"。
 * 于是它写成正则、逐仓配、命中即赦免。**顺序是白后黑**(白名单赢),否则它不解决任何问题。
 *
 * ## 围栏与黑名单是两层,不是一层的两种写法
 *
 * bwrap 挡的是**越界**(工作根之外只读);黑名单挡的是**工作根之内的不可逆**
 * (`rm -rf .`、`DROP TABLE`、`git push --force` —— 前两个在围栏里照样成立,
 * 第三个根本不碰文件系统)。少任何一层都有一整族它单独盖不住的事故。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { omdConfigPath } from '../../config/config-discovery';
import { logger } from '../../logger';
import { DANGEROUS_PATTERNS, type CommandVerdict, type DangerousPattern } from './dangerous-cmd';

export interface CommandPolicy {
  /** 赦免表(`tui.sandbox.allow`)。命中任一条 → 跳过黑名单。默认空。 */
  allow: readonly RegExp[];
  /** 黑名单 = 内置 {@link DANGEROUS_PATTERNS} + `tui.sandbox.deny` 追加的逐仓条目。 */
  deny: readonly DangerousPattern[];
}

/** 沙箱段的全部可配项(`.omd/config.json` 的 `tui.sandbox`)。 */
export interface SandboxConfig extends CommandPolicy {
  /** bwrap 围栏开不开。默认 `true`。`false` = 显式裸跑(黑名单仍在)。 */
  enabled: boolean;
  /** 工作根之外的额外可写路径(逃生口)。默认空 —— owner 裁的边界是 `cwd + /tmp`。 */
  writable: readonly string[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  writable: [],
  allow: [],
  deny: DANGEROUS_PATTERNS,
};

/** 编一条 config 来的正则。编不动 → 记一行并丢掉这一条(不是丢掉整段)。 */
function compile(src: unknown, where: string): RegExp | null {
  if (typeof src !== 'string' || !src) return null;
  try {
    return new RegExp(src, 'i');
  } catch (err) {
    logger.warn({ pattern: src, where, err: (err as Error).message }, '[omd/sandbox] 正则编不动 → 丢掉这一条');
    return null;
  }
}

/**
 * 读 `.omd/config.json` 的 `tui.sandbox` 段。
 *
 * ```jsonc
 * { "tui": { "sandbox": {
 *     "enabled": true,
 *     "writable": ["/home/dev/.claude"],   // 工作根之外还能写哪
 *     "allow":    ["^git reset --hard$"],   // 赦免:黑名单误报的逃生口
 *     "deny":     ["\\bterraform\\s+destroy\\b"]  // 逐仓追加的不可逆命令
 * } } }
 * ```
 *
 * 坏 JSON / 坏条目**静默跳过**(fail-open:配置写错不该让 TUI 起不来),
 * 但内置黑名单永远在 —— config 只能**追加** deny,删不掉它。
 */
export function loadSandboxConfig(cwd: string, env: Record<string, string | undefined> = process.env): SandboxConfig {
  const rel = omdConfigPath(env);
  const path = isAbsolute(rel) ? rel : join(cwd, rel);
  if (!existsSync(path)) return DEFAULT_SANDBOX_CONFIG;
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return DEFAULT_SANDBOX_CONFIG; // 坏 JSON: 别的消费者(座位)自会响亮报
  }
  const s = (root.tui as Record<string, unknown> | undefined)?.sandbox as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return DEFAULT_SANDBOX_CONFIG;
  const allow = (Array.isArray(s.allow) ? s.allow : []).map((p) => compile(p, 'allow')).filter((r): r is RegExp => r !== null);
  const extraDeny = (Array.isArray(s.deny) ? s.deny : [])
    .map((p, i) => {
      const re = compile(p, 'deny');
      return re ? { label: `config-deny-${i}`, reason: `matches tui.sandbox.deny[${i}] (${String(p)})`, re } : null;
    })
    .filter((d): d is DangerousPattern => d !== null);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
    writable: (Array.isArray(s.writable) ? s.writable : []).filter((p): p is string => typeof p === 'string' && isAbsolute(p)),
    allow,
    // 内置在前:同一条命令同时中两边时报的是内置那条的 label(可读性 > 排序洁癖)。
    deny: [...DANGEROUS_PATTERNS, ...extraDeny],
  };
}

/**
 * 判一条命令。**白名单先判** —— 它赢,否则赦免不解决任何问题。
 *
 * 分类器本身不抛(纯正则),但调用方仍按 fail-closed 兜:见 `agent-tools.ts` 的 catch。
 */
export function judgeCommand(command: string | undefined | null, policy: CommandPolicy = DEFAULT_SANDBOX_CONFIG): CommandVerdict {
  if (!command || typeof command !== 'string') return { dangerous: false };
  for (const re of policy.allow) {
    if (re.test(command)) {
      logger.info({ command, pattern: re.source }, '[omd/sandbox] 白名单赦免 (跳过黑名单)');
      return { dangerous: false };
    }
  }
  for (const p of policy.deny) {
    if (p.re.test(command)) return { dangerous: true, label: p.label, reason: p.reason };
  }
  return { dangerous: false };
}
