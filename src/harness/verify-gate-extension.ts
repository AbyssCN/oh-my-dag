/**
 * verify-gate-extension —— 跨 turn "写后必验"闸 (上游泛化自私有 harness)。
 *
 * hooks/index.ts 曾记 "verify-gate 硬 block 需 re-prompt loop — pi 的 agent_end 无 result 不能
 * block, defer"。此扩展换落点解掉该 defer: 不在 agent_end 拦, 而是**写成功 → 标脏 → 拦下一个
 * 副作用工具 (bash 等) 直到 verify 工具跑绿**。pi 的 tool_call 事件原生支持 {block, reason}。
 *
 * 防死锁三原则 (fix-forward, 实战校准自私有上游):
 *   ① edit/write 永不拦 —— 编辑正是修复 dirty 的唯一手段, 拦它 = 死锁。
 *   ② git 撤销类 (checkout/restore/stash/reset/clean) 永不拦, 且成功后清脏 —— 死锁兜底出口。
 *   ③ test "环境跑不成" (DB 未起/超时) ≠ "测试失败": 前者跳过放行, 后者才拦。
 *
 * typecheck = 硬闸 (静态检查无外部依赖, 必须真绿; 跑不成 = 无法确认 = 不清脏)。
 * drift 检测不在此 (omd 已有更强的 hooks/drift-detector)。
 */
import { Type } from 'typebox';
import { defineTool, type ExtensionFactory, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { spawnSync } from 'node:child_process';
import { logger } from '../logger';
import { m } from './i18n';

export interface VerifyGateOpts {
  /** typecheck 命令 (硬闸)。默认 ['bun', 'run', 'typecheck']。 */
  typecheckCmd?: string[];
  /** test 命令。null = 不跑 test (只 typecheck)。默认 ['bun', 'test']。 */
  testCmd?: string[] | null;
  /** typecheck 超时 ms。默认 120_000。 */
  typecheckTimeoutMs?: number;
  /** test 超时 ms。默认 180_000。 */
  testTimeoutMs?: number;
  /** test 输出命中此正则 → 判"环境不可用"跳过 (非失败, 不拦)。默认涵盖常见连接层报错。 */
  envUnavailableRe?: RegExp;
  /** 被闸的副作用工具名。默认 ['bash']。edit/write 永不入此列 (防死锁①)。 */
  gatedTools?: readonly string[];
  /** 视为"写文件"的工具名 (成功即标脏)。默认 ['edit', 'write']。 */
  writeTools?: readonly string[];
}

/** 命令执行结果 (deps.run 注入面, 供测试替身)。 */
export interface RunResult {
  /** 进程没跑成 (ENOENT/超时): 无法确认 ≠ 通过。 */
  errored: boolean;
  /** exit 0。 */
  ok: boolean;
  output: string;
}

export interface VerifyGateDeps {
  run?: (cmd: string[], timeoutMs: number, cwd: string | undefined) => RunResult;
}

const GIT_UNDO_RE = /\bgit\s+(checkout|restore|stash|reset|clean)\b/;
const DEFAULT_ENV_UNAVAILABLE_RE =
  /ECONNREFUSED|connection refused|could not connect|:5432\b|ETIMEDOUT|(not running|unavailable)/i;

function defaultRun(cmd: string[], timeoutMs: number, cwd: string | undefined): RunResult {
  const proc = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    killSignal: 'SIGKILL',
    timeout: timeoutMs,
  });
  return {
    errored: proc.error != null,
    ok: proc.error == null && proc.status === 0,
    output: proc.error ? (proc.error.message ?? 'killed') : (proc.stdout || '') + (proc.stderr || ''),
  };
}

/** runtime tool_result 真形状 = { toolName, input, content[] }; 错误信号统一读 content 文本。 */
function firstResultText(event: unknown): string {
  const content = (event as { content?: unknown[] })?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

const VERIFY_SCHEMA = Type.Object({
  mode: Type.Optional(
    Type.Union([Type.Literal('smart'), Type.Literal('quick')], {
      description: 'smart = typecheck + test (默认); quick = 仅 typecheck',
    }),
  ),
});

/**
 * 造 verify-gate 扩展工厂。状态 (dirty 表) 存工厂实例闭包内, 跨 turn 存活、跨 session 不残留。
 */
export function createVerifyGateExtension(opts: VerifyGateOpts = {}, deps: VerifyGateDeps = {}): ExtensionFactory {
  const typecheckCmd = opts.typecheckCmd ?? ['bun', 'run', 'typecheck'];
  const testCmd = opts.testCmd === null ? null : (opts.testCmd ?? ['bun', 'test']);
  const typecheckTimeoutMs = opts.typecheckTimeoutMs ?? 120_000;
  const testTimeoutMs = opts.testTimeoutMs ?? 180_000;
  const envUnavailableRe = opts.envUnavailableRe ?? DEFAULT_ENV_UNAVAILABLE_RE;
  const gatedTools = new Set(opts.gatedTools ?? ['bash']);
  const writeTools = new Set(opts.writeTools ?? ['edit', 'write']);
  const run = deps.run ?? defaultRun;

  /** path → 未验证。verify 绿 / git 撤销成功 → 整表清。 */
  const dirty = new Set<string>();

  return (pi) => {
    pi.registerTool(
      defineTool({
        name: 'verify_changes',
        label: 'Verify Gate',
        description: m({
          en: 'Run typecheck (hard gate) + tests, clear the dirty-file gate on green. Blocked side-effect tools unlock after this passes.',
          zh: '跑 typecheck(硬闸) + test, 绿了清 dirty 闸; 被拦的副作用工具随即解封。',
        }),
        promptSnippet: m({
          en: 'verify_changes(mode?) — after editing files, run this before bash/deploy steps.',
          zh: 'verify_changes(mode?) — 改完文件后、跑 bash 副作用前先跑它。',
        }),
        parameters: VERIFY_SCHEMA,
        executionMode: 'sequential',
        async execute(_id: string, params: { mode?: 'smart' | 'quick' }, _signal, _onUpdate, ctx: ExtensionContext) {
          // ── typecheck 硬闸: 跑不成 (超时/ENOENT) = 无法确认 = 不清。 ──
          const tc = run(typecheckCmd, typecheckTimeoutMs, ctx?.cwd);
          if (!tc.ok) {
            ctx?.ui?.setStatus?.('verify-gate', '❌ verify failed');
            const head = tc.errored
              ? m({ en: 'typecheck did not complete (cannot confirm)', zh: 'typecheck 未跑成 (无法确认类型)' })
              : m({ en: 'typecheck FAILED', zh: 'typecheck 红' });
            return { content: [{ type: 'text', text: `❌ ${head}:\n${tc.output.slice(-600)}` }], details: {} };
          }

          // ── test: 区分 真失败(拦) / 环境不可用(跳过放行)。quick 模式或未配 testCmd 则不跑。 ──
          let testNote = '';
          if (params.mode !== 'quick' && testCmd) {
            const tp = run(testCmd, testTimeoutMs, ctx?.cwd);
            const envDown = tp.errored || envUnavailableRe.test(tp.output);
            if (envDown) {
              testNote = m({ en: ' (tests skipped: env unavailable)', zh: ' (test 环境不可用已跳过)' });
            } else if (!tp.ok) {
              ctx?.ui?.setStatus?.('verify-gate', '❌ tests failed');
              return {
                content: [{ type: 'text', text: `❌ ${m({ en: 'tests FAILED (gate stays)', zh: 'test 真失败 (不清 dirty)' })}:\n${tp.output.slice(-600)}` }],
                details: {},
              };
            }
          }

          const n = dirty.size;
          dirty.clear();
          ctx?.ui?.setStatus?.('verify-gate', '✅ verified');
          return {
            content: [{ type: 'text', text: `✅ verify PASS${testNote}. ${n} dirty file(s) cleared.` }],
            details: {},
          };
        },
      }),
    );

    // ── 副作用前闸: dirty 非空 → block (edit/write 永不入 gatedTools; git 撤销放行)。 ──
    pi.on('tool_call', (event: { toolName: string; input?: Record<string, unknown> }) => {
      if (!gatedTools.has(event.toolName)) return {};
      if (dirty.size === 0) return {};
      if (event.toolName === 'bash' && GIT_UNDO_RE.test(String(event.input?.command ?? ''))) return {};
      const files = [...dirty].slice(0, 5).join(', ');
      logger.warn({ files, tool: event.toolName }, '[omd/verify-gate] side-effect tool blocked: dirty files unverified');
      return {
        block: true,
        reason: m({
          en: `BLOCKED: unverified edits (${files}). Run verify_changes first (git checkout/restore to discard instead).`,
          zh: `BLOCKED: 有未验证的改动 (${files})。先跑 verify_changes (或 git checkout/restore 撤销)。`,
        }),
      };
    });

    // ── 写成功 → 标脏; git 撤销成功 → 清脏。 ──
    pi.on('tool_result', (event: { toolName: string; input?: Record<string, unknown> }, ctx?: ExtensionContext) => {
      if (firstResultText(event).includes('Error')) return; // 写失败/被拦 → 不标脏
      if (writeTools.has(event.toolName)) {
        const path = event.input?.path ?? event.input?.file;
        if (typeof path === 'string' && path) dirty.add(path);
        return;
      }
      if (event.toolName === 'bash' && GIT_UNDO_RE.test(String(event.input?.command ?? '')) && dirty.size > 0) {
        const n = dirty.size;
        dirty.clear();
        ctx?.ui?.setStatus?.('verify-gate', '🧹 dirty cleared (git undo)');
        logger.info({ n }, '[omd/verify-gate] git undo → dirty tracking reset');
      }
    });

    // ── turn 尾提醒 + 退出提醒 (pi 的 session_shutdown 无法阻断, 只提醒)。 ──
    pi.on('turn_end', (_event: unknown, ctx?: ExtensionContext) => {
      if (dirty.size > 0) ctx?.ui?.setStatus?.('verify-gate', `⚠️ ${dirty.size} dirty file(s) unverified`);
    });
    pi.on('session_shutdown', (_event: unknown, ctx?: ExtensionContext) => {
      if (dirty.size > 0) {
        ctx?.ui?.notify?.(
          m({ en: `${dirty.size} file(s) edited but never verified — run verify_changes.`, zh: `${dirty.size} 个文件改后未验证 — 记得 verify_changes。` }),
          'warning',
        );
      }
    });
  };
}
