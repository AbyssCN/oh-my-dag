/**
 * src/harness/goal/pin-legacy-path —— **测试专用**: 把一个测试文件钉在 P3 之前的执行路径上 (v1 conductor /
 * 平铺 / chain), 关掉 S6b 起默认开的编排循环 (`OMD_ORCHESTRATING_LOOP=0`, 见 orchestrating-loop.ts)。
 *
 * 为什么存在 (2026-09-02 S6b 探底实数, 替掉契约 D-26 拍的「6 个文件」): 默认路径切到编排循环后, 14 个
 * goal/ 测试文件 · 117 条用例红, 全部同一成因 —— 它们的 fake `_runDag` 产 `execute` 节点 (v1 conductor 形状),
 * 而循环路径读 `conductor`。它们测的是那条路上的机械 (判据陈旧闸 / 最佳绿底 / 判据重建 / rubric / 板事件 …),
 * 那条路仍可达 (R-1 对照臂入口), 所以**钉路径, 不改判据**; 循环路径上同一批语义的判据另写在
 * `orchestrating-loop.test.ts`。
 *
 * 用 beforeAll/afterAll 而不是模块顶层赋值: bun 在同一进程里顺序跑各文件, 顶层赋值会泄漏给后面的文件
 * (含 orchestrating-loop.test.ts 那些**要**默认开的用例)。
 */
import { afterAll, beforeAll } from 'bun:test';

export function pinLegacyExecutionPath(): void {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.OMD_ORCHESTRATING_LOOP;
    process.env.OMD_ORCHESTRATING_LOOP = '0';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.OMD_ORCHESTRATING_LOOP;
    else process.env.OMD_ORCHESTRATING_LOOP = prev;
  });
}
