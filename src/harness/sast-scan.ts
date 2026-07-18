/**
 * src/harness/sast-scan —— 确定性 SAST lens: conductor 规划 semgrep 扫描 DAG + synth 综合结构化报告。
 *
 * 与 src/harness/sec-audit.ts (agentic lens, 方法论文本 → 多轮 agent 探测) 互补:
 *   sast-scan = 确定性 CLI 扫描 (semgrep, 零 LLM) → 结构化 JSON → synth 综合
 *   sec-audit = agentic 方法论 (方法论 → 工具探测) → 深度交互
 *
 * 前者快、便宜、可缓存; 后者慢但深度。两者数据可以合并成完整安全评估。
 *
 * DAG 结构强制:
 *   ① 扫描节点 (command: "semgrep scan --json --config <规则集> <路径>") — 同层并行
 *   ② report 节点 (leaf, 创意综合 JSON) — depends_on 所有扫描节点
 */
import { runExecutorDag, type ExecutorDagConfig } from './executor-dag';
import { createCommandLeafRunner } from './command-leaf';
import type { ExecutorDagResult } from './executor-dag';

export interface SastScanOpts {
  /** conductor 模型 'provider:modelId'。必填, 无硬默认。 */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (合成报告用)。必填, 无硬默认。 */
  leafModel: string;
  /** semgrep CLI 的工作目录。默认 process.cwd()。 */
  cwd?: string;
  /** 内层 fan-out 并发上限。省略 → primitives 兜底。 */
  maxFanout?: number;
  /** 运行完成钩子 (留痕层接口)。透传给 executor-dag onComplete → 落 dag-record SQLite。抛错不阻断。 */
  onComplete?: ExecutorDagConfig['onComplete'];
}

/** semgrep SAST 扫描工具 preamble — 教 conductor 可用命令 + DAG 约束。 */
const SAST_PREAMBLE = `你是一个静态分析 (SAST) 扫描规划器。可用确定性 CLI (executor:"command"):

  - semgrep scan --json --config auto <路径>             # 注册表规则 (通用)
  - semgrep scan --json --config p/security-audit <路径>  # 安全审计规则集
  - semgrep scan --json --config p/secrets <路径>        # 硬编码 secret 扫描

产 executor:"command" 节点, command 字段填一条完整 semgrep 命令串 (不要管道/重定向/反引号 — 仅限合法路径参数)。

约束:
  1. 扫描节点同层并行 (不依赖其它扫描节点)
  2. 末尾必须有一个 ID:"report" 的 executor:"leaf" creative:true 节点,
     depends_on 含所有扫描节点 ID, goal 描述"解析各 semgrep JSON 结果,
     综合成按严重度排序的 finding 列表 + 简述 + 修复建议"`;

/**
 * 执行 SAST 静态扫描: conductor 规划 → 并行 semgrep 扫描 → 综合报告。
 *
 * @param target - 扫描目标路径 (目录或文件)
 * @param opts   - 模型选择、工作目录等配置
 * @returns ExecutorDagResult (含 plan、层次、各节点结果、token 用量)
 */
export async function sastScan(
  target: string,
  opts: SastScanOpts,
): Promise<ExecutorDagResult> {
  const task = `${SAST_PREAMBLE}\n\n扫描目标: ${target}`;

  const dagConfig: ExecutorDagConfig = {
    conductorModel: opts.conductorModel,
    leafModel: opts.leafModel,
    commandRunner: createCommandLeafRunner({
      allowlist: ['semgrep'],
      cwd: opts.cwd ?? process.cwd(),
    }),
    agents: ['sast'],
    maxFanout: opts.maxFanout,
    onComplete: opts.onComplete,
  };

  return runExecutorDag(task, dagConfig);
}
