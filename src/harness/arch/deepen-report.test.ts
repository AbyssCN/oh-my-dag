/**
 * arch/deepen-report 测试 —— 喂假 synth 输出: 候选切分 / 卡片渲染 / mermaid 围栏 / HTML 转义 /
 * 失败叶提示。全程零真模型零浏览器。
 */
import { describe, expect, test } from 'bun:test';
import { renderDeepenReport, splitCandidates } from './deepen-report';
import type { Hotspot } from './hotspots';

const FAKE_SYNTH = `前言几句 (该被丢弃)。

## C1: 把 plan 解析收进一个深模块 (跨热点)
- **files**: src/harness/plan/planner.ts, src/harness/review/run.ts
- **friction**: 理解 plan 解析要在 3 个文件间弹跳
- **deletion-test**: shallow — 删掉后逻辑几乎原样摊回两个调用方
- **before/after**:
\`\`\`mermaid
flowchart LR
  A[caller] --> B[parsePlan]
\`\`\`
- **leverage/locality**: 2 个调用点受益, 改动集中一处
- **strength**: strong

## C2: 合并重复的 flag 解析
- **files**: scripts/dag-review.ts
- **friction**: 每个脚本手搓一份 <script>alert(1)</script> 解析
- **deletion-test**: shallow
- **before/after**: parseFlags(spec) 一个函数
- **leverage/locality**: 5 个脚本受益
- **strength**: moderate
`;

const HOTSPOTS: Hotspot[] = [
  { dir: 'src/harness/plan', touches: 4, files: [{ path: 'src/harness/plan/planner.ts', touches: 3 }] },
];

describe('splitCandidates', () => {
  test('按 ## 标题切块, 前言丢弃', () => {
    const cs = splitCandidates(FAKE_SYNTH);
    expect(cs.length).toBe(2);
    expect(cs[0]!.title).toContain('深模块');
    expect(cs[1]!.title).toContain('flag 解析');
    expect(cs[0]!.body).toContain('deletion-test');
  });

  test('无标题 → 空数组', () => {
    expect(splitCandidates('没有候选。')).toEqual([]);
  });
});

describe('renderDeepenReport', () => {
  const html = renderDeepenReport({
    scopeLabel: 'repo-wide',
    commits: 200,
    hotspots: HOTSPOTS,
    synthMarkdown: FAKE_SYNTH,
    leafStatuses: [
      { id: 'scan_1', status: 'done' },
      { id: 'scan_2', status: 'failed' },
    ],
    generatedAt: '2026-07-19T00:00:00Z',
  });

  test('自包含 HTML: 候选卡片 + 标题 + 字段', () => {
    expect(html).toStartWith('<!doctype html>');
    expect((html.match(/candidate-card/g) ?? []).length).toBe(2);
    expect(html).toContain('把 plan 解析收进一个深模块');
    expect(html).toContain('deletion-test');
    expect(html).toContain('src/harness/plan'); // 热点表
  });

  test('mermaid 围栏 → <pre class="mermaid"> (内容转义)', () => {
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('A[caller] --&gt; B[parsePlan]');
  });

  test('strength badge 解析', () => {
    expect(html).toContain('>strong</span>');
    expect(html).toContain('>moderate</span>');
  });

  test('模型产文本 HTML 转义 (注入面关死)', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('失败叶提示 + 元信息行', () => {
    expect(html).toContain('scan_2');
    expect(html).toContain('1 个扫描叶失败');
    expect(html).toContain('近 200 commit');
  });

  test('零候选 → 明说而非空白页', () => {
    const empty = renderDeepenReport({ scopeLabel: 's', commits: 10, hotspots: HOTSPOTS, synthMarkdown: '无候选' });
    expect(empty).toContain('未产出候选');
  });
});
