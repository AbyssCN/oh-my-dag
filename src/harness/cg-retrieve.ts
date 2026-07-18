/**
 * src/harness/cg-retrieve —— codegraph 代码检索能力: conductor 并行派 codegraph 命令 + synth 综合答案。
 *
 * 用户给代码问题 → preamble 教 conductor 规划 codegraph 查询 DAG → 并行 command 叶 → 合成最终答案。
 *
 * DAG 结构强制:
 *   ① sync 节点 (command: "codegraph sync -q", 增量同步索引) — 所有查询的先决
 *   ② 查询节点 (command: codegraph query/context/callers/…) — 同层并行, depends_on sync
 *   ③ synth 节点 (leaf, 模型综合) — depends_on 所有查询节点, creative:true 护交付物质量
 */
import { runExecutorDag, type ExecutorDagConfig } from './executor-dag';
import { createCommandLeafRunner } from './command-leaf';
import type { ExecutorDagResult } from './executor-dag';
import type { VerificationConfig } from './verifier';
import type { LeafModelRouter } from './model-router';

export interface CgRetrieveOpts {
  /** conductor 模型 'provider:modelId'。必填, 无硬默认。 */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (合成用)。必填, 无硬默认。 */
  leafModel: string;
  /** codegraph CLI 的工作目录。默认 process.cwd()。 */
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

/** codegraph CLI 工具 preamble — 教 conductor 可用命令 + DAG 约束。 */
const CODEGRAPH_PREAMBLE = `你是一个代码检索规划器。可用确定性 CLI:

  - codegraph sync -q                        # 增量同步索引 (必须先跑)
  - codegraph query <symbol>                 # 查符号定义/引用
  - codegraph context <task description>      # 查与任务相关的上下文
  - codegraph callers <symbol>               # 查谁调了此符号
  - codegraph callees <symbol>               # 查此符号调了谁
  - codegraph impact <symbol>                # 查改动符号的影响范围
  - codegraph files                          # 列项目文件树

产 executor:"command" 节点 (每个 command 字段填一条完整 codegraph 命令串)。

约束:
  1. 第一个节点必须是 executor:"command" command:"codegraph sync -q" id:"sync"
  2. 查询节点 depends_on: ["sync"]; 独立查询同层并行 (depends_on 仅含 sync)
  3. 末尾必须有一个 ID:"synth" 的 executor:"leaf" creative:true 节点,
     depends_on 含所有查询节点 ID, goal 描述"综合以上结果回答用户问题"`;

/**
 * 执行 codegraph 代码检索: conductor 规划 → 并行 codegraph 查询 → 综合答案。
 *
 * @param question - 用户的代码问题/检索需求
 * @param opts     - 模型选择、工作目录等配置
 * @returns ExecutorDagResult (含 plan、层次、各节点结果、token 用量)
 */
export async function cgRetrieve(
  question: string,
  opts: CgRetrieveOpts,
): Promise<ExecutorDagResult> {
  const task = `${CODEGRAPH_PREAMBLE}\n\n用户问题: ${question}`;

  const dagConfig: ExecutorDagConfig = {
    ...opts.verification,
    router: opts.router,
    conductorModel: opts.conductorModel,
    leafModel: opts.leafModel,
    commandRunner: createCommandLeafRunner({
      allowlist: ['codegraph'],
      cwd: opts.cwd ?? process.cwd(),
    }),
    agents: ['cg'],
    maxFanout: opts.maxFanout,
    onComplete: opts.onComplete,
  };

  return runExecutorDag(task, dagConfig);
}
