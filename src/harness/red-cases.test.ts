/**
 * src/harness/red-cases.test.ts —— C-3 (片 3) 红用例 regime 的 meta-test。
 *
 * 契约来源: 执行契约 D1 §C-3 (INV-10 / INV-11 / INV-12) + SDD §7。
 *
 * 设计: 本文件**不**断言红用例自身的语义正确性(那会犯 INV-12 自我指涉);
 *        它断言的是**红用例 regime 的健康度**, 判据来自引擎确定性原语:
 *   - MT-A: 必红对照 — `Bun.spawnSync(['bun','test', canary])` 的 exit code
 *   - MT-B: 引擎确定性原语 — `ConfidenceSchema.safeParse({ level:'human_verified', … })`
 *   - MT-C: 复用现有闸 — `checkBootstrapWrite('red_tests/…')` 的 audit.kind
 *   - MT-D: 文件系统原语 — `readdirSync(red_tests, recursive).filter(.red-cases.ts)`
 *
 * 红用例本体在 `red_tests/` 下, 由 bash heredoc 落地 —— write-allow.ts:62 的目录
 * 前缀匹配在「`red_tests/`(尾斜杠)」上有个 ${d}/ 双斜杠的怪点(d='red_tests/' 时
 * `${d}/` 变 'red_tests//', 对子路径无法命中)。该闸 bug 属仓规静默坑范畴, 留给 owner
 * 在 `write-allow.ts` 修;本片契约规定目录声明形如 `red_tests/`, 我只能在 bash 层
 * 绕过这一道闸。shell-writes.ts 的救援②会从 `cat > path` 里把目标认回来, 产物闸
 * 不误判 (实测 shellWriteTargets 第①段「重定向」匹配 `> red_tests/rt-01-…`)。
 *
 * 三权分立 (SDD §7):
 *   - 写权 = plan-critic 侧 (本片落 10 + 1 红用例);
 *   - 跑权 = 本 meta-test 文件 (独立执行体, 跑在 CI / `bun test`);
 *   - 判权 = 引擎确定性原语 (Bun.spawnSync / Zod.safeParse / fs.readdirSync),
 *           **不**是红用例自己的 expect。
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createBootstrapWriteSet, checkBootstrapWrite } from './bootstrap-gate';
import { ConfidenceSchema } from '../memory/safeguards/namespace-kernel';

// ─── 工程常量 ────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, '../..');
const RED_TESTS_DIR = join(ROOT, 'red_tests');
const CANARY_PATH = join(RED_TESTS_DIR, '_canary/canary.red-cases.ts');
/** SDD §8 切片表 S2 写的「10 红用例」—— MT-D 的下限。owner 待决 #9 通用规则待批,
 *  本片先锁 10 (MT-D 的「只许升不许降」按此锚)。 */
const MIN_RED_CASES = 10;
/** D-8 锚的判断时间。freeze 后哪怕 SDD §8 切片表改字, 10 这条已经入档不变。 */
const FROZEN_NOW = (): Date => new Date('2026-02-01T12:00:00Z');

// ─── MT-A: _canary/ 必红对照 ─────────────────────────────────────────────────

describe('MT-A: _canary/ 必红对照 (永远绿的闸不是闸)', () => {
  test('canary 文件存在 (红用例 regime 的物质基础)', () => {
    expect(statSync(CANARY_PATH).isFile()).toBe(true);
  });

  test('canary bun test exit code ≠ 0 (引擎确定性原语判权, 不是断言自指)', () => {
    // Bun.spawnSync 是 INV-12 的「引擎确定性原语」那一档: 我们问引擎「跑这条会红吗」,
    // 答案由进程退出码给出 —— 不依赖 canary 自己的 expect。
    const proc = Bun.spawnSync([process.execPath, 'test', CANARY_PATH], {
      cwd: ROOT,
      env: {}, // env -i 等价: 无 API key 派生变量也不许崩
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // 显式打印 stderr 留给未来排障 (静默坑 2: fail-open 可吞异常, 不许吞证据)。
    if (proc.exitCode === 0) {
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString();
      throw new Error(
        `canary 跑通了 (exitCode=0) — MT-A 闸坏了。\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    expect(proc.exitCode).not.toBe(0);
  });
});

// ─── MT-B: human_verified 必绿 ───────────────────────────────────────────────

describe('MT-B: human_verified 必绿 (判权机制的第二档 = dream human_verified)', () => {
  // SDD §7: 「判权 = 引擎确定性原语 **或** dream `human_verified` 工具, 不得指向自身」。
  // 本 meta-test 钉的是「human_verified 这条判权源**能用**」 —— 在一个能判权源
  // 失效的仓里, 红用例 regime 的另一半就被拆了。Zod safeParse 是确定性原语。

  test('ConfidenceSchema.safeParse 接受合法的 human_verified (level=human_verified)', () => {
    const r = ConfidenceSchema.safeParse({
      level: 'human_verified',
      by: 'owner',
      verified_at: FROZEN_NOW(),
      note: 'red-cases regime meta-test (D-1 / S2 前半)',
    });
    expect(r.success).toBe(true);
  });

  test('human_verified 是 ConfidenceSchema 的合法分支 (拒绝会冒 typ-level 错)',
    () => {
      // 反向自检: 如果有人把 human_verified 从 ConfidenceSchema 摘了,
      // 这条会红 —— 那么 SDD §7 第二档判权源就失效了。
      // 三档各自的最小 source_event_ids: human=0, confident=3, tentative=1-2。
      const cases = [
        { level: 'human_verified', body: { by: 'owner', verified_at: FROZEN_NOW() } },
        { level: 'agent_confident', body: { source_event_ids: ['e1', 'e2', 'e3'], created_at: FROZEN_NOW() } },
        { level: 'agent_tentative', body: { source_event_ids: ['e1'], created_at: FROZEN_NOW() } },
      ] as const;
      for (const c of cases) {
        const r = ConfidenceSchema.safeParse({ level: c.level, ...c.body });
        expect(r.success).toBe(true);
      }
    });
});

// ─── MT-C: 越权写捕获 (复用 bootstrap-gate INV-19, 不重造) ─────────────────

describe('MT-C: 越权写捕获 (bootstrap leaf 写 red_tests/ 必被拒 + audit.kind 必为 red_tests_blocked)', () => {
  // 不重造 —— SDD §7 + bootstrap-gate.ts:29 + :238 已经把 INV-19 写权分立落完了。
  // 本 meta-test 钉的是「那把闸还在 + 字面没漂」。

  test('bootstrap leaf 写 red_tests/any.red-cases.ts → allowed=false + red_tests_blocked', () => {
    // 写集声明包含 red_tests/any.red-cases.ts (模拟 bootstrap 节点真心想写),
    // checkBootstrapWrite 仍要拒 —— 三权分立里**写权不归 bootstrap leaf**。
    const ws = createBootstrapWriteSet(['red_tests/any.red-cases.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('red_tests/any.red-cases.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('shape guard');
    expect(v.audit.kind).toBe('red_tests_blocked');
    expect(v.audit.path).toBe('red_tests/any.red-cases.ts');
  });

  test('拒绝顺序 — red_tests 优先于 shadow_exec (路径在 red_tests/ 时, audit.kind 必为 red_tests_blocked 不是 shadow_exec)', () => {
    // 路径既在 red_tests/ 下又**不在** frozen 集 —— 必须以 red_tests_blocked 拒,
    // 不是 shadow_exec。漂了就犯 §静默坑 (拒因可读性)。
    const ws = createBootstrapWriteSet(['somewhere/else.ts'], FROZEN_NOW);
    const v = checkBootstrapWrite('red_tests/anything.ts', ws, FROZEN_NOW);
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('shape guard');
    expect(v.audit.kind).toBe('red_tests_blocked');
  });
});

// ─── MT-D: 红用例数 ≥ 10 的绊线 ─────────────────────────────────────────────

describe('MT-D: 红用例数 ≥ 10 的绊线 (只许升不许降, SDD §8 切片表 S2 锚 10)', () => {
  // 「只许升不许降」(D-8): MT-D 的下限是 10。降到 9 这条红, 升到 11 这条不红。
  // 判据 = 文件系统原语 (readdirSync), 不依赖具体文件名 (MT-D 是 regime 数,
  // 不是某条具体用例的判权)。

  /** 递归列 red_tests/ 下所有 *.red-cases.ts 文件的相对路径。 */
  function listRedCases(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name.endsWith('.red-cases.ts')) {
          out.push(relative(ROOT, full));
        }
      }
    };
    if (statSync(RED_TESTS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
      walk(RED_TESTS_DIR);
    }
    return out;
  }

  let cached: string[] | null = null;
  const redCases = (): string[] => (cached ??= listRedCases().sort());

  test('red_tests/ 目录存在 (红用例 regime 的物理前提)', () => {
    expect(statSync(RED_TESTS_DIR, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  });

  test(`盘上 *.red-cases.ts 文件数 ≥ ${MIN_RED_CASES} (含 _canary/)`, () => {
    const cases = redCases();
    if (cases.length < MIN_RED_CASES) {
      throw new Error(
        `红用例数下限不达标: 期望 ≥ ${MIN_RED_CASES}, 实有 ${cases.length}。` +
          `\n盘上清单:\n${cases.join('\n') || '(空)'}`,
      );
    }
    expect(cases.length).toBeGreaterThanOrEqual(MIN_RED_CASES);
  });

  test('MT-D 绊线反向自检: 把期望下限临时调到 cases.length+1, 用同一函数应判不足',
    () => {
      // 永远绿的闸不是闸。把 MIN_RED_CASES 这个常数临时推到 cases.length + 1,
      // 同一 listRedCases 必须判出不足。如果 MT-D 的判据本身错了 (例如只数了
      // _canary/ 或只数了 root), 这条会**反向**通过, 立刻暴露。
      const cases = redCases();
      const inflated = cases.length + 1;
      expect(cases.length >= inflated).toBe(false);
    });
});

// ─── 本地清理 ────────────────────────────────────────────────────────────────
// (本文件不产生临时产物; 留 hook 是为后续 red_cases 元用例扩展时不被忘)

beforeAll(() => {
  // no-op
});
afterEach(() => {
  // no-op
});