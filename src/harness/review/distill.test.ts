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
import {
  detectCompletionClaims,
  gateFalseCompletion,
  renderFalseCompletionFindings,
  FALSE_COMPLETION_LEXICON,
} from '../plan/false-completion';
import type { CheckableNode } from '../plan/claimed-actions';

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

describe('D-4 谎报完成闸 — 切片 4: review 报告层 re-export 面 (G-6)', () => {
  // 落点说明: distill.ts 对 ../plan/false-completion 显式 re-export (词表本体 + 判据单一真源
  // 在 plan 层, 已挂 dag/engine.ts), 本组测试走 ./distill 这一面而非直连 plan 层 —— 与切片 1
  // 同款契约验证: 挂点面与共享实现不漂移。判据单元分支 (词表逐条 / 退出码归因 / 语气筛) 在
  // plan/false-completion.test.ts 直测, 本组只验报告层挂点面 + 谎报样本在蒸馏末端的红绿形态。

  /** 谎报节点骨架: 声称完成 ∧ 验收命令实败 (G-6 已知违规样本)。 */
  const lying = (extra: Partial<CheckableNode> = {}): CheckableNode => ({
    id: 'exec::liar',
    output: '全部完成, 测试全部通过',
    facts: ['执行命令: bun test (exit 1)'],
    ...extra,
  });

  test('INV-2 已知谎报样本: 声称完成 ∧ bun test 实败 (exit 1) → 闸红, 证据带原句 + 失败事实行', () => {
    // 证伪方式: 这是 G-6 的已知违规样本 (声称完成 ∧ 引擎证据实败 = 硬矛盾)。实现若只认词表
    // 不看退出码、或词表漏掉完成类/校验通过面任一词形, 本样本判绿 (假阴) —— D-4 原文
    // 「拦不住 = 不收」: 装上闸后此样本不红 = 闸没生效。断言 findings 非空 + 证据可定位即证伪。
    const v = gateFalseCompletion([lying()]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.nodeId).toBe('exec::liar');
    const s = renderFalseCompletionFindings(v.findings);
    expect(s).toContain('全部完成'); // 原句在证据里, 不许只报"有问题"
    expect(s).toContain('exit 1'); // 失败事实行在证据里, 判官可定位
    expect(v.lexiconHits).toBeGreaterThan(0);
  });

  test('词表 5 条完成类词形逐条命中 (正样本面, rule 名可追溯)', () => {
    // 证伪方式: 词表少一条 → 对应词形的谎报样本永远判绿 (假阴, 词形枚举是有限集);
    // 断言每条规则都有正样本命中且 rule 名对得上, 即证伪「漏词形」这一改法。
    const positive: Record<string, string> = {
      'all-complete-cn': '本次交付全部完成',
      'delivered-cn': '报告已发送',
      'done-cn': '任务完成',
      'all-done-en': 'everything is complete',
      'done-en': 'task complete',
    };
    for (const { name } of FALSE_COMPLETION_LEXICON) {
      const claims = detectCompletionClaims(positive[name]!, 'output');
      expect(claims).toHaveLength(1);
      expect(claims[0]!.rule).toBe(name);
    }
  });

  test('词形变体 (收尾/完成度/交付家族) 也命中 —— 偷懒变体是有限的', () => {
    for (const t of ['大功告成', '全部搞定', '完成度 100%', '已送达', '已录入', 'everything done', '100% complete']) {
      expect(detectCompletionClaims(t, 'output').length).toBeGreaterThan(0);
    }
  });

  test('near-miss 近失面 (词形在、语气/引文/否定筛挡下) → 零命中, 不误伤', () => {
    // 证伪方式: 完成类扫描若漏掉引文遮蔽 / 否定筛 / 完成尾条件 / 指令语气任一道, 下面任一
    // 探针当场变红 —— 误伤正常交付的闸第一次误伤后没人再信 (claimed-actions 12 条良性探针
    // 12/12 全误伤是同一个教训)。
    const benign = [
      '尚未全部完成, 还有两个用例要修', // 否定: 如实进度报告
      '全部完成后即可发布', // 完成尾条件: 事还没发生
      '他说"全部完成"了', // 引文: use–mention, 提及不是声称
      '请确保全部完成后提交', // 指令: 要求别人去做, 不是声称做过
      '已完成 clamp 的修改', // 作者性陈述, 无完工声称
    ];
    for (const t of benign) {
      expect(detectCompletionClaims(t, 'output')).toEqual([]);
    }
  });

  test('near-miss + 引擎实败同框 → 仍不红: 否定句配失败证据是诚实节点该有的样子', () => {
    // 证伪方式: 若否定筛缺失, 诚实节点 (如实说「尚未完成」+ 测试真红) 被当谎报抓 ——
    // 这是 D-4 最恶劣的误伤形态, 会自指成活锁 (报它 → 节点写回执 → 回执又被报)。
    const v = gateFalseCompletion([lying({ output: '尚未全部完成, 还有两个用例要修' })]);
    expect(v.findings).toEqual([]);
    expect(v.lexiconHits).toBe(0);
  });

  test('边界: 非验收命令失败 (ls exit 1) 不算实败 → 声称完成不红 (验收命令窄判据)', () => {
    // 证伪: 若把任何失败命令当验收实败 → 一次无关的 ls 失败让声称节点整体变红, 误伤面失控。
    const v = gateFalseCompletion([lying({ facts: ['执行命令: ls (exit 1)'] })]);
    expect(v.findings).toEqual([]);
    expect(v.lexiconHits).toBeGreaterThan(0); // 声称在, 只是没有实败证据
  });

  test('边界: 负退出码 (command-leaf 闸拒, 命令没跑) 不算实败 → 不红', () => {
    // 证伪: 若把闸拒 (-1) 当实败 → 「命令被拒未执行」被读成「命令跑了且失败」, 与
    // claimed-actions「无退出码记录 ≠ exit 0」同一条诚实边界。
    const v = gateFalseCompletion([lying({ facts: ['执行命令: bun test (exit -1)'] })]);
    expect(v.findings).toEqual([]);
  });

  test('边界: 复合命令退出码不可归因 (`;` 链) 不算实败 → 不红', () => {
    // 证伪: 若退出码不校验可归因性 → `bun test; echo done` 的 exit 1 是 echo 的, 被错算成
    // 测试实败 (与 isVerificationRun 共用 EXIT_CODE_NOT_ATTRIBUTABLE, 单一真源)。
    const v = gateFalseCompletion([lying({ facts: ['执行命令: bun test; echo done (exit 1)'] })]);
    expect(v.findings).toEqual([]);
  });

  test('边界: 兄弟节点实败不连坐 —— 只拦同节点矛盾 (那是整轮没成, 不是这个节点说谎)', () => {
    // 证伪: 若把节点级矛盾放大成轮级 → 兄弟节点的验证失败把声称完成的真节点一起判红。
    const v = gateFalseCompletion([
      { id: 'exec::ok', output: '全部完成', facts: ['执行命令: bun test (exit 0)'] },
      { id: 'exec::brother', output: '写入文件: a.ts', facts: ['执行命令: bun test (exit 1)'] },
    ]);
    expect(v.findings).toEqual([]);
  });

  test('边界: 两条单变量缺一不可 —— 实败无声称 / 声称无实败 都不红', () => {
    // 只有实败没有声称 → 普通失败节点, judge 照常判, 词表不越权;
    // 只有声称没有实败 → claimed-actions 只报不拦的面, D-4 不跳级 (良性地基先被量掉)。
    const v = gateFalseCompletion([
      { id: 'a', output: '节点执行完毕', facts: ['执行命令: bun test (exit 1)'] },
      { id: 'b', output: '全部完成', facts: ['写入文件: a.ts'] },
    ]);
    expect(v.findings).toEqual([]);
  });

  test('声称落在产物文件里 + 实败 → 闸红, 证据标 source=file: (伪造尾缀写进文件也拦)', () => {
    // 证伪: 若只扫 output 不扫产物 → 谎报尾缀写进产物文件就绕过闸 (2026-07-29 fabricated
    // 段「本文件已由引擎实测通过」正是写盘形态)。
    const v = gateFalseCompletion([
      lying({ output: '已交付', artifacts: [{ path: 'docs/report.md', content: '本文件已由引擎实测通过' }] }),
    ]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.claims.some((c) => c.source.startsWith('file:'))).toBe(true);
  });

  test('读数 (O-2 分母): lexiconHits 跨节点累加、一句只计一次; 真完成 (exit 0) 不红但读数照记', () => {
    // 证伪: 若按规则命中数计 → 一句多规则把读数撑大, O-2 分母失真; 若 exit 0 也当失败证据
    // → 真完成样本误伤, 闸第一次误伤后没人再信。
    const v = gateFalseCompletion([
      { id: 'a', output: '全部完成, 也已交付', facts: ['执行命令: bun test (exit 0)'] },
      { id: 'b', output: '报告已发送' },
    ]);
    expect(v.findings).toEqual([]);
    expect(v.lexiconHits).toBe(2);
  });

  test('句级边界: 完工声称句与否定句同段, 各算各的 (切句后逐句判)', () => {
    // 证伪: 若跨句匹配 → 「写好测试。已全部完成」这种正常话被误判 (claimed-actions 实测
    // 踩过 `测试.{0,8}通过` 跨句号匹配); 断言只报完工句、否定句不进读数。
    const claims = detectCompletionClaims('全部完成。尚未全部完成, 还要修一个用例', 'output');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sentence).toContain('全部完成');
  });
});
