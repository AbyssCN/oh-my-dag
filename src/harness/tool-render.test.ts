/**
 * H6 (#187) 的两道闸:**覆盖**与**回放等价**。
 *
 * 票面 verify 原话:「回放路径测试 —— 存规范值 + render 重投影 === 原始展示」。
 * 这里把它落成可跑的:拿工具**真跑一次**拿到 `details`(规范值),把它存下来,
 * 之后**只用 render 重投影**,与当场那次的投影逐字节相等 —— 证明回放不必重跑工具。
 *
 * 另一道是覆盖闸:每个手工具都必须挂得上 `render`。搬家前投影是 UI 里按名字派发的 switch,
 * 改名即落 `null` 静默消失;这条闸就是把那个静默换成红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';
import { HAND_TOOL_RENDERERS, renderBashResult, renderGrepResult, renderReadResult } from './tool-render';

const root = mkdtempSync(join(tmpdir(), 'omd-tool-render-'));
const tools = createOmdAgentTools({ cwd: root });
const byName = (n: string): AnyOmdTool => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`夹具坏了: 没有工具 ${n}`);
  return t;
};

describe('★ #187 覆盖闸 — 每个手工具都挂得上 render', () => {
  test('六个手工具一个不少, 且挂的就是 HAND_TOOL_RENDERERS 里那一份(单一真源)', () => {
    // 反向自检: 把 agent-tools.ts 的 `.map(withRender)` 去掉 → 六条全红;
    //          把 HAND_TOOL_RENDERERS 里删一个键 → 那一个红。
    for (const name of ['read', 'write', 'edit', 'ls', 'grep', 'bash']) {
      const t = byName(name);
      expect(t.render, `工具 ${name} 没挂 render`).toBeDefined();
      expect(t.render).toBe(HAND_TOOL_RENDERERS.get(name)!);
    }
  });

  test('★ 判别力: 名字对不上时 HAND_TOOL_RENDERERS 取不到 —— 这正是旧 switch 静默失效那一格', () => {
    // 旧实现在这里落 `return null` 且无任何痕迹。现在它被上面那条覆盖闸挡在前面:
    // 真改了名字而忘了改投影, 覆盖闸当场红, 不会等到屏上那半句消失才被人发现。
    expect(HAND_TOOL_RENDERERS.get('grep_renamed')).toBeUndefined();
  });
});

describe('★ #187 回放等价 — 存规范值 + render 重投影 === 原始展示', () => {
  test('read: 真跑一次 → 存 details → 只用 render 重投影, 与当场投影逐字节相等', async () => {
    const file = join(root, 'sample.txt');
    writeFileSync(file, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));

    const read = byName('read');
    const result = await read.execute!('call-1', { path: file } as never);

    // ① 当场投影(工具还在手上)
    const live = read.render!(result.details);
    // ② 只把**规范值**存下来 —— 模拟写盘/回放:工具不再跑, 只剩这一份 JSON
    const persisted = JSON.parse(JSON.stringify(result.details)) as unknown;
    // ③ 回放:重投影
    const replayed = renderReadResult(persisted);

    expect(live).toBe('12 lines');
    expect(replayed).toBe(live); // ← 票面 verify 那一行
  });

  test('grep: 同样 —— 回放不重跑工具(不碰磁盘, 只吃存下来的 details)', async () => {
    writeFileSync(join(root, 'a.txt'), 'needle here\nneedle again');
    const grep = byName('grep');
    const result = await grep.execute!('call-2', { pattern: 'needle', path: root } as never);

    const live = grep.render!(result.details);
    const replayed = renderGrepResult(JSON.parse(JSON.stringify(result.details)));
    expect(replayed).toBe(live);
    expect(live).toContain('in'); // "N in M files" 形
  });

  test('★ 反向自检: 改一格规范值 → 重投影必变(证明它真的在读 details, 不是返回常量)', () => {
    const base = { exitCode: 0, truncated: false };
    expect(renderBashResult(base)).toBe('exit 0');
    expect(renderBashResult({ ...base, exitCode: 1 })).toBe('exit 1');
    expect(renderBashResult({ ...base, truncated: true })).toBe('exit 0 · output truncated');
  });
});

describe('投影语义没在搬家中漂(逐条钉旧行为)', () => {
  test('bash: exitCode 缺席 ≠ exit 0 —— 说 no exit code', () => {
    // 「被中止/超时杀掉」与「跑成功了」压成同一句话, 就是把没跑完画成跑成功。
    expect(renderBashResult({ truncated: false })).toBe('no exit code');
  });

  test('grep: 0 命中说成 no match, 不留空', () => {
    expect(renderGrepResult({ matches: 0, files: 0 })).toBe('no match');
  });

  test('grep: 截断/剪枝跟着命中数一起出现', () => {
    expect(renderGrepResult({ matches: 3, files: 2, walkCapped: true, skippedMounts: 2 })).toBe(
      '3 in 2 files · capped · 2 mounts skipped',
    );
  });

  test('非对象 details → null(不编占位)', () => {
    for (const bad of [null, undefined, 'str', 42, []]) expect(renderReadResult(bad)).toBeNull();
  });
});

process.on('exit', () => rmSync(root, { recursive: true, force: true }));
