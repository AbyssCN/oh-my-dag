/**
 * debug-plan No-silent-caps (C-3) —— redEvidence 超 2000 字符时补告示 + 全文指针;
 * 未超界路径与今天 hypothesisListerGoal 逐字节相同 (零回归)。
 *
 * 对应 docs/plan/2026-08-23-判词写盘与两个No-silent-caps缺口-执行契约.md §C-3 · D-6。
 * 与 §片 2 (agent-tools spill) 同源同形, 参照物 = `capFanin` / `renderHandoff` 的
 * 「告示 + 全文路径」写法。
 *
 * GWT:
 *   G  redEvidence 长 3000 字符
 *   W  渲染 hypothesis lister goal (经 compileDebugPlan)
 *   T  ① 含截断告示;② 含全文指针路径;③ 该路径文件内容 === redEvidence 全文
 *
 *   G  redEvidence 长 500 字符
 *   W  同上
 *   T  ① 与今天 hypothesisListerGoal 输出**逐字节相同** (零回归)
 *
 * ⚠ 强约束 (契约 §片 3 末尾):「实装前天然红, 不许删/注释/回滚已实现行为来制造红」。
 * 本测试在当前实装下因 ① `goal` 无 `截断` 字样 ② 无 .txt 路径 ③ 文件不存在
 * 三处同时红 —— 都是缺失能力, 不是被改造的现状。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  compileDebugPlan,
  HYPOTHESES_NODE_ID,
  type DebugPlanOptions,
} from './debug-plan';

const BASE = {
  failure: 'GET /orders 返回别人的订单 (scope 过滤缺失?)',
  cgAvailable: true,
} as const;

/** 从 plan 里把 hypothesis lister goal 抠出来 —— 与 debug-plan.test.ts 同款导航。 */
function listerGoal(opts: DebugPlanOptions): string {
  const plan = compileDebugPlan(opts);
  return (plan.nodes[HYPOTHESES_NODE_ID] as unknown as {
    map: { lister: { goal: string } };
  }).map.lister.goal;
}

/**
 * 镜像今天 `hypothesisListerGoal` 的 ≤2000 字符分支 (实装 src/harness/debug/debug-plan.ts:70-72):
 * `redEvidence.trim()` 非空 → 直接嵌全文 (无截断);为空 → `(无 --repro 复现证据...)` 占位。
 *
 * 只服务「零回归」用例 —— 断言新实现与今天**逐字节相同**, 不许 wrapper 加告示/改措辞/改格式。
 * 若实现改 2000 阈值或改 wrapper 文本, 此基线失真 = 退化为「与今天不同」= 测试报红 = 真问题。
 */
function buildBaselineGoal500(opts: DebugPlanOptions): string {
  const red = opts.redEvidence?.trim()
    ? `\n复现拿到的确定失败证据(red):\n\`\`\`\n${opts.redEvidence.slice(0, 2000)}\n\`\`\`\n`
    : `\n(无 --repro 复现证据; 据症状描述 + 上游范围推断。)\n`;
  const avoid = opts.priorRefuted?.length
    ? [
        ``,
        `⚠️ 以下假设**前几轮已被证伪**, 不要重复提(换角度/换层想):`,
        ...opts.priorRefuted.map((h) => `  - ${h}`),
      ].join('\n')
    : '';
  return [
    `你是根因调查员。基于失败症状 + 上游锁定的范围(见 upstream), 枚举**可区分、可验证**的`,
    `根因假设。每个假设是"某处某机制导致此症状"的具体命题, 不是模糊方向。`,
    ``,
    `失败症状:\n${opts.failure}`,
    red,
    `先 step-back: 这类症状(数据不一致/超时/类型错/竞态/权限泄漏/schema 漂移/fail-open)在本栈`,
    `通常由哪层引起? 建宏观诊断框架再落具体假设, 别直接跳最"像"的。${avoid}`,
    ``,
    `输出严格 JSON(下游按 schema 扇出, 一假设一验证叶):`,
    `{ "hypotheses": [ { "id": "<短稳定 kebab id, 如 missing-scope-filter>",`,
    `  "claim": "<一句根因命题: 哪个文件/函数的什么机制导致此症状>",`,
    `  "where": "<最该查证的 file:line 或符号>" } ] }`,
    ``,
    `宁缺毋滥: 2-${opts.maxHypotheses ?? 5} 个高质量假设, 覆盖不同层/机制。`,
  ].join('\n');
}

/**
 * 给实现注入「全文写盘 + 返指针路径」的钩子 —— 实装在 DebugPlanOptions 上加
 * `saveRedFull?: (text: string) => string | null` 字段, 此处通过交叉类型声明,
 * 当前实装不读此字段 → 行为不变 → 用例如预期在 ① ② ③ 处自然红。
 *
 * 命名刻意避开 `saveFull` / `saveText` 等宽泛词 —— 与 `saveHandoffFull` / `saveFaninFull`
 * 的字面同族, 后续若并列多个「全文写盘」可收敛到一个统一签名。
 */
type OptsWithSave = DebugPlanOptions & {
  saveRedFull?: (text: string) => string | null;
};

let tmpDir: string | undefined;
function makeWriter(): NonNullable<OptsWithSave['saveRedFull']> {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'omd-debug-caps-'));
  let i = 0;
  return (text: string): string => {
    const p = join(tmpDir!, `red-evidence-${process.pid}-${i++}.txt`);
    writeFileSync(p, text, 'utf8');
    return p;
  };
}

describe('debug-plan No-silent-caps (C-3 · redEvidence 告示 + 指针)', () => {
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('redEvidence >2000 字符 → lister goal 含截断告示 + 全文指针, 指针文件含全文', () => {
    const full = 'A'.repeat(3000); // 远超 2000 阈值 —— 必触发截断分支
    const opts: OptsWithSave = { ...BASE, redEvidence: full, saveRedFull: makeWriter() };
    const goal = listerGoal(opts);

    // ① 截断告示 —— 今天 goal 内无 `截断` 字样, 此断言必红
    expect(goal).toContain('截断');

    // ② 全文指针路径 —— 与 capFanin/saveHandoffFull 同形 (.txt)。
    //    抽不到路径 = 实现未注入指针 = 红。
    const m = goal.match(/(\S+\.txt)\b/);
    expect(m).not.toBeNull();
    const pointerPath = m![1]!;
    const absPath = isAbsolute(pointerPath) ? pointerPath : resolve(process.cwd(), pointerPath);

    // ③ 指针文件存在 + 内容 === 全文 —— 这里是 C-3「全文可找回」的硬判据
    expect(existsSync(absPath)).toBe(true);
    expect(readFileSync(absPath, 'utf8')).toBe(full);

    // 防护 (post-impl 不变量): goal 不应冗余嵌全文 —— 真全文已在指针文件里,
    //   嵌进来 = 双写且违背「先抠引文/全文」的指针设计意图。
    expect(goal.includes(full)).toBe(false);
  });

  test('redEvidence ≤2000 字符 → lister goal 不含告示/指针, 与今天逐字节相同 (零回归)', () => {
    const short = 'B'.repeat(500);
    const goal = listerGoal({ ...BASE, redEvidence: short });

    // 镜像今天 hypothesisListerGoal 输出 —— 任何 wrapper 改动 (加告示/改措辞/改格式)
    //   都会让这条 toBe 红, 抓到「截断动了非截断路径」的那种回归。
    expect(goal).toBe(buildBaselineGoal500({ ...BASE, redEvidence: short }));

    // 防护: 不含任何截断告示或指针 (与今天一致)
    expect(goal).not.toContain('截断');
    expect(goal).not.toMatch(/\.txt\b/);

    // 全文 500 字符原样嵌入 (今天内嵌的就是全文, 不切)
    expect(goal).toContain(short);
  });
});
