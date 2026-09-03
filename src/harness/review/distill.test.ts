/**
 * src/harness/review/distill.test —— 蒸馏链集成测试 (切片 3: D-3 锚点闸 G-5)
 * + 切片 1: D-1 mode 感知 delta 比对在 review 报告层 re-export 面 (G-1 / G-2)。
 * + 切片 4: D-4 谎报完成闸 (G-6) 在 review 报告层 re-export 面。
 *
 * 与 anchor-check.test.ts 的分工:
 *  - anchor-check.test.ts = 单元面 (checkFindingAnchors 判据分支直测, 手造 finding 对象)
 *    + 挂点面 (runReview / runReviewSingle 出口带 anchorCheck)。
 *  - 本文件 = **真实蒸馏链**: 审查散文 → extractFindings (结构化提取 = 蒸馏) →
 *    verifyOne (取证 + 证伪裁决) → checkFindingAnchors (反幻觉闸) —— 与 run.ts 收敛层
 *    同一条链 (run.ts:224-234), 只 fake 模型调用 (send), extract/取证/闸全真。
 *    证明: 幻觉锚在真实路径里被拦 (违规样本必须红), 合法锚的证据 (file:line/claim/severity/
 *    verdict/reason) 原样保留到闸后, 不因蒸馏丢证。
 *
 * 切片 1 (D-1) 落点: distill.ts 只 re-export ../goal/delta-compare 全 API, 不另立行为
 * (单一真源, 分类矩阵在 goal 层 17 测全绿)。文件尾部的 D-1 组从 ./distill 这一面走
 * G-1 / G-2 判据 —— 验证 review 报告层挂点面与共享实现同契约。
 * 切片 4 (D-4) 落点: distill.ts 只 re-export ../plan/false-completion 全 API (词表本体 +
 * 判据单一真源在 plan 层, 已挂 dag/engine.ts judgeConductorRound), 不抄第二份。文件尾部的
 * D-4 组从 ./distill 这一面走 G-6 判据 —— 与 plan/false-completion.test.ts 的单元面
 * (直连判据逐条测) 分工: 本文件验证 review 报告层挂点面与共享实现同契约, 单一真源不漂移。
 *
 * SDD: docs/plan/2026-08-10-cairness-distill-comparison.md, D-1 + G-1 + G-2,
 * D-3 + G-5, D-4 + G-6。
 *
 * INV-2 证伪方式 (逐条写进各 test): 已知违规样本 = 散文里写死的幻觉锚 (行号越界 / 文件
 * 不存在) / 基线 pass→fail 的新失败转换 / 声称完成 ∧ 验收命令实败的谎报节点 (D-4)。
 * 蒸馏链全真跑完, 断言 red=true + 该条进 downgrades 账本 / newFailures 点名 / D-4
 * findings 带原句与失败事实行, 即当场证伪 —— 若闸缺失或判零 delta, P0 幻觉锚或新引入
 * 失败以原档流出蒸馏链, 正是 D-3 / D-1 要拦的形态。D-4 的证伪方向与 1/3 相反:
 * 闸只认词表不看退出码 → 真完成样本误伤 (假阳); 闸只认退出码不看词表 / 语气·引文·
 * 否定·归因筛缺失 → 已知谎报样本判绿或 near-miss 探针判红 (假阴 / 误伤)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFindingAnchors } from './anchor-check';
import { verifyFindings, type ReviewSendFn } from './verify';
// 验收裁决 (2026-08-11, debris 逐份终审): ./distill 报告层 re-export 面是零消费者孤儿
// (可达性教义: 写不出生产入口 = 该删不该豁免), 留 debris 分支等 O-3 报告层切片一起落
// (与 seat-doctor 面板同判)。本文件的 G-1/G-2/G-6 边界覆盖独有, 全留 —— import 直指
// 单一真源; distill.ts 回归时把这两行换回 './distill' 即恢复 re-export 面契约测试。
import { compareVerifyReports, type VerifyReport } from '../goal/delta-compare';

/** fixture cwd: 写一个 N 行文件 src/x.ts (尾随换行, 物理行数恰 N)。 */
function makeCwd(lines: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'omd-distill-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'x.ts'),
    lines === 0 ? '' : Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  );
  return dir;
}

/** 从审查散文蒸馏出结构化 finding (模拟 extract 模型的 JSON 输出, 逐条取自散文真身)。 */
function distillFromProse(content: string): { severity: string; file: string; line: number; claim: string; symbols: string[] }[] {
  const out: { severity: string; file: string; line: number; claim: string; symbols: string[] }[] = [];
  for (const m of content.matchAll(/(P0|P1)\s+([^\s:]+):(\d+)\s+—\s+(.+)/g)) {
    out.push({ severity: m[1]!, file: m[2]!, line: Number(m[3]!), claim: m[4]!.trim(), symbols: [] });
  }
  return out;
}

/** 内容路由 fake send: extract → 蒸馏散文里的 finding; verifyOne → CONFIRMED; find 层 → 无真 bug。 */
function distillSend(): ReviewSendFn {
  return (async (req: { messages: { content: string }[] }) => {
    const content = String(req.messages[0]!.content);
    if (content.includes('证伪裁决员')) return { text: 'VERDICT: CONFIRMED\n依据: fake 固定裁决。' };
    if (content.includes('下面是')) return { text: JSON.stringify(distillFromProse(content)) };
    return { text: '无真 bug。' };
  }) as unknown as ReviewSendFn;
}

/** 真蒸馏链 (run.ts 收敛层同链): 散文 → extract → 取证裁决 → 锚点闸。 */
async function runDistillChain(prose: string, cwd: string) {
  const verified = await verifyFindings([{ dimension: 'correctness', text: prose }], {
    model: 'test:verify-model',
    cwd,
    send: distillSend(),
  });
  return { verified, anchor: await checkFindingAnchors(verified, cwd) };
}

describe('D-3 蒸馏链集成 (散文 → extract → verify → 锚点闸)', () => {
  test('INV-2 样本 A: 散文声称 src/x.ts:9999 而文件仅 100 行 → 蒸馏链全真跑完, 闸红 + 降级记账', async () => {
    // 证伪方式: 闸缺失时, 这条 P0 幻觉锚经 extract→verify (CONFIRMED) 原样流出蒸馏链进终裁,
    // 无人拦; 断言 red=true + 该条进 downgrades 账本 (P0→P1) + detail 钉「文件仅 100 行」, 即当场证伪。
    const cwd = makeCwd(100);
    const { verified, anchor } = await runDistillChain('P0 src/x.ts:9999 — 空输入未防呆会抛 TypeError', cwd);

    // 蒸馏链真实跑完的证明: extract + 取证 + 裁决都发生, 不是直调闸
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verdict).toBe('CONFIRMED');
    expect(verified[0]!.file).toBe('src/x.ts');
    expect(verified[0]!.line).toBe(9999);

    expect(anchor.skipped).toBe(false);
    expect(anchor.red).toBe(true);
    expect(anchor.results[0]!.verdict).toBe('invalid-anchor');
    expect(anchor.results[0]!.detail).toContain('文件仅 100 行');
    const d = anchor.downgrades[0]!;
    expect(d.downgraded).toBe(true);
    expect(d.downgradedSeverity).toBe('P1');
    expect(d.finding.severity).toBe('P0'); // 原档不毁, 账本记原档与降级后档
  });

  test('散文指向不存在文件 → 蒸馏链拦下: invalid-anchor, P1→P2 记账', async () => {
    // 证伪方式: 散文锚 ghost.ts (仓库里没有) 若以 P1 原档流出 → 幻觉引用进终裁;
    // 断言 red=true + verdict=invalid-anchor + detail 含「不存在」即证伪。
    const cwd = makeCwd(10);
    const { anchor } = await runDistillChain('P1 ghost.ts:3 — 幽灵文件里的 bug', cwd);
    expect(anchor.red).toBe(true);
    expect(anchor.results[0]!.verdict).toBe('invalid-anchor');
    expect(anchor.results[0]!.detail).toContain('不存在');
    expect(anchor.downgrades[0]!.downgradedSeverity).toBe('P2');
  });

  test('合法锚经真实蒸馏链 → 证据原样保留: valid, 零降级, file:line/claim/severity/reason 全在', async () => {
    // 证伪方式: 蒸馏若丢证 (file/line/claim/severity 任一被截), 合法 finding 的证据链断裂,
    // 闸后无法追溯; 断言 verified 里证据字段完整 + anchor 判 valid + red=false 即证伪。
    const cwd = makeCwd(100);
    const { verified, anchor } = await runDistillChain('P1 src/x.ts:42 — 空输入未防呆会抛 TypeError', cwd);

    expect(verified).toHaveLength(1);
    const v = verified[0]!;
    expect(v.file).toBe('src/x.ts');
    expect(v.line).toBe(42);
    expect(v.claim).toContain('空输入未防呆');
    expect(v.severity).toBe('P1');
    expect(v.verdict).toBe('CONFIRMED');
    expect(v.reason).toContain('fake 固定裁决');

    expect(anchor.red).toBe(false);
    expect(anchor.downgrades).toHaveLength(0);
    expect(anchor.results[0]!.verdict).toBe('valid');
    expect(anchor.results[0]!.detail).toContain('成立');
    expect(anchor.results[0]!.finding.line).toBe(42); // 证据到闸后仍可追溯
  });

  test('混合散文 (合法锚 + 幻觉锚同批) → 账本只记违规条, 合法条证据不动 (不 一刀切)', async () => {
    // 证伪方式: 闸若整批一刀切 (全红或全放) → 混批里真 finding 被误伤或幻觉锚漏网;
    // 断言 downgrades 恰 1 条 (只含 9999 幻觉锚) + 合法条 verdict=valid 且 severity 保持 P1 即证伪。
    const cwd = makeCwd(100);
    const prose = [
      'P1 src/x.ts:42 — 空输入未防呆会抛 TypeError',
      'P0 src/x.ts:9999 — 未处理空数组会崩',
    ].join('\n');
    const { verified, anchor } = await runDistillChain(prose, cwd);

    expect(verified).toHaveLength(2);
    expect(anchor.results).toHaveLength(2);
    expect(anchor.results[0]!.verdict).toBe('valid');
    expect(anchor.results[0]!.downgraded).toBe(false);
    expect(anchor.results[0]!.finding.severity).toBe('P1'); // 合法条原档不被降级毁证
    expect(anchor.downgrades).toHaveLength(1);
    expect(anchor.downgrades[0]!.finding.line).toBe(9999);
    expect(anchor.red).toBe(true);
  });

  test('G-5 第二 Given (蒸馏链侧): 散文无 P0/P1 主张 → extract 零 finding → 整体 skipped, 零误报', async () => {
    // 证伪方式: 未填模板 (散文无真 finding 行) 若被当「锚点全部非法」红掉 → 误伤;
    // 断言蒸馏链产出 verified=[] + anchor.skipped=true + red=false, 即证伪该误报形态。
    const cwd = makeCwd(100);
    const { verified, anchor } = await runDistillChain('审查完成, 未发现 P0/P1 问题。', cwd);
    expect(verified).toHaveLength(0);
    expect(anchor.skipped).toBe(true);
    expect(anchor.red).toBe(false);
    expect(anchor.results).toHaveLength(0);
    expect(anchor.downgrades).toHaveLength(0);
  });
});

/** 快速造一份 full 模式报告 (逐 id:status)。 */
const full = (...steps: [string, 'pass' | 'fail' | 'warning'][]): VerifyReport => ({
  mode: 'full',
  steps: steps.map(([id, status]) => ({ id, status })),
});
/** changed-only 模式报告 (只列有变化的步)。 */
const changedOnly = (...steps: [string, 'pass' | 'fail' | 'warning'][]): VerifyReport => ({
  mode: 'changed-only',
  steps: steps.map(([id, status]) => ({ id, status })),
});

describe('D-1 delta 比对 — 切片 1: review 报告层 re-export 面 (G-1 / G-2)', () => {
  // 落点说明: distill.ts 对 ../goal/delta-compare 显式 re-export, 本组测试走 ./distill
  // 这一面 (而非直连 goal 层) —— 验证挂点面与共享实现同契约, 单一真源不漂移。

  test('G-1 主路 (已知违规比较): 两份 full 报告, 一步 pass→fail → new-failure, 红', () => {
    // 证伪方式: 这是已知违规比较 —— 跑批比基线差 (accept 从 pass 掉到 fail), 闸必须红。
    // 若实现缺失或判零 delta, 本次引入的失败被当老账 (S-28 形态) 静默放行; 断言
    // red=true + newFailures 点名 accept, 即当场证伪 —— 任何新闸装上后此样本不红 = 闸没生效。
    const r = compareVerifyReports(full(['accept', 'pass']), full(['accept', 'fail']));
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['accept']);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass', after: 'fail' }]);
    expect(r.total).toBe(1);
  });

  test('G-1 mode 区分 — 覆盖回退 (两侧 full, 基线 pass 步缺席) → new-failure, 红 (fail-closed)', () => {
    // 证伪: 若实现把缺席当零 delta → 漏报 —— fail-closed: 没被证明过就不算成, 引擎
    // 没跑到 accept 节点即覆盖回退, 与 D-I 同一条纪律。
    const r = compareVerifyReports(full(['accept', 'pass']), full());
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['accept']);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'new-failure', before: 'pass' }]);
  });

  test('G-1 mode 区分 — 老失败消失 (两侧 full, 基线 fail 步缺席) → skipped, 不红', () => {
    // 证伪: 若判 new-failure → 老失败消失被误报成新失败; 若判 fixed → 没跑过就宣称修好。
    const r = compareVerifyReports(full(['accept', 'fail']), full());
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'accept', kind: 'skipped', before: 'fail' }]);
  });

  test('G-1 第二子句 — before 为 changed-only 且某步缺席 → skipped, 不判 new-failure', () => {
    // 证伪: 若实现判 new-failure → 误伤 —— changed-only 基线没枚举全部 step, 缺席步
    // 不能说成是本次引入的失败。
    const r = compareVerifyReports(changedOnly(['a', 'fail']), full(['a', 'fail'], ['b', 'fail']));
    expect(r.red).toBe(false);
    expect(r.newFailures).toEqual([]);
    expect(r.steps).toEqual([
      { id: 'a', kind: 'unchanged-failure', before: 'fail', after: 'fail' },
      { id: 'b', kind: 'skipped', after: 'fail' },
    ]);
  });

  test('G-1 第三子句 — after 新出现的步 → newly-run, 不判 fixed (即使跑后 fail 也不红)', () => {
    // 证伪: 若判 fixed → 假阳性修复 (基线里没有它, 谈不上修好); 若把 newly-run 判红 →
    // changed-only 首跑全红 —— 引入者是基线报告里没有的步本身, 不是本次跑批引入的失败。
    const r = compareVerifyReports(full(['a', 'pass']), full(['a', 'pass'], ['b', 'fail']));
    expect(r.red).toBe(false);
    expect(r.steps).toEqual([{ id: 'b', kind: 'newly-run', after: 'fail' }]);
  });

  test('G-2 反向 — 两份完全相同的 full 报告 → 零 new-failure, 不红', () => {
    // 证伪: 若实现把无变化跑批判红 → 每批都红, 闸失去「只报新失败」的意义。
    const r = compareVerifyReports(full(['a', 'pass'], ['b', 'pass']), full(['a', 'pass'], ['b', 'pass']));
    expect(r.red).toBe(false);
    expect(r.newFailures).toEqual([]);
    expect(r.steps).toEqual([]);
    expect(r.total).toBe(2); // 零 delta 的步仍在报告里, 只是没变化
  });

  test('unchanged — 多步批里 pass→pass 零 delta: 只点新失败的名, 其余不误伤', () => {
    // 证伪: 若实现整批一刀切 → 混批里 unchanged 步被误伤或新失败漏网; 断言 steps 恰
    // 2 条 (b 新失败 + c 老失败), a 的 pass→pass 零 delta 不进 steps 但计入 total。
    const r = compareVerifyReports(
      full(['a', 'pass'], ['b', 'pass'], ['c', 'fail']),
      full(['a', 'pass'], ['b', 'fail'], ['c', 'fail']),
    );
    expect(r.red).toBe(true);
    expect(r.newFailures).toEqual(['b']);
    expect(r.steps).toEqual([
      { id: 'b', kind: 'new-failure', before: 'pass', after: 'fail' },
      { id: 'c', kind: 'unchanged-failure', before: 'fail', after: 'fail' },
    ]);
    expect(r.total).toBe(3);
  });
});
