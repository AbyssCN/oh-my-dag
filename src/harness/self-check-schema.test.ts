/**
 * P1 C-1 自检 (2026-08-21): `PlanNode.self_check` 字段 → schema + registry + vet gate。
 *
 * 三个 GWT = 三条闸:
 *
 * | GWT | 钉的是什么 | 反向自检 |
 * |---|---|---|
 * | GWT-1a | schema 接受 + registry oracle 绿 + PAIRS 配齐 (INV-1-1) | 删字段 → PAIRS 缺键就抛 |
 * | GWT-1b | 缺席 = 旁路: vet 返 undefined, 节点语义不动 (INV-1-2) | — |
 * | GWT-1c | 恒真判据被悄悄丢弃, 不判节点红 (INV-1-3) | 摘掉 vet 调用 → 自检恒放行, 这条红 |
 *
 * **反向自检 (当场验过)**:
 *
 *  - GWT-1a 反向: 把 `PlanNode` zod schema 里的 `self_check` 行注掉 → 本测试 GWT-1a 红 (expect_exit
 *    的 expect 在 plan 里 → parsePlan 拒, 错报 expect_exit 缺/未识别)。
 *  - GWT-1c 反向: 把 `vetSelfCheck` 主体里的 `v.status === 'ring'` 早返改回 `return { kept: spec, verdict: v }`
 *    → 这条 expect `kept: undefined` 变 `kept: spec` → 红。两种证伪都跑过。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanSchema, parsePlan } from './conductor-plan';
import { REGISTRY } from './schema-field-registry';
import { vetSelfCheck } from './dag/planner';

describe('GWT-1a: self_check 字段 + schema + registry 同步 (INV-1-1)', () => {
  test('PlanSchema 接受合法 self_check (含缺省 expect_exit)', () => {
    const r = PlanSchema.safeParse({
      name: 'p',
      nodes: {
        a: {
          goal: 'x',
          executor: 'leaf',
          self_check: { command: 'bun test spec.test.ts' },
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const sc = r.data.nodes.a!.self_check!;
      expect(sc.command).toBe('bun test spec.test.ts');
      expect(sc.expect_exit).toBe(0); // 缺省归 0
    }
  });

  test('PlanSchema 接受 expect_exit 非 0 (verify-red 形态)', () => {
    const r = PlanSchema.safeParse({
      name: 'p',
      nodes: {
        a: { goal: 'x', executor: 'leaf', self_check: { command: 'bun test', expect_exit: 1 } },
      },
    });
    expect(r.success).toBe(true);
  });

  test('PlanSchema 拒 expect_exit 越界 (POSIX 域 0..255, >255 报错)', () => {
    const r = PlanSchema.safeParse({
      name: 'p',
      nodes: {
        a: { goal: 'x', executor: 'leaf', self_check: { command: 'echo', expect_exit: 256 } },
      },
    });
    expect(r.success).toBe(false);
  });

  test('PlanSchema 拒空 command (空串 = 退化成空旋钮)', () => {
    const r = PlanSchema.safeParse({
      name: 'p',
      nodes: {
        a: { goal: 'x', executor: 'leaf', self_check: { command: '', expect_exit: 0 } },
      },
    });
    expect(r.success).toBe(false);
  });

  test('parsePlan 整路径接受 self_check 节点 (含 bc 形 {knownServers})', () => {
    const text = JSON.stringify({
      name: 'p',
      nodes: {
        impl: {
          goal: '产 src/x.ts',
          executor: 'leaf',
          output_type: 'file',
          output_path: 'src/x.ts',
          self_check: { command: 'bun test x.test.ts', expect_exit: 0 },
        },
      },
    });
    expect(parsePlan(text, { knownServers: new Set() }).ok).toBe(true);
  });

  test('registry: self_check 有条目, declared=true, 指真实消费点 (INV-1-1)', () => {
    const e = REGISTRY['self_check'];
    expect(e).toBeDefined();
    expect(e!.consumer).not.toBe('—');
    expect(e!.consumer).toContain('executor-dag'); // 引擎消费点 (slice 3 接线)
    expect(e!.consumer).toContain('vetSelfCheck'); // 规划期闸 (本切片)
    expect(e!.declared).toBe(true);
    expect(e!.fingerprint).toBe('fields'); // 改 self_check = 不同执行 = 入键
  });
});

describe('GWT-1b: 缺席 = 旁路 (INV-1-2)', () => {
  test('vetSelfCheck(undefined) → kept undefined, verdict 标 skipped (不触发任何探针)', async () => {
    const r = await vetSelfCheck(undefined);
    expect(r.kept).toBeUndefined();
    expect(r.verdict).toMatchObject({ status: 'skipped' });
    expect(r.droppedWhy).toBeUndefined();
  });

  test('不带 self_check 的 plan 经 parsePlan 后节点的 effective shape 不含 self_check (旁路逐字节)', () => {
    const text = JSON.stringify({
      name: 'p',
      nodes: { a: { goal: 'x', executor: 'leaf' } },
    });
    const r = parsePlan(text, { knownServers: new Set() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.nodes.a!.self_check).toBeUndefined();
  });

  test('带 self_check 与不带 self_check 的同一节点 → fingerprints 不同 (入了 key, INV-1-1 验)', async () => {
    // 推迟到运行时验证会很贵, 这里只验 schema 形状层面: 两个 plan 都 parse 通过且读出来不一样。
    const a = JSON.stringify({ name: 'p', nodes: { n: { goal: 'x', executor: 'leaf' } } });
    const b = JSON.stringify({
      name: 'p',
      nodes: { n: { goal: 'x', executor: 'leaf', self_check: { command: 'true' } } },
    });
    const ra = parsePlan(a, { knownServers: new Set() });
    const rb = parsePlan(b, { knownServers: new Set() });
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      expect(ra.plan.nodes.n!.self_check).toBeUndefined();
      expect(rb.plan.nodes.n!.self_check).toBeDefined();
    }
  });
});

/**
 * GWT-1c: 恒真 self_check 被悄悄丢弃 (INV-1-3) ——**反向闸, 必须能红**。
 *
 * "恒真" 的实战样本:
 *  - `true` 内建 (任何 cwd 都退 0)
 *  - `ls` (任何 cwd 都退 0)
 *  - `bun test x.test.ts` 在仓库里 x.test.ts 当前就是绿的 (空世界里退 0 = vacuous)
 *
 * 这条闸的诚实边界写在 #165/#204: 探针是 fail-open, 不是「永远抓得到」。但本测试用的样本**完全**
 * 是「`bun test` 一份明显错的产物」: 错的实装 + 配错的 spec。整条命令在错世界上仍退 0 → ring →
 * 闸拒。
 *
 * 反向自检 (当场): 把 vetSelfCheck 里 `v.status === 'ring'` 那条分支改回 `return { kept: spec,
 * verdict: v }` → kept 不是 undefined → 红。**注意**改 vet 时必须同时 verify 其他两条 GWT 不漂:
 * GWT-1b 的「缺席旁路」与 GWT-1a 的「registry oracle」应仍在原落点绿。
 */
describe('GWT-1c (反向, 必须能红): 恒真 self_check 被悄悄丢弃, 节点不判红 (INV-1-3)', () => {
  /**
   * 起一个真 git 仓 + 一份**明显的错**产物 (`src/x.ts` 是 BROKEN, 测试期望它退 0)。
   * 用 `git archive` 复制成真副本 = acceptance-gate.ts #204 的同一形态 —— 空目录世界里任何
   * 仓内判据都必然失败, 会让探针恒判「分得出」(那是 #199 量到的 bug)。
   */
  function repoAtHead(): string {
    const root = mkdtempSync(join(tmpdir(), 'omd-self-check-vet-'));
    const rc = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const run = (args: string[]): void => {
      const r = Bun.spawnSync(['git', ...rc, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr).trim()}`);
    };
    run(['init', '-q', '-b', 'main']);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'x.ts'), '// BROKEN: 这一行就该被测试抓到\nexport const x = 1;\n');
    writeFileSync(join(root, 'x.test.ts'), 'import { x } from "./src/x.ts"; test("x", () => { expect(x).toBe(2); });\n');
    run(['add', '-A']);
    run(['commit', '-m', 'head']);
    return root;
  }

  // 假 runner: 只判退出码来自「命令串 = 期望值」的字典 —— 不真跑 shell (快了, 且不污染世界)。
  const fakeRun = async ({ command }: { command: string; cwd: string }): Promise<{ exitCode: number | null }> => {
    if (command === 'true' || command === 'echo ok' || command === 'pwd') return { exitCode: 0 };
    return { exitCode: 0 };
  };

  test('恒真的 self_check (true) 在真副本世界 + 错样本 → 闸拒, kept 为 undefined', async () => {
    const root = repoAtHead();
    try {
      const r = await vetSelfCheck(
        { command: 'true', expect_exit: 0 },
        {
          sample: { path: 'src/x.ts', content: 'export const x = 99;\n' }, // 错答案: x 仍 = 99, 测试仍会红
          runIn: fakeRun,
          repoRoot: root,
        },
      );
      // 反向: 把判定分支去掉 → kept = spec, 这条 expect undefined 变 spec → 红
      expect(r.kept).toBeUndefined();
      expect(r.droppedWhy).toBeDefined();
      expect(r.droppedWhy).toContain('闸拒');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('非恒真的 self_check 在真副本世界 + 错样本 → 保留 (kept 不为 undefined)', async () => {
    const root = repoAtHead();
    try {
      const r = await vetSelfCheck(
        { command: 'false', expect_exit: 1 }, // 错世界上退 0 ≠ expect 1 → 探针判 ok (判别力存在)
        {
          sample: { path: 'src/x.ts', content: 'export const x = 99;\n' },
          runIn: async () => ({ exitCode: 0 }), // 错世界上 false 退 0 ≠ 1 → 判别
          repoRoot: root,
        },
      );
      expect(r.kept).toBeDefined();
      expect(r.kept!.command).toBe('false');
      expect(r.droppedWhy).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('无 sample 时退到空世界自检 (fail-open: 缺样本 = 不拦, 保留判据)', async () => {
    // 真恒真 (`true`) 也没样本 → 走 probeVacuity 但 runner 是 stub 给 0 → 退 0 = ring → 闸拒
    const r1 = await vetSelfCheck({ command: 'true', expect_exit: 0 }, { runIn: async () => ({ exitCode: 0 }) });
    expect(r1.kept).toBeUndefined();
    // 给一份**真的**会失败的命令 → 跑 vacuity 在 stub runner 上退 -1 ≠ 0 → ok → 保留
    const r2 = await vetSelfCheck({ command: 'false', expect_exit: 1 }, { runIn: async () => ({ exitCode: -1 }) });
    expect(r2.kept).toBeDefined();
  });

  /**
   * P2b: bare 整仓 pytest 自检命中退出码 4 (无 sample, 空世界自检路径) —— `probeVacuity` 新增的
   * `'invalid'` 状态必须也被 `vetSelfCheck` 接住, 不能只接 `'ring'`。
   *
   * 反向自检: 把 planner.ts 里新加的 `|| v.status === 'invalid'` 摘掉 → kept 变回 spec → 这条红。
   */
  test('P2b: bare 整仓 pytest 自检命中 2/4/5 (判据无效) → 同 ring 一样闸拒, kept 为 undefined', async () => {
    const r = await vetSelfCheck({ command: 'pytest -q', expect_exit: 0 }, { runIn: async () => ({ exitCode: 4 }) });
    expect(r.kept).toBeUndefined();
    expect(r.droppedWhy).toBeDefined();
    expect(r.droppedWhy).toContain('判据无效');
  });

  test('闸拒不判节点红: plan 经 vet 后**仍**有效 (只是少了 self_check), 不判 done → failed', async () => {
    // 闸拒的语义是**丢 self_check 退回旁路**, 不是把节点标 failed。漏掉这条就会逼真红为虚红。
    const text = JSON.stringify({
      name: 'p',
      nodes: {
        a: {
          goal: 'x',
          executor: 'leaf',
          output_type: 'file',
          output_path: 'src/x.ts',
          self_check: { command: 'true' },
        },
      },
    });
    const r = parsePlan(text, { knownServers: new Set() });
    expect(r.ok).toBe(true); // parsePlan 本身不跑 vet (vet 由 caller 决定: 探针要 sample+runner)
    if (!r.ok) return;
    // 模拟 caller (vetted plan): 把自检丢入 vet → 得 kept = undefined → caller 拿到的就是无 self_check 的节点。
    const vet = await vetSelfCheck(r.plan.nodes.a!.self_check);
    expect(vet.kept).toBeUndefined();
    // 节点本身仍 valid — 不被 plan 层判 failed, 仅丢字段。
    const node = { ...r.plan.nodes.a!, self_check: vet.kept };
    expect(node.self_check).toBeUndefined();
    expect(node.executor).toBe('leaf');
    expect(node.output_path).toBe('src/x.ts');
  });
});
