/**
 * tier-advisory-extension —— 层级升级建议 (fusang advisory 风格: 注入建议, 不强制)。
 *
 * 观察 tool_result 失败流 (与 verify-gate 同款 duck-type: 首块文本含 'Error'), 两条阈值线:
 *   ① 同签名 (tool + input hash) **连续**失败 ≥ threshold (默认 3) —— 同一招反复撞墙;
 *   ② 会话滚动窗 (turn 窗口) 内失败总数 ≥ sessionThreshold (默认 8) —— 整体推进不动。
 * 越线时发一次 ADVISORY (ctx.ui.notify warning + pi.appendEntry 留痕 + 建议文本), 建议里
 * **只列当前真配置了的**升级选项 (env OMD_CONDUCTOR_ESCALATION_MODEL / 贵层多模态池 / redraw):
 *   「连续失败 N 次 — 建议升级层级: ① 换更强 runtime/conductor (OMD_CONDUCTOR_ESCALATION_MODEL=X)
 *     ② /execute --redraw "失败要点" 重画 ③ 媒体任务用 depth:'deep' 走贵层多模态池」
 *
 * advisory-only 铁律: 本扩展**永不 block 任何工具** (对比 verify-gate 的硬闸) —— tool_result
 * 观察本身不可阻断, 且不注册 tool_call 拦截。每次越线只发一次 (同签名成功 → 计数+已发标记复位;
 * turn_end → 会话窗复位), 不刷屏。
 */
import type { ExtensionFactory, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { resolveMultimodalPoolPremium } from '../model/role-models';
import { logger } from '../logger';
import { m } from './i18n';

export interface TierAdvisoryOpts {
  /** 同签名连续失败阈值。默认 3。 */
  threshold?: number;
  /** 会话滚动窗 (turn 窗口) 失败总数阈值。默认 8。 */
  sessionThreshold?: number;
}

/** 注入面: 建议文本只列真配置了的升级项, 配置来源可替身。 */
export interface TierAdvisoryDeps {
  /** 环境变量面 (读 OMD_CONDUCTOR_ESCALATION_MODEL)。默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 贵层多模态池解析。默认 resolveMultimodalPoolPremium。 */
  premiumPool?: () => string[];
}

/** runtime tool_result 真形状 = { toolName, input, content[] }; 错误信号统一读 content 文本 (与 verify-gate 同款)。 */
function firstResultText(event: unknown): string {
  const content = (event as { content?: unknown[] })?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

/** 失败签名: tool + input 结构 hash — 同一招重打同一处才算"连续同签名"。 */
export function failureSignature(toolName: string, input: unknown): string {
  let payload: string;
  try {
    payload = JSON.stringify(input) ?? '';
  } catch {
    payload = String(input);
  }
  return `${toolName}:${createHash('sha1').update(payload).digest('hex').slice(0, 12)}`;
}

const CIRCLED = ['①', '②', '③', '④', '⑤'] as const;

/**
 * 造 tier-advisory 扩展工厂。状态存工厂实例闭包内 (verify-gate 同款), 跨 turn 存活。
 * advisory-only: 只 notify + appendEntry, 永不 block。
 */
export function createTierAdvisoryExtension(
  opts: TierAdvisoryOpts = {},
  deps: TierAdvisoryDeps = {},
): ExtensionFactory {
  const threshold = opts.threshold ?? 3;
  const sessionThreshold = opts.sessionThreshold ?? 8;
  const env = deps.env ?? process.env;
  const premiumPool = deps.premiumPool ?? resolveMultimodalPoolPremium;

  /** 同签名连续失败计数 (成功 → 归零)。 */
  const consecutive = new Map<string, number>();
  /** 已发过 advisory 的签名 (成功复位; 防同一签名越线后每次失败都刷)。 */
  const advisedSignatures = new Set<string>();
  /** 会话滚动窗失败计数 + 已发标记 (turn_end 复位)。 */
  let windowFailures = 0;
  let windowAdvised = false;

  /** 建议文本: 只列真配置了的升级项 (fusang advisory 风格)。 */
  function buildSuggestions(): { text: string; options: string[] } {
    const escalationModel = env.OMD_CONDUCTOR_ESCALATION_MODEL?.trim();
    let premium: string[] = [];
    try {
      premium = premiumPool();
    } catch {
      // 配置读取失败 = 视为未配置, 不炸 advisory
    }
    const options: string[] = [];
    if (escalationModel) {
      options.push(
        m({
          en: `switch to a stronger runtime/conductor (OMD_CONDUCTOR_ESCALATION_MODEL=${escalationModel})`,
          zh: `换更强 runtime/conductor (OMD_CONDUCTOR_ESCALATION_MODEL=${escalationModel})`,
        }),
      );
    }
    options.push(
      m({
        en: '/execute --redraw "failure gist" to redraw the plan',
        zh: '/execute --redraw "失败要点" 重画',
      }),
    );
    if (premium.length > 0) {
      options.push(
        m({
          en: `use depth:'deep' on media tasks to route to the premium multimodal pool (${premium[0]})`,
          zh: `媒体任务用 depth:'deep' 走贵层多模态池 (${premium[0]})`,
        }),
      );
    }
    const text = options.map((o, i) => `${CIRCLED[i] ?? `(${i + 1})`} ${o}`).join(' ');
    return { text, options };
  }

  return (pi) => {
    /** 发一次 advisory: notify + appendEntry 留痕。永不 block。 */
    function emitAdvisory(
      kind: 'consecutive' | 'session',
      detail: { toolName: string; signature?: string; count: number },
      ctx?: ExtensionContext,
    ): void {
      const s = buildSuggestions();
      const head =
        kind === 'consecutive'
          ? m({
              en: `${detail.count} consecutive failures of the same call (${detail.toolName})`,
              zh: `连续失败 ${detail.count} 次 (${detail.toolName} 同签名)`,
            })
          : m({
              en: `${detail.count} tool failures in this window`,
              zh: `本窗口内工具失败累计 ${detail.count} 次`,
            });
      const text = `${head} — ${m({ en: 'consider escalating a tier:', zh: '建议升级层级:' })} ${s.text}`;
      ctx?.ui?.notify?.(text, 'warning');
      pi.appendEntry('tier-advisory', {
        kind,
        toolName: detail.toolName,
        signature: detail.signature,
        count: detail.count,
        threshold: kind === 'consecutive' ? threshold : sessionThreshold,
        suggestions: s.options,
      });
      logger.info(
        { kind, ...detail, options: s.options.length },
        '[omd/tier-advisory] escalation advisory emitted (advisory-only, nothing blocked)',
      );
    }

    pi.on(
      'tool_result',
      (event: { toolName?: string; input?: Record<string, unknown> }, ctx?: ExtensionContext) => {
        const toolName = event?.toolName;
        if (typeof toolName !== 'string' || !toolName) return;
        const sig = failureSignature(toolName, event?.input);
        const failed = firstResultText(event).includes('Error');

        if (!failed) {
          // 同签名成功 → 连续计数 + 已发标记复位 (下一轮撞墙重新计)。
          consecutive.delete(sig);
          advisedSignatures.delete(sig);
          return;
        }

        // ── ① 同签名连续失败线 ──
        const n = (consecutive.get(sig) ?? 0) + 1;
        consecutive.set(sig, n);
        if (n >= threshold && !advisedSignatures.has(sig)) {
          advisedSignatures.add(sig); // 每次越线只发一次, 成功才复位
          emitAdvisory('consecutive', { toolName, signature: sig, count: n }, ctx);
        }

        // ── ② 会话滚动窗总量线 ──
        windowFailures += 1;
        if (windowFailures >= sessionThreshold && !windowAdvised) {
          windowAdvised = true;
          emitAdvisory('session', { toolName, count: windowFailures }, ctx);
        }
      },
    );

    // turn_end = 滚动窗边界: 会话窗计数/已发标记复位 (同签名连续计数跨 turn 存活 — 隔 turn 重打同一处仍算连续)。
    pi.on('turn_end', () => {
      windowFailures = 0;
      windowAdvised = false;
    });
  };
}
