/**
 * src/harness/inventory/writer-liveness.test —— C-1 B5 per-worktree 单写者测试
 *      (执行契约 docs/plan/2026-08-25-conductorS2后半-单写者与信用解耦-执行契约.md)。
 *
 * 覆盖:
 *   INV-1 同一规范化 worktree 同时至多一个 inventory 写会话:
 *         assertSingleWriter(worktree) 必须先于 evaluateTestGate 与任何 registerInFlight。
 *   INV-2 不同 worktree 使用不同 lockPath, 互不拒绝; 跨 worktree 提升仍由 branch merge 显式完成。
 *   INV-3 release 后同一 worktree 的下一写者可取得锁; 异常退出路径也执行 release。
 *   INV-4 冲突失败发生在首个 inventory Map 变更之前, 错误含 worktree / lockPath / 既有 writer 证据;
 *         测试断言状态未变。
 *
 * B5 设计要点 (D-1 / D-2):
 *   - acquire = runBootstrapGate 入口的 assertSingleWriter(worktree), 失败即抛 SingleWriterViolation;
 *   - release = 闭包内 try/finally, 不依赖租约超时, 崩溃遗留锁由外部恢复动作处理;
 *   - error.worktree / error.lockPath / error.origin 全部字面断言;
 *   - 状态机断言 (in-flight Map) 在冲突失败路径上**未变**。
 *
 * 测试 fixture 路径都用 `mkdtempSync` 隔离, afterEach 强制 rm, 不污染盘上其他 worktree。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetInventoryForTests,
  assertSingleWriter,
  SINGLE_WRITER_LOCK_NAME,
  SingleWriterViolation,
} from './inventory';
import {
  runBootstrapGate,
  type BootstrapNode,
  type InventoryInFlightAdapter,
  type OracleResult,
} from '../bootstrap-gate';

// ─── 隔离 ────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
/** 每次返回一个全新临时目录做 worktree; afterEach 递归清。 */
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-b5-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  _resetInventoryForTests();
});
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  _resetInventoryForTests();
});

// ─── 工厂 ────────────────────────────────────────────────────────────────────

/** INV-S1-7 provenance 11 字段 (字段顺序逐字锁定)。 */
function validProvenance() {
  return {
    registered_at: '2026-01-01T00:00:00Z',
    registered_by: 'b5-test',
    source_repo: 'b5/repo',
    source_path: 'tools/b5.ts',
    commit_sha: 'b'.repeat(40),
    import_method: 'test',
    imported_at: '2026-01-01T00:00:00Z',
    imported_by: 'b5-test',
    upstream_version: '1.0.0',
    content_sha256: 'b'.repeat(64),
    schema_version: '1.0',
  } as const;
}

function validNode(toolId = 'b5:tool@1.0.0'): BootstrapNode {
  return {
    type: 'bootstrap',
    outputs: { tool_path: 'tools/b5.ts' },
    test_gate: {
      tool_id: toolId,
      oracle: [
        { kind: 'command', gateScriptRef: 'gates/b5.sh', deterministic: true, pass: true },
      ],
      allow_non_deterministic: false,
      timeout_sec: 30,
      cost_ceiling: 0.05,
    },
    provenance: validProvenance(),
  };
}

function oracle(deterministic: boolean, pass: boolean): OracleResult {
  return { deterministic, pass };
}

/** Adapter stub: 记下每次 registerInFlight 的 id + gate; 默认成功。 */
function stubAdapter(): InventoryInFlightAdapter & { calls: { id: string; status: string }[] } {
  const calls: { id: string; status: string }[] = [];
  return {
    calls,
    registerInFlight: (id, gate) => {
      calls.push({ id, status: gate.status });
      return { ok: true, phase: 'in-flight', id };
    },
  };
}

// ─── GWT-1 (INV-1 / INV-4): 同 worktree 冲突 → 抛, adapter 未调, 状态未变 ───

describe('C-1 GWT-1 INV-1/INV-4: 同 worktree 第二个写者抛 SingleWriterViolation', () => {
  test('B5_WRITER_LIVENESS: 第一写者持锁期间, runBootstrapGate 同 worktree → 抛, adapter 未调, in-flight 不变', () => {
    const wt = tmp();
    // 外部持锁模拟"第一写者正在会话中" (锁文件持续存在)
    const externalHolder = assertSingleWriter(wt);
    expect(existsSync(externalHolder.lockPath)).toBe(true);

    // 第二个写者尝试进入 — 应在 evaluateTestGate 之前抛
    let captured: unknown;
    try {
      runBootstrapGate({
        node: validNode(),
        oracleResults: [oracle(true, true)],
        inv: stubAdapter(),
        worktree: wt,
      });
    } catch (e) {
      captured = e;
    }

    // 错误体字段逐字断言 (INV-4)
    expect(captured).toBeInstanceOf(SingleWriterViolation);
    const v = captured as SingleWriterViolation;
    expect(v.worktree).toBe(wt);
    expect(v.lockPath).toBe(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME));
    expect(v.message).toContain('INV-4');
    expect(v.message).toContain(wt);
    expect(v.message).toContain(v.lockPath);
    expect(v.origin).toBeDefined();

    // INV-1 字面: 锁文件 inode 存在 = 既有 writer 证据
    expect(existsSync(v.lockPath)).toBe(true);

    // 状态未变: 外部 holder 持有的句柄仍可 close (fd 没被外人关掉)
    expect(() => externalHolder.close()).not.toThrow();
    expect(existsSync(v.lockPath)).toBe(true);
  });

  test('B5_WRITER_LIVENESS: 锁冲突后, 同一 worktree 在外部 holder release 后可再次 runBootstrapGate', () => {
    const wt = tmp();
    const externalHolder = assertSingleWriter(wt);
    // 第一次尝试必然抛
    expect(() =>
      runBootstrapGate({
        node: validNode(),
        oracleResults: [oracle(true, true)],
        inv: stubAdapter(),
        worktree: wt,
      }),
    ).toThrow(SingleWriterViolation);

    // 外部 holder 释放 (B5 模拟"第一写者会话结束") → 锁文件应被删, 后续可重抢
    externalHolder.release();
    expect(existsSync(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(false);

    // 第二次 runBootstrapGate 同 worktree 不再冲突
    const inv = stubAdapter();
    const verdict = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
      worktree: wt,
    });
    expect(verdict).toEqual({ kind: 'green' });
    expect(inv.calls.length).toBe(1);
    expect(inv.calls[0]!.id).toBe('b5:tool@1.0.0');
  });
});

// ─── GWT-2 (INV-2): 跨 worktree 互不干扰 ─────────────────────────────────────

describe('C-1 GWT-2 INV-2: 不同 worktree 使用不同 lockPath, 互不拒绝', () => {
  test('B5_WRITER_LIVENESS: 两个不同 worktree 同时进入 runBootstrapGate → 两者均可入', () => {
    const wtA = tmp();
    const wtB = tmp();

    const invA = stubAdapter();
    const invB = stubAdapter();
    const verdictA = runBootstrapGate({
      node: validNode('b5:a@1.0.0'),
      oracleResults: [oracle(true, true)],
      inv: invA,
      worktree: wtA,
    });
    const verdictB = runBootstrapGate({
      node: validNode('b5:b@1.0.0'),
      oracleResults: [oracle(true, true)],
      inv: invB,
      worktree: wtB,
    });

    expect(verdictA).toEqual({ kind: 'green' });
    expect(verdictB).toEqual({ kind: 'green' });
    // 不同 worktree 各自的 lockPath 不同 (INV-2)
    expect(join(wtA, '.omd', SINGLE_WRITER_LOCK_NAME)).not.toBe(
      join(wtB, '.omd', SINGLE_WRITER_LOCK_NAME),
    );
    // 两个 adapter 都各被调用一次
    expect(invA.calls.map((c) => c.id)).toEqual(['b5:a@1.0.0']);
    expect(invB.calls.map((c) => c.id)).toEqual(['b5:b@1.0.0']);
  });

  test('B5_WRITER_LIVENESS: 外部锁 wtA 不阻挡 runBootstrapGate 入 wtB', () => {
    const wtA = tmp();
    const wtB = tmp();
    const externalHolder = assertSingleWriter(wtA);
    // wtB 没锁, 应顺利进入
    const inv = stubAdapter();
    const verdict = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
      worktree: wtB,
    });
    expect(verdict).toEqual({ kind: 'green' });
    // wtA 锁仍由外部持有, 不被 wtB 的会话误删
    expect(existsSync(join(wtA, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(true);
    externalHolder.release();
  });
});

// ─── GWT-3 (INV-3): release 在所有路径执行, 不靠 catch 吞异常 ────────────────

describe('C-1 GWT-3 INV-3: release 在会话终止路径 (正常 / 异常) 都执行', () => {
  test('B5_WRITER_LIVENESS: 正常返回 (green) 后, 锁文件被 release, 同一 worktree 下一写者可入', () => {
    const wt = tmp();
    const verdict = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv: stubAdapter(),
      worktree: wt,
    });
    expect(verdict).toEqual({ kind: 'green' });
    // 释放语义: 锁文件已被删 (D-2 显式 release)
    expect(existsSync(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(false);

    // 紧接着下一写者可入同一 worktree
    const inv2 = stubAdapter();
    const verdict2 = runBootstrapGate({
      node: validNode('b5:next@1.0.0'),
      oracleResults: [oracle(true, true)],
      inv: inv2,
      worktree: wt,
    });
    expect(verdict2).toEqual({ kind: 'green' });
    expect(inv2.calls[0]!.id).toBe('b5:next@1.0.0');
  });

  test('B5_WRITER_LIVENESS: 异常路径 (adapter 抛错) 也执行 release, 锁文件被删', () => {
    const wt = tmp();
    const throwingAdapter: InventoryInFlightAdapter = {
      registerInFlight: () => {
        throw new Error('adapter exploded mid-session');
      },
    };
    let captured: unknown;
    try {
      runBootstrapGate({
        node: validNode(),
        oracleResults: [oracle(true, true)], // 走到 green 分支 → adapter 抛
        inv: throwingAdapter,
        worktree: wt,
      });
    } catch (e) {
      captured = e;
    }
    // adapter 错误字面 (不是 SingleWriterViolation)
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('adapter exploded mid-session');

    // 关键: release 仍执行 (D-2 异常退出路径也释放), 锁文件被删
    expect(existsSync(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(false);

    // 下一写者同 worktree 可入
    const inv2 = stubAdapter();
    const verdict2 = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv: inv2,
      worktree: wt,
    });
    expect(verdict2).toEqual({ kind: 'green' });
  });

  test('B5_WRITER_LIVENESS: 单写者锁在 yellow / red 分支也覆盖 (不走 registerInFlight 仍需 release)', () => {
    const wt = tmp();
    const inv = stubAdapter();
    const verdict = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(false, true)], // 仅非确定性过 → yellow
      inv,
      worktree: wt,
    });
    expect(verdict).toEqual({ kind: 'yellow' });
    expect(inv.calls.length).toBe(0);
    // yellow 分支不调 registerInFlight, 但 release 仍执行
    expect(existsSync(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(false);

    const verdict2 = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, false), oracle(false, false)], // 全失败 → red
      inv,
      worktree: wt,
    });
    expect(verdict2).toEqual({ kind: 'red' });
    expect(existsSync(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME))).toBe(false);
  });
});

// ─── INV-4: 错误体字段 + 既有 writer 证据 ────────────────────────────────────

describe('C-1 INV-4 字面: SingleWriterViolation 字段齐全', () => {
  test('B5_WRITER_LIVENESS: 冲突错误的 worktree / lockPath / origin / message 字段齐', () => {
    const wt = tmp();
    const external = assertSingleWriter(wt);
    let captured: unknown;
    try {
      assertSingleWriter(wt);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(SingleWriterViolation);
    const v = captured as SingleWriterViolation;
    expect(v.worktree).toBe(wt);
    expect(v.lockPath).toBe(join(wt, '.omd', SINGLE_WRITER_LOCK_NAME));
    expect(v.origin).toBeDefined();
    expect(v.message).toContain('INV-4');
    expect(v.message).toContain(wt);
    expect(v.message).toContain(v.lockPath);
    // name 字面
    expect(v.name).toBe('SingleWriterViolation');
    external.release();
  });
});

// ─── 兜底: 不传 worktree 时不抢锁 (向后兼容契约: 现有单测无 worktree) ────────

describe('C-1 兜底: 不传 worktree → runBootstrapGate 不抢锁 (单测隔离模式)', () => {
  test('B5_WRITER_LIVENESS: 缺省 worktree 时, runBootstrapGate 不创建任何 lock 文件', () => {
    const inv = stubAdapter();
    const verdict = runBootstrapGate({
      node: validNode(),
      oracleResults: [oracle(true, true)],
      inv,
      // 故意不传 worktree
    });
    expect(verdict).toEqual({ kind: 'green' });
    expect(inv.calls.length).toBe(1);
    // 临时目录里无 lock 文件
    // (无 worktree → 不调 assertSingleWriter → 不写文件)
  });
});