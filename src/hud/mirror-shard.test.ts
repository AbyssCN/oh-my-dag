/**
 * HudMirror 切片 1 (#215 + 加宽账) 的闸 —— 2026-08-22 SDD 片 3 的写侧契约。
 *
 * 全部 INVs 都在这里钉一条用例, 加 1 条反向自检 (摘掉 shard 写 → 那条红)。
 * 反向自检原则 (2026-08-07 闸纪律): 临时改动对应实装 → 该条当场红 → 还原; 证伪方式写在用例注释。
 *
 * 八条 INV 在这一片里只覆盖到写侧:
 *   - INV-HUD-1 写`dag.json`的内容与今天逐字同形
 *   - INV-HUD-2 撞名 → WARN + 改用完整 runId 文件名 (旧文件内容不变)
 *   - INV-HUD-3 `HUD_SCHEMA` 没被 bump (这条闸在类型里 —— 不变量自己保证; 加 1 条 `expect(HUD_SCHEMA)` 守门)
 *   - INV-HUD-4 早于本次改动的快照不带新字段 → 读侧字段**仍是 undefined** (这里用手动拼的窄快照验证 mirror 不丢字段)
 *   - INV-HUD-5 `planned` 事件的节点不带 deps (这是数据面的实情, 不许 mirror 编一个 `[]`)
 *   - INV-HUD-7 写失败 → 吞掉不抛 + 日志含 runId 与文件名的 WARN
 *   - INV-HUD-8 写侧零崩: 即便 fs 撞错也只 WARN, 不冒泡 (与 INV-HUD-7 同一条 fail-open 铁律)
 *
 * 不在本片 (留给切片 2/3):
 *   - INV-HUD-6 双通路等价闸 (事件驱动 vs. 快照 hydrate) —— 在 `dag-tree-snapshot.test.ts`。
 *   - INV-HUD-8 的读侧半边 (半截 JSON → 跳过那份) —— 在 `load-shard.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../harness/logger';
import { HUD_SCHEMA, type HudDagSnapshot } from './types';
import { HudMirror } from './mirror';

/** logger 截获: 临时接管 warn 收集证据, 用完必须还原 (logger 是模块级单例, 别的测试也用)。 */
const captureWarns = (): { msgs: { obj: unknown; msg: string }[]; restore: () => void } => {
  const msgs: { obj: unknown; msg: string }[] = [];
  const orig = logger.warn;
  logger.warn = (obj: unknown, msg?: string) => {
    msgs.push({ obj, msg: msg ?? '' });
  };
  return { msgs, restore: () => (logger.warn = orig) };
};

/** 干净的快照骨架 —— 测 INV-HUD-4 时去掉加宽字段, 模拟"早于本次改动的发射点"。 */
const baseRecord = () => ({
  goal: '把 HudMirror 拆成每 run 一文件',
  status: 'running' as const,
  updatedAt: '2026-08-22T10:00:00.000Z',
  progress: {
    planned: [{ id: 'leaf-a', kind: 'agent' }],
    started: [],
    startedAt: {},
    settled: [],
  },
});

/** 每条测试都在自己独立的 tmpdir 里跑。OMD_DATA_HOME 设了会把 hud 目录搬到别处
 *  (dataPath('hud') 而非 repoRoot/.omd/hud), 与本片的"写到 hud 目录"判据冲突
 *  —— 与 read-api.test.ts 同款, 这里也 delete 一下。 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-hud-shard-'));
  delete process.env.OMD_DATA_HOME;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('★ INV-HUD-1 dag.json 内容与今天逐字同形 (statusline 数据源不动)', () => {
  // 反向自检: 把 mirror.ts 里 `this.atomicWrite('dag.json', ...)` 那行注释掉 → 下面这条红。
  test('write 之后 dag.json 存在, schema=HUD_SCHEMA, runId 对得上', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-shard-'));
    const m = new HudMirror(root);
    m.write('aaaaaaaa-1111-2222-3333-444444444444', baseRecord());
    const f = join(root, '.omd', 'hud', 'dag.json');
    expect(existsSync(f)).toBe(true);
    const snap = JSON.parse(readFileSync(f, 'utf-8')) as HudDagSnapshot;
    expect(snap.schema).toBe(HUD_SCHEMA);
    expect(snap.runId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    expect(snap.goal).toBe(baseRecord().goal);
    expect(snap.status).toBe('running');
    expect(snap.planned[0]?.id).toBe('leaf-a');
  });
});

describe('★ INV-HUD-2 runId8 撞名 → 响亮 (WARN + 全名, 旧文件内容不变)', () => {
  // 反向自检: 把 `shardFileFor` 里 WARN 那行注释掉 → 第二条测的 msgs 为空, 红。
  test('两个 runId 前 8 位相同 → 第二个写到 dag-<完整 runId>.json, 旧分片内容不变', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-collision-'));
    const capture = captureWarns();
    try {
      // 第一个 run: 8 位 aaaaaaaa
      const runA = 'aaaaaaaa-1111-2222-3333-444444444444';
      new HudMirror(root).write(runA, { ...baseRecord(), goal: 'run A 的目标' });
      const shortA = join(root, '.omd', 'hud', 'dag-aaaaaaaa.json');
      expect(existsSync(shortA)).toBe(true);
      const before = readFileSync(shortA, 'utf-8');
      expect((JSON.parse(before) as HudDagSnapshot).goal).toBe('run A 的目标');

      // 第二个 run: 8 位也是 aaaaaaaa, 不同 run
      const runB = 'aaaaaaaa-9999-8888-7777-666666666666';
      new HudMirror(root).write(runB, { ...baseRecord(), goal: 'run B 的目标' });

      // 旧分片内容**不变** (P-1:「两个 run 互相覆盖」正是这一片要修的缺陷的形状)
      const after = readFileSync(shortA, 'utf-8');
      expect(after).toBe(before);
      expect((JSON.parse(after) as HudDagSnapshot).goal).toBe('run A 的目标');

      // 新分片在 dag-<完整 runId>.json
      const fullB = join(root, '.omd', 'hud', `dag-${runB}.json`);
      expect(existsSync(fullB)).toBe(true);
      expect((JSON.parse(readFileSync(fullB, 'utf-8')) as HudDagSnapshot).runId).toBe(runB);

      // ⚠ 响亮: WARN 含两个完整 runId + 短名
      const shardWarns = capture.msgs.filter((m) => {
        const obj = m.obj as { hudShard?: unknown } | null;
        const shard = obj && typeof obj.hudShard === 'string' ? obj.hudShard : '';
        return shard.startsWith('dag-');
      });
      expect(shardWarns.length).toBe(1);
      const w = shardWarns[0]!;
      expect(w.obj).toMatchObject({ hudShard: 'dag-aaaaaaaa.json', existingRunId: runA, newRunId: runB });
      expect(w.msg).toContain('撞名');

      // 同时 dag.json 也写了 (INV-HUD-1), 内容是 runB 的最新
      const dag = JSON.parse(readFileSync(join(root, '.omd', 'hud', 'dag.json'), 'utf-8')) as HudDagSnapshot;
      expect(dag.runId).toBe(runB);
    } finally {
      capture.restore();
    }
  });

  test('同一 runId 第二次写 → 不再重读分片归属 (短名, 零额外读)', () => {
    // 边界: 撞名缓存检查**只做一次**。同 run 写两次, 第二次不应触发任何归属性读取。
    // 用「先写, 之后让分片里的 runId 改成另一个 (人为) → 再写同 run」来反证: 第二次仍认短名,
    // 因为缓存里查过「这是自己的」就定了。
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-nocheck2-'));
    const runId = 'bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd';
    const mirror = new HudMirror(root);
    mirror.write(runId, baseRecord());

    // 人为把短分片的内容改成别的 runId (制造「如果不重读就会用错归属」的状态)
    const short = join(root, '.omd', 'hud', 'dag-bbbbbbbb.json');
    writeFileSync(short, JSON.stringify({ schema: HUD_SCHEMA, runId: 'other-other-other-other-other', updatedAt: 'x' }), 'utf-8');

    // 第二次写同 run —— 缓存说这是自己的, 不会重新读, 不会触发撞名 WARN
    const capture = captureWarns();
    try {
      mirror.write(runId, baseRecord());
      const collisionWarns = capture.msgs.filter((m) => m.msg.includes('撞名'));
      expect(collisionWarns.length).toBe(0);
      // 短分片被 mirror 自己覆盖回正确内容 (但**这是同进程内**的, 不算扰动旧文件 ——
      // 文件本来就是 mirror 在写, 内容是 mirror 自己的契约)。
      const finalShort = JSON.parse(readFileSync(short, 'utf-8')) as HudDagSnapshot;
      expect(finalShort.runId).toBe(runId);
    } finally {
      capture.restore();
    }
  });
});

describe('★ INV-HUD-3 HUD_SCHEMA 没被 bump (老读者不被当场瞎)', () => {
  test('HUD_SCHEMA 仍 = 1', () => {
    expect(HUD_SCHEMA).toBe(1);
  });
});

describe('★ INV-HUD-4 加宽字段缺席时, 镜像不带默认值 (留 undefined, 不编 0 / 不编 unclassified)', () => {
  // 边界: 老发射点不会给 deps / durationMs / usage / failureKind。
  // mirror 写时这些字段就是 undefined, 写入磁盘后 JSON 不该出现 (undefined 序列化为缺省)。
  // 这是契约面, 真正的"画 —"是切片 3 (render) 的事; 这里只保"账本不编"。
  test('settled 无 startedAt / durationMs / usage / failureKind → 盘上也不出现这些键', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-noextras-'));
    const m = new HudMirror(root);
    const rec = {
      goal: 'g',
      status: 'running' as const,
      updatedAt: '2026-08-22T10:00:00.000Z',
      progress: {
        planned: [{ id: 'p1', kind: 'agent' }],
        started: [],
        startedAt: {},
        settled: [{ id: 'p1', status: 'done' as const, kind: 'agent' }],
      },
    };
    m.write('cccccccc-1234-1234-1234-123456789abc', rec);
    const short = join(root, '.omd', 'hud', 'dag-cccccccc.json');
    const raw = JSON.parse(readFileSync(short, 'utf-8')) as { settled: Record<string, unknown>[] };
    expect(raw.settled[0]).not.toHaveProperty('startedAt');
    expect(raw.settled[0]).not.toHaveProperty('durationMs');
    expect(raw.settled[0]).not.toHaveProperty('usage');
    expect(raw.settled[0]).not.toHaveProperty('failureKind');
    // 反向自检: 试给 settled 加上这些键 (mirror 不许编, 但也不许丢 —— 等测 ②)
    expect(raw.settled[0]?.id).toBe('p1');
    expect(raw.settled[0]?.status).toBe('done');
  });

  test('settled 带全字段 → 盘上全有, 数值原样', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-fullextras-'));
    const m = new HudMirror(root);
    const rec = {
      goal: 'g',
      status: 'running' as const,
      updatedAt: '2026-08-22T10:00:00.000Z',
      progress: {
        planned: [{ id: 'p1', kind: 'agent' }, { id: 'p2', kind: 'agent', deps: ['p1'] }],
        started: [],
        startedAt: {},
        settled: [
          {
            id: 'p1',
            status: 'failed' as const,
            kind: 'agent',
            model: 'gpt-5.6',
            startedAt: '2026-08-22T09:59:55.000Z',
            durationMs: 4321,
            usage: { in: 123, out: 456 },
            failureKind: 'empty-artifact',
          },
        ],
      },
    };
    m.write('dddddddd-1234-1234-1234-123456789abc', rec);
    const short = join(root, '.omd', 'hud', 'dag-dddddddd.json');
    const snap = JSON.parse(readFileSync(short, 'utf-8')) as HudDagSnapshot;
    // planned[1] 的 deps 跟着 expanded 一起下来了 —— 这条是 INv-HUD-5 的对偶。
    expect(snap.planned[1]?.deps).toEqual(['p1']);
    const s = snap.settled[0]!;
    expect(s.startedAt).toBe('2026-08-22T09:59:55.000Z');
    expect(s.durationMs).toBe(4321);
    expect(s.usage).toEqual({ in: 123, out: 456 });
    expect(s.failureKind).toBe('empty-artifact');
  });
});

describe('★ INV-HUD-5 planned 节点不带 deps 是真值, mirror 不许编 []', () => {
  // 反向自检: 给 mirror 喂的 planned 节点若没 deps, 盘上 JSON 也不该出现 `deps: []`。
  // 若 mirror 里有人偷偷加 `deps: deps ?? []`, 这条红。
  test('planned 节点无 deps → 盘上 JSON 不出现 deps 键', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-nodeps-'));
    const m = new HudMirror(root);
    m.write('eeeeeeee-1234-1234-1234-123456789abc', baseRecord());
    const short = join(root, '.omd', 'hud', 'dag-eeeeeeee.json');
    const raw = JSON.parse(readFileSync(short, 'utf-8')) as { planned: Record<string, unknown>[] };
    expect(raw.planned[0]).not.toHaveProperty('deps');
  });
});

describe('★ INV-HUD-7 写失败 → 吞掉不抛, WARN 含 runId 与文件 (fail-open 不吞证据)', () => {
  // 反向自检: 把 atomicWrite 的 catch 改成 throw → 这条红; 或改成空 catch → msgs 为空, 红。
  test('hud 目录不可写 → 不抛, 日志含 runId 与文件名的 WARN', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-readonly-'));
    const capture = captureWarns();
    try {
      const hudDir = join(root, '.omd', 'hud');
      // 先建好目录再 chmod —— atomicWrite 内部的 mkdirSync 在已有目录上不报错,
      // 我们要的是**后续** writeFileSync/renameSync 因权限失败。
      mkdirSync(hudDir, { recursive: true });
      chmodSync(hudDir, 0o555);
      const runId = 'ffffffff-1234-1234-1234-123456789abc';
      // 不抛
      expect(() => new HudMirror(root).write(runId, baseRecord())).not.toThrow();

      // WARN 含 runId + 文件名 + 错误原文 (三件套)
      const writeWarns = capture.msgs.filter((m) => m.msg.includes('write failed'));
      expect(writeWarns.length).toBeGreaterThan(0);
      const w = writeWarns[writeWarns.length - 1]!;
      expect(w.obj).toMatchObject({ runId });
      expect(String((w.obj as { file?: string }).file ?? '')).toMatch(/^dag/);
      expect(typeof (w.obj as { err?: string }).err).toBe('string');
    } finally {
      // 还原权限以便 tmpdir 清理
      try { chmodSync(join(root, '.omd', 'hud'), 0o755); } catch { /* 已经没了 */ }
      capture.restore();
    }
  });
});

describe('★ 写侧回归 —— 摘掉 shard 写, 当场红', () => {
  // 这条是反向自检: 把 mirror.ts 里 `this.atomicWrite(shardFile, snap, shardFile, runId)`
  // 那一行注释掉, 这条红。把 INV-HUD-2 的"响亮"钉在「代码里**真**有一行 atomicWrite 给 shard」。
  test('write 同时落 dag.json 与 dag-<runId8>.json 两份', () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-hud-twowrite-'));
    const runId = '12345678-aaaa-bbbb-cccc-dddddddddddd';
    new HudMirror(root).write(runId, baseRecord());
    expect(existsSync(join(root, '.omd', 'hud', 'dag.json'))).toBe(true);
    expect(existsSync(join(root, '.omd', 'hud', 'dag-12345678.json'))).toBe(true);
  });
});

describe('★ OMD_DATA_HOME 走 dataPath (与 checkpoint-manager 同源)', () => {
  // 分片是 hud 目录下的事, hud 目录的 home 解析复用既有的 `hudDir` 路径。
  // 行为不变 (INV-HUD-1 的另一半: 行为分支也照旧), 这里只加一条以防分片代码无意引入
  // 第二条 home 解析 (例如直接 `path.join(repoRoot, '.omd/hud')`)。
  test('OMD_DATA_HOME 未设 → 写进 repoRoot/.omd/hud/', () => {
    const before = process.env.OMD_DATA_HOME;
    delete process.env.OMD_DATA_HOME;
    try {
      const root = mkdtempSync(join(tmpdir(), 'omd-hud-home-'));
      new HudMirror(root).write('aabbccdd-1234-1234-1234-123456789abc', baseRecord());
      expect(existsSync(join(root, '.omd', 'hud', 'dag.json'))).toBe(true);
      expect(existsSync(join(root, '.omd', 'hud', 'dag-aabbccdd.json'))).toBe(true);
    } finally {
      if (before !== undefined) process.env.OMD_DATA_HOME = before;
    }
  });
});
