/**
 * src/harness/session/continuity-hook —— Stop / PreCompact 触发判定与派发装配(#206)。
 *
 * 与 `scripts/session-continuity-hook.ts` 的分工同 writer:**逻辑在这里,副作用在薄壳里**。
 * 分开的理由是实测出来的:薄壳首行 `import script-bootstrap` 会把 `OMD_DATA_HOME` 写进
 * 进程 env —— 谁为了拿这几个纯函数 import 它,谁的 env 就被改了(测试首跑即撞)。
 *
 * ## 这一格补的是什么
 *
 * `docs/examples/claude-code/hooks/session-continuity.ts`(冻结)是纯决策器:吐
 * `{decision:'block'}` 让 CC 多走一轮 + 记 ledger,**从不 spawn writer**。于是链路断在
 * 「没有任何东西会自动调 `scripts/session-writer.ts`」上,`facts` 表里 continuity 零行。
 * 本模块给出触发判定 + 派发参数,薄壳负责真 spawn(detached,蒸馏是后台活)。
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../project-scope';
import { bucketIndex, bucketThreshold } from './bucket';
import type { StopLedger } from './stop-ledger';

// ─── Public types ───────────────────────────────────────────────────────────

export interface ContinuityHookInput {
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  /** CC loop guard 防递归。 */
  readonly stop_hook_active?: boolean;
  readonly [key: string]: unknown;
}

export type ContinuityMode = 'rolling' | 'precompact' | 'final';

export type ContinuityTrigger =
  | Readonly<{ fire: false; why: string }>
  | Readonly<{ fire: true; mode: ContinuityMode; bucket: number }>;

// ─── 触发判定(纯函数,零副作用)────────────────────────────────────────────

/**
 * **自喂闸**:本会话是不是 agent-SDK 起的子会话。
 *
 * ⚠ 2026-08-20 生产盘上烧了一天六小时的 fork bomb 的唯一止血位,链是闭的:
 *   writer 派 agent-SDK 子会话做蒸馏 → 子会话结束 → 它继承 `~/.claude/settings.json` 的
 *   `SessionEnd` hook 再点火 → 又一个 detached writer → 又一个子会话 → 无限。
 *   `stop_hook_active` 挡不住:那是 CC **只给 `Stop`** 的 loop guard,`SessionEnd` 没有对应位。
 *   实测代价:load 131 / 24 核 · WSL 吃满全机 88% CPU · ~1.7 圈/秒,每圈一次 Sonnet 调用 ·
 *   `~/.omd/projects/nick/session/` 攒到 84,890 个目录。
 *
 * ⚠ **别用 `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_FORK_SUBAGENT` 当判别位** —— 实测
 *   交互式会话里这两个**同样是 1**(`env | grep CLAUDE_CODE_` 就能看见),拿它们当闸会把真人
 *   会话的 continuity 一起打死,而且是静默的:checkpoint 不再生成,没有任何报错。
 *   真正分得开的只有 `CLAUDE_CODE_ENTRYPOINT`:交互 = `cli`,SDK 起的 = `sdk-cli`。
 *   `CLAUDE_AGENT_SDK_VERSION` 作第二个冗余位(只 SDK 侧注入),防 entrypoint 改名。
 *
 * 语义上这也是对的:SDK 子会话是 DAG worker / 蒸馏器这类一次性执行体,没有交接价值,
 * 它们的 continuity 走的是另一套(`.omd/continuity/`,与本层分家)。
 */
export function isSdkChildSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli' || env.CLAUDE_AGENT_SDK_VERSION !== undefined;
}

/**
 * 跨档判定用 **bucket 序号跨越**,基准是 **`lastFiredBucket` —— 我实际存到过第几档**,
 * 不是历史读数里出现过的最高档。
 *
 * ⚠ 这一条是 2026-08-19 在生产盘上撞出来的,两次都写错过,记法在此:
 *   ① 最早比「前一条 entry」→ 一个 Stop 之间会追加多条 entry,跨档那一跳落在中间就永远看不见;
 *   ② 改成比「此前全部 entry 的最高档」→ **hook 装在会话中途时彻底哑掉**:第一次跑就把整条
 *      历史读进来,历史最高档已经是 N,于是 `N > N` 永假,这个 session 剩下每一轮都不再响。
 *      实测证据:本仓一条 session 的 ledger 372 行、ctx 408k、档位 0/1/2 全过,
 *      而 `checkpoint.md` 与 `writer.log` **一个都没有**。
 * 正确的基准只能是「已经存到第几档」,那是**状态**,必须落盘(hook 是短命进程)。
 * 首次跑(无状态,`lastFiredBucket = 0`)且已过首档 → 存一次:装上去就该立刻有一份,
 * 而不是等下一个 20 万 token。
 */
export function decideContinuityTrigger(
  input: ContinuityHookInput,
  ledger: StopLedger,
  opts: { env?: NodeJS.ProcessEnv; lastFiredBucket?: number } = {},
): ContinuityTrigger {
  const env = opts.env ?? process.env;
  // 自喂闸放在**所有**事件之前:三条 fire 路径(Stop / PreCompact / SessionEnd)一条都不能漏,
  // 漏一条 fork bomb 就照跑。理由见 `isSdkChildSession`。
  if (isSdkChildSession(env)) return { fire: false, why: 'SDK 子会话 → 不自喂' };
  // PreCompact:压缩前恒存一次档 —— 那正是最需要快照的时刻,不看档位。
  if (input.hook_event_name === 'PreCompact') return { fire: true, mode: 'precompact', bucket: 0 };
  // SessionEnd:收口一次(`--final`, 会 splice `_NEXT.md` 的 AUTO 区)。同样不看档位 ——
  // 会话结束就这一次机会,错过就只能靠上一次 Stop 的存档(最多旧一个档)。
  if (input.hook_event_name === 'SessionEnd') return { fire: true, mode: 'final', bucket: 0 };
  if (input.hook_event_name !== 'Stop') return { fire: false, why: `事件 ${input.hook_event_name} 不决策` };
  // 守卫不是触发:CC loop guard 命中 = 本轮由 hook 自己引发, 不再记一次。
  if (input.stop_hook_active === true) return { fire: false, why: 'stop_hook_active' };

  const threshold = bucketThreshold(env);
  if (threshold === null) return { fire: false, why: 'OMD_SESSION_BUCKET 配置坏 → 不造档位' };

  const entries = ledger.entries;
  const last = entries[entries.length - 1];
  if (last === undefined) return { fire: false, why: '空 ledger' };
  if (last.tokenBucket === null) return { fire: false, why: '最新条缺 token → 绝不伪造' };

  const nowIdx = bucketIndex(last.tokenBucket, threshold);
  if (nowIdx < 1) return { fire: false, why: `未过首档 (${last.tokenBucket} < ${threshold})` };

  const prevIdx = opts.lastFiredBucket ?? 0;
  return nowIdx > prevIdx
    ? { fire: true, mode: 'rolling', bucket: nowIdx }
    : { fire: false, why: `已存到 ${prevIdx} 档, 当前 ${nowIdx} 档 → 不重复` };
}

// ─── 派发装配 ───────────────────────────────────────────────────────────────

/** 引擎锚 = 本仓根,**不随 cwd**:别的 repo 引本 hook 时那个 repo 没有 writer 脚本。 */
export function engineRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * spawn 参数装配(抽成纯函数是为了让「派了什么」可断言 —— detached 子进程本身测不了)。
 * `OMD_CONTINUITY_MECHANICAL=1` → 追加 `--mechanical` 跳过模型调用,端到端闸靠它跑成确定性。
 */
export function writerArgv(
  transcript: string,
  sessionId: string,
  mode: ContinuityMode,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const argv = [
    'run',
    join(engineRoot(), 'scripts/session-writer.ts'),
    '--transcript',
    transcript,
    '--session',
    sessionId,
  ];
  if (mode === 'precompact') argv.push('--precompact');
  if (mode === 'final') argv.push('--final');
  if (env.OMD_CONTINUITY_MECHANICAL === '1') argv.push('--mechanical');
  return argv;
}

/**
 * writer 的 session 目录 —— 与 `writer.ts:361` / `ledger.ts:142` 逐字同源。
 * 这三处任何一处漂了,ledger 就是写给没人读的地方(hooks README「路径必须字面对齐」那条)。
 */
export function sessionDirOf(sessionId: string, cwd?: string): string {
  const scope = resolveProject(cwd);
  return resolve(scope.rootPath, scope.dataPath(join('session', sessionId)));
}

// ─── 已存档位状态(hook 是短命进程 → 只能落盘)────────────────────────────────

/**
 * `<sessionDir>/continuity-state.json` —— 只存一件事:**这个 session 已经存到第几档**。
 *
 * 为什么不塞进 writer 的 `state.json`:那份是 writer 自己的(蒸馏游标),两个写者写同一个文件
 * 就得约定合并规则,而这里只需要一个数。分开文件,谁写谁的。
 */
export function readLastFiredBucket(sessionId: string, cwd?: string): number {
  try {
    const raw = JSON.parse(readFileSync(join(sessionDirOf(sessionId, cwd), STATE_FILE), 'utf-8')) as {
      lastFiredBucket?: unknown;
    };
    const n = raw.lastFiredBucket;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // 没有 / 坏了 → 当没存过。方向安全:宁可多存一次
  }
}

/** 写已存档位。失败只记 stderr —— 存档本身已经成了,状态没写上最多下次多存一份。 */
export function writeLastFiredBucket(sessionId: string, bucket: number, cwd?: string): void {
  try {
    const dir = sessionDirOf(sessionId, cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ lastFiredBucket: bucket, updatedAt: Date.now() }));
  } catch (e) {
    console.error(`[continuity-hook] 档位状态写失败 (下次可能多存一份): ${e instanceof Error ? e.message : String(e)}`);
  }
}

const STATE_FILE = 'continuity-state.json';

/** 这个 session 到底有没有产出过 checkpoint —— 给「装上去就该有一份」那条闸当判据。 */
export function hasCheckpoint(sessionId: string, cwd?: string): boolean {
  return existsSync(join(sessionDirOf(sessionId, cwd), 'checkpoint.md'));
}

// SessionStart 注入面 2026-08-19 (#212) 搬进 `session/resume.ts` —— 它是**读回面**,
// omd 自己的 chat 也要用它(注 persona), 不该让 chat 去 import 一个 CC-hook 味的模块。
export { buildSessionStartContext, personaPath } from './resume';
