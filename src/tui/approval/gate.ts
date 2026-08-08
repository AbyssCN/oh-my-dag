/**
 * src/tui/approval/gate —— **审批闸本体**(切片①):把审批包在工具外面,而不是写进 prompt。
 *
 * ## 白名单闸放第一层(v5:防死循环)
 *
 * 带有效 token 的调用**直接放行、跳过后续所有闸** —— 否则「批准 10 分钟」的那个批准
 * 自己会在下一次同类调用上再弹一次,循环不止。token 的形状:
 *
 * - `y`(批准这一次)= **用完即焚**,不留 token —— 下一次同类操作重新审批;
 * - `a`(批准一段时间)= 按**档位**发 token,TTL 默认 600s(config 可调),过期重新审批;
 * - **admin 档永远没有 token**(v5:「强制审批,不管多有把握」)——
 *   UI 不给 `a` 选项(`canGrant: false`),gate 这边收到 `grant` 也**防御性降级成 `once`**。
 *
 * ## fail-closed 的两处
 *
 * - 没有 ask handler(UI 没接 / 对话框被占)→ **拒绝**,不是放行;
 * - 分类器异常 → admin 档(见 policy.ts)。
 *
 * ## trace(v5:`approval_required → approval_resolved`)
 *
 * 两个事件都走 logger(TUI 日志已改道文件,那就是审计面)+ 可注入的 `onTrace`(测试的观测口)。
 * fail-open 可以吞异常,不许吞证据:每一次弹单与每一个裁决都在日志里看得见。
 */
import { logger } from '../../logger';
import type { AnyOmdTool } from '../../harness/agent-tools';
import {
  type ApprovalPolicyConfig,
  type ApprovalTier,
  DEFAULT_APPROVAL_CONFIG,
  classifyToolCall,
  describeToolCall,
} from './policy';

/** UI 收到的一张审批单。 */
export interface ApprovalRequest {
  tool: string;
  tier: ApprovalTier;
  /** 触发原因(双级命中就是两条 —— 合并成一张单)。 */
  reasons: string[];
  target: string | null;
  summary: string;
  /** `d 看详情` 的正文(diff / 内容 / 命令全文)。 */
  preview: string[];
  /** `a`(批准一段时间)可不可用 —— admin 档恒 false。 */
  canGrant: boolean;
  /** token TTL 秒(卡片上「批准 N 分钟」那半句用)。 */
  ttlSec: number;
}

export type ApprovalDecision = 'deny' | 'once' | 'grant';
export type ApprovalAskHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ApprovalTraceEvent {
  phase: 'approval_required' | 'approval_resolved' | 'approval_token_pass';
  tool: string;
  tier: ApprovalTier;
  decision?: ApprovalDecision;
}

export interface ApprovalGateOpts {
  /** 完整 config(loadApprovalConfig 的产物)。省略 = 默认表。 */
  config?: ApprovalPolicyConfig;
  /** 时钟注入 —— token TTL 的判定要可测。 */
  now?: () => number;
  /** 测试/审计的观测口。 */
  onTrace?: (e: ApprovalTraceEvent) => void;
}

export interface ApprovalGate {
  /** UI 接线口。`null` = 摘掉(之后所有需审批的调用 fail-closed 拒绝)。 */
  setAsk(h: ApprovalAskHandler | null): void;
  /** 把审批包到一批工具外面。`read` 档直通,零开销。 */
  wrap(tools: AnyOmdTool[]): AnyOmdTool[];
}

export function createApprovalGate(opts: ApprovalGateOpts = {}): ApprovalGate {
  const cfg = opts.config ?? DEFAULT_APPROVAL_CONFIG;
  const now = opts.now ?? Date.now;
  /** 档位 → token 过期时刻。admin 永远不进这张表。 */
  const tokens = new Map<ApprovalTier, number>();
  let ask: ApprovalAskHandler | null = null;
  /** 审批单**串行弹** —— 两张单同时占输入区,「哪个在收键」就说不清了。 */
  let chain: Promise<unknown> = Promise.resolve();

  const trace = (e: ApprovalTraceEvent): void => {
    logger.info({ tool: e.tool, tier: e.tier, ...(e.decision ? { decision: e.decision } : {}) }, `[omd/approval] ${e.phase}`);
    try {
      opts.onTrace?.(e);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[omd/approval] onTrace 回调抛错 (已吞, 不打断审批)');
    }
  };

  const askSerial = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const run = async (): Promise<ApprovalDecision> => {
      if (!ask) return 'deny'; // fail-closed: 没有审批通道 = 拒绝, 不是放行
      return ask(req);
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };

  return {
    setAsk(h) {
      ask = h;
    },
    wrap(tools) {
      return tools.map((tool) => ({
        ...tool,
        async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: import('@earendil-works/pi-agent-core').AgentToolUpdateCallback) {
          const { tier, reasons, target } = classifyToolCall(tool.name, params, cfg);
          // read 档直接放行 —— G-1: read 全程不弹框。
          if (tier === 'read') return tool.execute(toolCallId, params as never, signal, onUpdate);
          // 白名单闸放第一层: 带有效 token 直接放行, 跳过后续所有闸 (admin 永远不在表里)。
          const exp = tokens.get(tier);
          if (tier !== 'admin' && exp !== undefined && now() < exp) {
            trace({ phase: 'approval_token_pass', tool: tool.name, tier });
            return tool.execute(toolCallId, params as never, signal, onUpdate);
          }
          const { summary, preview } = describeToolCall(tool.name, params);
          const req: ApprovalRequest = {
            tool: tool.name,
            tier,
            reasons,
            target,
            summary,
            preview,
            canGrant: tier !== 'admin',
            ttlSec: cfg.tokenTtlSec,
          };
          trace({ phase: 'approval_required', tool: tool.name, tier });
          let decision = await askSerial(req);
          // admin 收到 grant 防御性降级 —— UI 不该发得出来, 发出来也不能变出一个 admin token。
          if (decision === 'grant' && tier === 'admin') decision = 'once';
          trace({ phase: 'approval_resolved', tool: tool.name, tier, decision });
          if (decision === 'deny') {
            // 抛错让模型看见"被拒", 而不是拿到一个空结果以为成功了。
            throw new Error(`[approval] 用户拒绝: ${summary}${ask ? '' : ' (无审批通道, fail-closed)'}`);
          }
          if (decision === 'grant') tokens.set(tier, now() + cfg.tokenTtlSec * 1000);
          return tool.execute(toolCallId, params as never, signal, onUpdate);
        },
      }));
    },
  };
}
