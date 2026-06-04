/**
 * src/wright/sec-audit —— 多 lens 并行安全审计能力: conductor 拆 → 并行 specialist lens 审查 → 综合报告。
 *
 * 借鉴 piolium 审计方法论: 一管给 conductor, 它把审计目标拆成多个并行的 specialist lens 节点
 * (每个带工具 agent leaf, 能读目标文件审查), 最后 synth 叶综合成结构化安全报告。
 * 比单 agent 顺序审又快又全 (DeepSeek 并行)。
 */
import { runExecutorDag, type ExecutorDagConfig } from './executor-dag';
import { createAgentLeafRunner } from './agent-leaf';
import type { ExecutorDagResult } from './executor-dag';
import type { VerificationConfig } from './verifier';
import type { LeafModelRouter } from './model-router';

export interface SecAuditOpts {
  /** conductor 模型 'provider:modelId'。必填, 无硬默认。 */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (综合报告用)。必填, 无硬默认。 */
  leafModel: string;
  /** agent leaf 模型 (带工具审查文件)。省略 = leafModel。建议 deepseek:deepseek-v4-flash。 */
  agentLeafModel?: string;
  /** 审计目标的工作根。默认 process.cwd()。 */
  cwd?: string;
  /** 内层 fan-out 并发上限。省略 → primitives 兜底。 */
  maxFanout?: number;
  /** 运行完成钩子 (留痕层接口)。透传给 executor-dag onComplete → 落 dag-record SQLite。抛错不阻断。 */
  onComplete?: ExecutorDagConfig['onComplete'];
  /** 跨模型校验 + conductor 静默升级 (resolveVerification 产)。省略 = 不校验。 */
  verification?: VerificationConfig;
  /** executor leaf 选型 bandit (B-2)。省略 = 静态。 */
  router?: LeafModelRouter;
}

/** 审计 preamble — 教 conductor 可用的 specialist lens + DAG 约束。 */
const AUDIT_PREAMBLE = `你是一个安全审计规划器。可用 specialist lens (每 lens 用 executor:"agent", 可读文件审查):

  1. code-reviewer    — 通用漏洞: 注入、认证越权、不安全反序列化、缓冲区溢出
  2. insecure-defaults — fail-open 默认值、硬编码 secret、弱认证、过宽权限配置
  3. supply-chain     — 高危/可被接管的依赖、已废弃维护的包
  4. threat-model     — 信任边界、攻击面、资产分类、攻击路径
  5. sharp-edges      — 危险 API 误用、footgun 设计、不安全加密基元用法
  6. agentic-actions  — agent/工具动作风险: 命令注入、越权写文件、prompt 注入信道

产 executor:"agent" 节点 (executor:"command" 不可, 因需读取目标文件)。

约束:
  1. 按目标性质选用合适 lens (不必全用)
  2. 所有 lens 节点**相互独立, 同层并行** (depends_on 不相互引用)
  3. 末尾必须有一个 ID:"report" 的 executor:"leaf" creative:true 节点,
     depends_on 含所有 lens 节点 ID, goal 描述"综合各 lens 发现, 输出结构化安全报告
     (按严重度排序的 finding 列表 + 简述 + 修复建议)"`;

/**
 * 执行多 lens 并行安全审计: conductor 规划 → 并行 specialist lens 审查 → 综合报告。
 *
 * @param target - 审计目标 (路径/目录)
 * @param opts   - 模型选择、工作目录等配置
 * @returns ExecutorDagResult (含 plan、层次、各节点结果、token 用量)
 */
export async function secAudit(
  target: string,
  opts: SecAuditOpts,
): Promise<ExecutorDagResult> {
  const task = `${AUDIT_PREAMBLE}\n\n审计目标: ${target}`;

  const dagConfig: ExecutorDagConfig = {
    ...opts.verification,
    router: opts.router,
    conductorModel: opts.conductorModel,
    leafModel: opts.leafModel,
    agentLeafModel: opts.agentLeafModel,
    agentRunner: createAgentLeafRunner({ cwd: opts.cwd ?? process.cwd() }),
    agents: ['sec'],
    maxFanout: opts.maxFanout,
    onComplete: opts.onComplete,
  };

  return runExecutorDag(task, dagConfig);
}
