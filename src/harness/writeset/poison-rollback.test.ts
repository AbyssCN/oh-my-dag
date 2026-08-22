/**
 * 毒集回滚的反向自检。**这类函数的错法是静默的** —— 删错一个文件没有任何别的测试会红,
 * 人也要过很久才发现。所以五条与门**每一条单独一个红样本**:去掉那一条,对应的用例当场红。
 *
 * 正样本取自 run 1c9a4566 的真实形状:新建的屏文件、有 artifactHashes、HEAD 里不存在。
 */
import { describe, expect, test } from 'bun:test';
import { planPoisonRollback, type DroppedArtifact, type PoisonRollbackDeps } from './poison-rollback';

const ROOT = '/repo';
const HASH = 'aaaa1111';

/** 默认世界: 文件在盘上、hash 与 checkpoint 一致、HEAD 里没有(= 本次跑新建的)。 */
const deps = (over: Partial<PoisonRollbackDeps> = {}): PoisonRollbackDeps => ({
  hashOf: () => HASH,
  existsInHead: () => false,
  ...over,
});

const dropped = (over: Partial<DroppedArtifact> = {}): DroppedArtifact[] => [
  {
    node: 's09_voice',
    outputPaths: ['apps/mobile/src/features/voice/VoiceCommandScreen.tsx'],
    artifactHashes: { 'apps/mobile/src/features/voice/VoiceCommandScreen.tsx': HASH },
    ...over,
  },
];

const P = 'apps/mobile/src/features/voice/VoiceCommandScreen.tsx';

describe('planPoisonRollback —— 五条与门', () => {
  test('★ 正样本: 被否决节点新建的产物, 逐字未变, HEAD 里没有 → 撤', () => {
    // 这就是 run 1c9a4566 的形状。撤了它, 重跑的 leaf 才真有活干。
    // 怎么让它红: 把 planPoisonRollback 改成恒返空 remove → 这条红。
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps());
    expect(r.remove).toEqual([{ path: P, node: 's09_voice' }]);
    expect(r.skipped).toEqual([]);
  });

  test('★ 与门③ git 跟踪的既有文件 + **无基线** → 不撤(撤它可能连起跑前的未提交改动一起抹掉)', () => {
    // 这是整个模块最重要的一条护栏, 理由见 rollback-anchor.ts 的 `dirty-tracked` 那一态。
    // 怎么让它红: 删掉 existsInHead 那个分支 → 跟踪文件被撤, 这条红。
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps({ existsInHead: () => true }));
    expect(r.remove).toEqual([]);
    expect(r.restore).toEqual([]); // 无基线时 restore 恒空 —— 别把"没接线"读成"零跟踪文件"
    expect(r.skipped[0]!.why).toContain('git 跟踪');
  });

  test('★ 与门② 盘上内容与该节点写完时不同 → 不撤(有别的东西碰过, 不猜是谁的)', () => {
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps({ hashOf: () => 'bbbb2222' }));
    expect(r.remove).toEqual([]);
    expect(r.skipped[0]!.why).toContain('有别的东西碰过');
  });

  test('★ 与门② checkpoint 没记 hash → 不撤(证不出盘上这份是它写的)', () => {
    // 缺席 ≠ 允许。没有证据就不动 —— 同「拿不准一律不报」。
    const r = planPoisonRollback(dropped({ artifactHashes: {} }), new Set(), ROOT, deps());
    expect(r.remove).toEqual([]);
    expect(r.skipped[0]!.why).toContain('没记这个路径的 hash');
  });

  test('★ 与门④ 还有存活节点声明写它 → 不撤(别毁掉仍然作数的活)', () => {
    const r = planPoisonRollback(dropped(), new Set([P]), ROOT, deps());
    expect(r.remove).toEqual([]);
    expect(r.skipped[0]!.why).toContain('仍然作数');
  });

  test('★ 与门⑤ 越界路径 / `.omd/` → 一律不撤', () => {
    const out = planPoisonRollback(
      [{ node: 'n', outputPaths: ['../../etc/passwd', '.omd/dag-runs.db'], artifactHashes: { '../../etc/passwd': HASH, '.omd/dag-runs.db': HASH } }],
      new Set(),
      ROOT,
      deps(),
    );
    expect(out.remove).toEqual([]);
    expect(out.remove).toEqual([]);
    expect(out.skipped[0]!.why).toContain('repo 根之外');
    expect(out.skipped[1]!.why).toContain('引擎自己的留痕库');
  });

  test('盘上已经没有这个文件 → 无需撤, 但仍留一行(「没撤」与「没这条路径」不许长得一样)', () => {
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps({ hashOf: () => null }));
    expect(r.remove).toEqual([]);
    expect(r.skipped[0]!.why).toContain('无需撤');
  });

  // ── 2026-08-21 跟踪文件那一半 (run 58df6b9e 复盘): 有轮基线才敢动, 且动法是"还原"不是删 ──
  //
  // 那一跑 9 条声明产物**全是**跟踪文件 → 全部「没撤」→ 重跑的 leaf 看见实装还在,
  // 判「已经做完了」, 一次写工具都没用 → empty-artifact → 5 个下游 dep-skip。
  test('★ 跟踪文件 + 有轮基线 → 落 restore(不是 remove), 且 remove 必须为空', () => {
    // 怎么让它红: 把 `restore.push` 改成 `remove.push` → 跟踪文件被**删掉**而不是还原, 这条红。
    // 两者分开列的理由: 删错 = 丢新写的活, 还原错 = 覆盖既有代码, 失败模式不同。
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps({ existsInHead: () => true }), 'base1234');
    expect(r.restore).toEqual([{ path: P, node: 's09_voice' }]);
    expect(r.remove).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  test('★ 跟踪文件 + 有轮基线, 但盘上内容被别人碰过 → 仍然不动(② 必须排在 ③ 前面)', () => {
    // 这条钉的是 2026-08-21 那次**闸序调整**本身。原先 ③ 先判, 跟踪文件在"有没有被别人碰过"
    // 上从来没被问过。怎么让它红: 把 ② 挪回 ③ 后面 → 这条落进 restore, 断言红。
    const r = planPoisonRollback(dropped(), new Set(), ROOT, deps({ existsInHead: () => true, hashOf: () => 'bbbb2222' }), 'base1234');
    expect(r.restore).toEqual([]);
    expect(r.remove).toEqual([]);
    expect(r.skipped[0]!.why).toContain('有别的东西碰过');
  });

  test('★ 与门④ 对 restore 一样管用: 存活节点还声明写它 → 连还原都不许', () => {
    // 还原会把存活节点这一轮写进去的内容一起冲掉 —— 与 remove 同一条理由, 不许因为
    // "还原听起来比删温和"就放行。怎么让它红: 把 ④ 挪到 ③ 后面 → 这条落进 restore。
    const r = planPoisonRollback(dropped(), new Set([P]), ROOT, deps({ existsInHead: () => true }), 'base1234');
    expect(r.restore).toEqual([]);
    expect(r.skipped[0]!.why).toContain('仍然作数');
  });

  test('同一路径被两个被毒节点声明 → 只判一次(别删两遍, 也别留两条自相矛盾的证据)', () => {
    const two: DroppedArtifact[] = [
      { node: 'a', outputPaths: [P], artifactHashes: { [P]: HASH } },
      { node: 'b', outputPaths: [P], artifactHashes: { [P]: HASH } },
    ];
    const r = planPoisonRollback(two, new Set(), ROOT, deps());
    expect(r.remove).toHaveLength(1);
    expect(r.remove[0]!.node).toBe('a');
  });
});
