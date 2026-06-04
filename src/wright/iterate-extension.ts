/**
 * src/wright/iterate-extension —— iterateExecutorDag 的 pi 终端 slash 命令封装。
 *
 * 把 wright 内层 DAG 的**外层 fixpoint 迭代**能力注册为 pi TUI 的 /iterate 命令 (cg-audit-extension
 * 同范式), 每轮经 dag-record SQLite 留痕 (记最终收敛轮的图)。
 *
 * 用法 (pi 终端内):
 *   /iterate <任务>   → 迭代执行直到 judge 判收敛 / 触 maxRounds, 报告收敛状态 + 最终结果
 *
 * 工厂可注入依赖用于测试; 第二参 deps 省略 = 生产实现。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { iterateExecutorDag, summarizeDagResult } from './plan/iterate';
import { createDagRecorder } from './dag-record';

export interface IterateExtensionOpts {
  /** conductor 模型 'provider:modelId'。 */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId'。 */
  leafModel: string;
  /** agent leaf 模型 (带工具改文件)。省略 = leafModel。 */
  agentLeafModel?: string;
  /** 收敛 judge 模型。省略 = leafModel。 */
  judgeModel?: string;
  /** 最大迭代轮数。省略 = iterate 默认 (3)。 */
  maxRounds?: number;
  /**
   * conductor 轮级升级模型 'provider:modelId' (未收敛多轮 → round ≥2 换强 conductor 重画)。
   * provider 未注册 (没配 API key) → 全程维持弱 conductor。省略 = 永不升级。
   */
  conductorEscalationModel?: string;
  /** 默认工作目录。省略 = ctx.cwd。 */
  cwd?: string;
  /** dag-record SQLite 路径。省略 = createDagRecorder 默认。 */
  recordPath?: string;
}

export interface IterateDeps {
  iterateExecutorDag?: typeof iterateExecutorDag;
  createDagRecorder?: typeof createDagRecorder;
}

/**
 * 造 /iterate slash 命令扩展工厂。
 *
 * @param opts - 模型、轮数、路径等配置
 * @param deps - 测试注入 (省略 = 真实实现)
 * @returns ExtensionFactory 供 pi main(args, { extensionFactories: [...] }) 注册
 */
export function createIterateExtension(
  opts: IterateExtensionOpts,
  deps?: IterateDeps,
): ExtensionFactory {
  const mkRecorder = deps?.createDagRecorder ?? createDagRecorder;
  const recorder = mkRecorder({ path: opts.recordPath });
  const iterate = deps?.iterateExecutorDag ?? iterateExecutorDag;

  return (pi) => {
    // 注: registerCommand 名不带前导斜杠 (pi agent-session 已 slice(1) 去斜杠后按 name 匹配)。
    pi.registerCommand('iterate', {
      description: '外层 fixpoint 迭代执行 (跑→评→重画 直到收敛)。用法: /iterate <任务>',
      handler: async (args: string, ctx) => {
        const task = args.trim();
        if (!task) {
          ctx.ui.notify('用法: /iterate <任务>', 'warning');
          return;
        }
        ctx.ui.setStatus('iterate', '迭代中…');
        try {
          const r = await iterate(task, {
            conductorModel: opts.conductorModel,
            leafModel: opts.leafModel,
            agentLeafModel: opts.agentLeafModel,
            judgeModel: opts.judgeModel,
            maxRounds: opts.maxRounds,
            conductorEscalationModel: opts.conductorEscalationModel,
            onComplete: (res) => {
              // 每轮 DAG 完成钩子 → 留痕 (各轮的图都记一条)。
              recorder.record(res, { question: 'iterate ' + task });
            },
          });
          const head = `[${r.status}] ${r.rounds.length} 轮 · 收敛=${r.converged}`;
          const body = r.finalRound ? summarizeDagResult(r.finalRound.result, 600) : '(无产出)';
          ctx.ui.notify(`${head}\n\n${body}`, r.converged ? 'info' : 'warning');
        } catch (e) {
          ctx.ui.notify('迭代失败: ' + String(e), 'error');
        } finally {
          ctx.ui.setStatus('iterate', undefined);
        }
      },
    });
  };
}
