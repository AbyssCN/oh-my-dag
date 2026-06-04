/**
 * src/wright/cg-audit-extension —— cgRetrieve / secAudit 的 pi 终端 slash 命令封装。
 *
 * 把两个 wright 核心能力 (codegraph 并行检索 / 多 lens 并行安全审计) 注册为 pi TUI 的
 * /cg 和 /audit 命令, 每次运行经 createDagRecorder → dag-record SQLite 留痕。
 *
 * 用法 (pi 终端内):
 *   /cg <代码问题>      → codegraph 检索 + 综合答案
 *   /audit [目标路径]   → 多 lens 安全审计 + 结构化报告 (默认当前目录)
 *
 * 工厂可注入依赖用于测试; 第二参 deps 省略 = 生产实现。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { cgRetrieve } from './cg-retrieve';
import { secAudit } from './sec-audit';
import { sastScan } from './sast-scan';
import { createDagRecorder } from './dag-record';
import type { VerificationConfig } from './verifier';
import type { LeafModelRouter } from './model-router';

export interface CgAuditExtensionOpts {
  /** conductor 模型 'provider:modelId', 透传给 cgRetrieve / secAudit。 */
  conductorModel: string;
  /** inproc leaf 模型 'provider:modelId' (合成/报告用)。 */
  leafModel: string;
  /** agent leaf 模型 (仅 secAudit 用, 带工具审查文件)。省略 = leafModel。 */
  agentLeafModel?: string;
  /** 默认工作目录。省略 = ctx.cwd。 */
  cwd?: string;
  /** dag-record SQLite 路径。省略 = createDagRecorder 默认 '.wright/dag-runs.db'。 */
  recordPath?: string;
  /**
   * 跨模型校验 + conductor 静默升级 (resolveVerification 产)。透传给 /cg /audit。
   * 省略 = 不校验。/sast 是确定性扫描 (command 节点为主), 不挂 verifier。
   */
  verification?: VerificationConfig;
  /** executor leaf 选型 bandit (B-2)。透传给 /cg /audit。省略 = 静态。 */
  router?: LeafModelRouter;
}

export interface CgAuditDeps {
  cgRetrieve?: typeof cgRetrieve;
  secAudit?: typeof secAudit;
  sastScan?: typeof sastScan;
  createDagRecorder?: typeof createDagRecorder;
}

/**
 * 造 cgRetrieve / secAudit 的 slash 命令扩展工厂。
 *
 * @param opts - 模型、路径等配置
 * @param deps - 测试注入 (省略 = 真实实现)
 * @returns ExtensionFactory 供 pi main(args, { extensionFactories: [...] }) 注册
 */
export function createCgAuditExtension(
  opts: CgAuditExtensionOpts,
  deps?: CgAuditDeps,
): ExtensionFactory {
  const mkRecorder = deps?.createDagRecorder ?? createDagRecorder;
  const recorder = mkRecorder({ path: opts.recordPath });

  return (pi) => {
    // 注: registerCommand 名**不带**前导斜杠 — pi 解析用户输入时已 slice(1) 去斜杠后按 name 匹配
    // (agent-session.js: `text.slice(1)`)。注册 '/cg' 会变 invocationName='/cg', 永不命中 'cg'。
    pi.registerCommand('cg', {
      description: 'codegraph 并行代码检索 + 综合答案。用法: /cg <代码问题>',
      handler: async (args: string, ctx) => {
        const trimmed = args.trim();
        if (!trimmed) {
          ctx.ui.notify('用法: /cg <代码问题>', 'warning');
          return;
        }
        ctx.ui.setStatus('cg', '检索中…');
        try {
          const r = await (deps?.cgRetrieve ?? cgRetrieve)(trimmed, {
            conductorModel: opts.conductorModel,
            leafModel: opts.leafModel,
            cwd: opts.cwd ?? ctx.cwd,
            verification: opts.verification,
            router: opts.router,
            onComplete: (res) => {
              recorder.record(res, { question: trimmed });
            },
          });
          const answer = r.results['synth']?.output ?? '(无 synth 结果)';
          ctx.ui.notify(answer, 'info');
        } catch (e) {
          ctx.ui.notify('检索失败: ' + String(e), 'error');
        } finally {
          ctx.ui.setStatus('cg', undefined);
        }
      },
    });

    pi.registerCommand('audit', {
      description: '多 lens 并行安全审计 + 结构化报告。用法: /audit [目标路径]',
      handler: async (args: string, ctx) => {
        const target = args.trim() || (opts.cwd ?? ctx.cwd);
        ctx.ui.setStatus('audit', '审计中…');
        try {
          const r = await (deps?.secAudit ?? secAudit)(target, {
            conductorModel: opts.conductorModel,
            leafModel: opts.leafModel,
            agentLeafModel: opts.agentLeafModel,
            cwd: opts.cwd ?? ctx.cwd,
            verification: opts.verification,
            router: opts.router,
            onComplete: (res) => {
              recorder.record(res, { question: 'audit ' + target });
            },
          });
          const report = r.results['report']?.output ?? '(无 report 结果)';
          ctx.ui.notify(report, 'info');
        } catch (e) {
          ctx.ui.notify('审计失败: ' + String(e), 'error');
        } finally {
          ctx.ui.setStatus('audit', undefined);
        }
      },
    });

    pi.registerCommand('sast', {
      description: '确定性 semgrep 静态扫描 (SAST) + 结构化报告。用法: /sast [目标路径]',
      handler: async (args: string, ctx) => {
        const target = args.trim() || (opts.cwd ?? ctx.cwd);
        ctx.ui.setStatus('sast', '扫描中…');
        try {
          const r = await (deps?.sastScan ?? sastScan)(target, {
            conductorModel: opts.conductorModel,
            leafModel: opts.leafModel,
            cwd: opts.cwd ?? ctx.cwd,
            onComplete: (res) => {
              recorder.record(res, { question: 'sast ' + target });
            },
          });
          const report = r.results['report']?.output ?? '(无 report 结果)';
          ctx.ui.notify(report, 'info');
        } catch (e) {
          ctx.ui.notify('扫描失败: ' + String(e), 'error');
        } finally {
          ctx.ui.setStatus('sast', undefined);
        }
      },
    });
  };
}
