import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFullstackFixture } from './fullstack';

// fixture 自检: 契约测试真落进 worktree + SPEC 指向真存在的 omd-render + oracle 只跑 eval-app。
// 一次全栈 run 是几十分钟, 不能因为 fixture 自己搭错而白烧。

const fx = await createFullstackFixture();
afterAll(() => fx.cleanup());

describe('fullstack fixture', () => {
  test('三份契约测试落进 worktree', () => {
    for (const t of fx.testPaths) expect(existsSync(join(fx.root, t))).toBe(true);
  });

  test('实现文件刻意不存在 (绿地任务, 不是重建)', () => {
    for (const f of ['board.ts', 'api.ts', 'render-board.ts']) {
      expect(existsSync(join(fx.root, 'eval-app/src', f))).toBe(false);
    }
  });

  test('SPEC 里的 omd-render 路径真存在 (写错 = 整条证据链跑不起来)', () => {
    const m = fx.spec.match(/bun run (\S+omd-render\.ts)/);
    expect(m).toBeTruthy();
    expect(existsSync(m![1]!)).toBe(true);
  });

  test('SPEC 覆盖四个 UI 状态 + 转义要求 (审查维度的来源)', () => {
    for (const k of ['empty', 'loading', 'error', '转义']) expect(fx.spec).toContain(k);
  });

  test('oracle 只跑 eval-app (不连坐本仓 1000+ 测试)', () => {
    expect(fx.oracleCmd).toContain('bun test eval-app/');
    expect(fx.oracleCmd).toContain('tsc --noEmit');
  });

  test('契约测试首刀必红 (实现不存在) —— 正是预期起点', () => {
    const t = readFileSync(join(fx.root, 'eval-app/src/board.test.ts'), 'utf8');
    expect(t).toContain("from './board'");
  });
});

// 2026-07-26 owner: "故意做坏的 ui 一起测, 让多模态审核来检测到 ui 崩坏"。
describe('故意做坏的参考页', () => {
  const page = () => readFileSync(join(fx.root, 'eval-app/fixtures/broken-board.html'), 'utf8');

  test('参考页落进 worktree', () => {
    expect(existsSync(join(fx.root, 'eval-app/fixtures/broken-board.html'))).toBe(true);
  });

  test('四个缺陷都真的种在页面里 (页面与 PLANTED_DEFECTS 同源, 改一处必须改两处)', () => {
    const h = page();
    expect(h).toContain('TODO_PLACEHOLDER');                 // D1 占位文案
    expect(h).toMatch(/width:120px;overflow:hidden/);         // D2 裁切
    expect(h).toContain('#eeeeee');                           // D3 低对比度
    // D4: done 与 open 两行用同一个 class, 没有任何区分样式
    expect(h).toMatch(/data-status="done"/);
    expect(h).not.toMatch(/\.row\[data-status="done"\]/);
  });

  test('SPEC 要求两层审查, 第二层挂 ui-reviewer 卡 (按技能卡评设计质量)', () => {
    expect(fx.spec).toContain('崩坏检测');
    expect(fx.spec).toContain('设计质量');
    expect(fx.spec).toContain('template: "ui-reviewer"');
  });

  test('SPEC 指向的参考页路径与真实落盘路径一致', () => {
    expect(fx.spec).toContain('eval-app/fixtures/broken-board.html');
  });
});
