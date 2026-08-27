/**
 * accept 基线赦免 · 接线层契约 (SDD 片 2)。
 *
 * 片 1 (`accept-baseline.ts`) 已经钉了取末环纯函数本身;本片钉它**真的接到了** `runGoal`
 * 的批前基线捕获处 —— 否则 `makeBaselineWaiver` 在直通档下还是会吃到空失败集, 赦免恒返 null,
 * 旧的形状一字不松。
 *
 * 三组断言:
 *  - INV-4 接线 · 源码面: `runGoal` 里那条基线 commandRunner 调用, 命令参数走的是
 *    `baselineCommandOf(acceptance.command)`, 不是 `acceptance.command` 原样。
 *    改了源码 (例如回退到 `acceptance.command`) ⇒ 本断言红;源码侧 INV-7 由
 *    `git diff --stat -- <本测试路径>` 在 RED/IMPL 边界钉, 不重复。
 *  - INV-5 赦免语义一字不动: `makeBaselineWaiver` 对四组输入给出四组结论。
 *    任何一格反过来 (例如「新增红也赦免」) ⇒ 本断言红。
 *  - INV-6 存量不回退: 不含 `&&` 的验收命令基线捕获逐字节走同一份 `commandRunner`;
 *    改成 fail-closed (基线缺席就 bail) ⇒ 本断言红。
 *
 * 反向自检 (必须真跑一次, 红了才算闸活着):
 *  - ① 把 `runGoal` 里那次 commandRunner 调用的命令改回 `acceptance.command` ⇒ 「INV-4 接线」红。
 *  - ② 把 `makeBaselineWaiver` 的子集判据改成「任意 in baseline」 ⇒ 「INV-5 ②」红 (c 是新红)。
 *  - ③ 把 `makeBaselineWaiver` 的非空判据删掉 (空集也返注记) ⇒ 「INV-5 ④」红。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeBaselineWaiver } from './run-goal';

const RUN_GOAL_SRC = join(import.meta.dir, 'run-goal.ts');

// ─────────────────────────────────────────────────────────────────────────
// INV-4 接线 · 源码面: 基线命令确实走了片 1 的取末环函数
// ─────────────────────────────────────────────────────────────────────────

describe('INV-4 接线 · 源码面: 基线 commandRunner 调用走 baselineCommandOf', () => {
  test('run-goal.ts 引入 baselineCommandOf (片 1 的取末环纯函数)', () => {
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    expect(src).toMatch(/from\s+['"]\.\/accept-baseline['"]/);
    expect(src).toMatch(/baselineCommandOf/);
  });

  test('批前基线 commandRunner 调用传的是 baselineCommandOf(acceptance.command), 不是 acceptance.command 原样', () => {
    // 拦形: 形如 `commandRunner({ command: baselineCommandOf(acceptance.command) })`
    // 反向钉 (反向自检 ①): 把基线调用改回 `acceptance.command` ⇒ baselineCommandOf 不再出现 ⇒ 红。
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    // 至少有一处 `commandRunner({ command: baselineCommandOf(` 出现 (基线调用走片 1 函数)
    expect(src).toMatch(/commandRunner\(\s*\{\s*command:\s*baselineCommandOf\(/);
  });

  test('基线失败集是空集时仍走 makeBaselineWaiver (非空 → 子集判据不变), 验收命令本身仍是 acceptance.command', () => {
    // 钉住 INV-7 零回归: 验收命令本身的推法不动 (冻结判据仍吃 acceptance.command),
    //   基线命令的推法才换 (走 baselineCommandOf)。
    // 形如: freezeCriterion: { command: acceptance.command, ... }
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    expect(src).toMatch(/freezeCriterion:\s*\{\s*command:\s*acceptance\.command/);
    // 兜底: makeBaselineWaiver 仍被调用
    expect(src).toMatch(/makeBaselineWaiver\(/);
  });

  test('基线 commandRunner 抛错仍走 fail-open 兜底 (D-4): catch 里 logger.warn 含原文', () => {
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    // catch 块必须在 (基线捕获这条路上); catch 里至少一行 logger.warn 带命令原文
    // 形如: `} catch (err) {\n  logger.warn({ command: ...err: ... }, ...)`
    expect(src).toMatch(/D-1 基线跑不起来/);
    expect(src).toMatch(/fail-open/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-5 赦免语义一字不动: makeBaselineWaiver 仍是「非空 ∧ 子集 → 赦免;空集 / 新失败 → null」
// ─────────────────────────────────────────────────────────────────────────

describe('INV-5 赦免语义一字不动 · 四格矩阵', () => {
  // 入口: acceptance 输出里 `(fail)` 测试名集的等价文本
  // 用 (fail) 行造测试输出, 与 accept-delta.extractFailSet 同源格式
  const failText = (...names: string[]) => names.map((n) => `(fail) ${n}`).join('\n') + '\n';

  // 基线 = [a, b]
  const baseline = ['a', 'b'];
  const waiver = makeBaselineWaiver(baseline);

  test('① 当前失败集 ⊂ 基线 ([a]) → 返注记 (存量红, 全在基线)', () => {
    const out = waiver(failText('a'));
    expect(out).not.toBeNull();
    expect(out).toContain('存量红赦免');
    expect(out).toContain('a');
  });

  test('② 当前失败集 = 基线 ([a, b]) → 返注记 (存量红, 全部都在基线)', () => {
    const out = waiver(failText('a', 'b'));
    expect(out).not.toBeNull();
    expect(out).toContain('存量红赦免');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  test('③ 当前失败集含新失败 ([a, c]) → 返 null (c 是新红, fail-closed)', () => {
    // 反向自检 ②: 子集判据改成「任意 in baseline」 ⇒ 这里返非 null ⇒ 红
    const out = waiver(failText('a', 'c'));
    expect(out).toBeNull();
  });

  test('④ 当前失败集为空 (文本里无 (fail) 行) → 返 null (fail-closed)', () => {
    // 反向自检 ③: 非空判据删掉 (空集也返注记) ⇒ 这里返非 null ⇒ 红
    const out = waiver(failText());
    expect(out).toBeNull();
  });

  test('⑤ 当前失败集与基线全不相交 ([c, d]) → 返 null (全是新红)', () => {
    const out = waiver(failText('c', 'd'));
    expect(out).toBeNull();
  });

  test('⑥ 基线为空时, 任何失败集都返 null (空集是 fail-closed, 一致行为)', () => {
    // 守卫: 「基线为空 = 赦免本就不该成立」, 与 SDD D-3 一致
    const emptyBaseline = makeBaselineWaiver([]);
    expect(emptyBaseline(failText('a'))).toBeNull();
    expect(emptyBaseline(failText('a', 'b'))).toBeNull();
    expect(emptyBaseline(failText())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INV-6 存量不回退: 非直通档 (验收命令不含 &&) 与 fail-open 兜底逐字不变
// ─────────────────────────────────────────────────────────────────────────

describe('INV-6 存量不回退 · 非直通档走同一份 commandRunner, 失败仍 fail-open', () => {
  test('run-goal.ts: 非直通档的验收命令不含 && ⇒ baselineCommandOf 原样返回 ⇒ 与修法前同源', () => {
    // 取末环函数对不含 && 的输入原样返回 (INV-2)。这条已经由片 1 的 accept-baseline.test.ts 钉;
    // 这里只验证接线点的兜底分支 (commandRunner 缺席 / 抛错) 行为不变:
    // 仍是 `if (acceptance.kind === 'executable' && config.dag.commandRunner)`, 不是把它改成
    // fail-closed `if (!baselineSide) bail(...)`。
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    expect(src).toMatch(/acceptance\.kind\s*===\s*['"]executable['"]\s*&&\s*config\.dag\.commandRunner/);
    // 基线缺席时 waiveRed 仍是 undefined, 不是 bail
    expect(src).toMatch(/waiveRed\s*=\s*baselineSide\s*!==\s*undefined/);
  });

  test('run-goal.ts: 验收命令本身的推法不动 (freezeCriterion.command 仍取 acceptance.command)', () => {
    // 这条是 INV-7 零回归的一半: 验收命令走 `acceptCommandFromBreakdown` 出来的原值,
    //   修法只换「批前量基线的那一次 commandRunner 调用」。
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    // 形状: `command: acceptance.command` 在 freezeCriterion 上
    expect(src).toMatch(/freezeCriterion:\s*\{\s*command:\s*acceptance\.command/);
  });

  test('run-goal.ts: catch 里仍走 logger.warn (D-4 fail-open 不吞证据), 没改成 bail/throw', () => {
    // 改 fail-closed (catch 里 bail) ⇒ 基线缺席就拒起跑, 那是 SDD 明令禁止的方向。
    // 整文件扫: catch 后到下一个 `}` 段 (catch 块) 必须有 logger.warn + 不能有 bail(
    const src = readFileSync(RUN_GOAL_SRC, 'utf8');
    // 拦存在 (catch 块 + warn line + bail 缺席) 的最小签名
    expect(src).toMatch(/} catch \(err\) \{[\s\S]*?D-1 基线跑不起来[\s\S]*?logger\.warn/);
    // bail 改 fail-closed ⇒ 红 (catch 段里不得出现 bail 调起跑)
    const catchChunk = src.split(/(?=\} catch \(err\) \{)/).find((s) => s.includes('D-1 基线跑不起来')) ?? '';
    expect(catchChunk).toMatch(/logger\.warn/);
    expect(catchChunk).not.toMatch(/\bbail\(/);
  });
});