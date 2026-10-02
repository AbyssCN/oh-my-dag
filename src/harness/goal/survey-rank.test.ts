import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevAskInput, JevAskResult } from '../../model/jev-client';
import { buildSurveyRank, SURVEY_RANK_HEADER, surveyRankEnabled } from './survey-rank';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'survey-rank-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

/** 假 Jev: 按路径查分表; 记下每发问了哪些路径。 */
function fakeJev(scoreOf: (path: string) => number | undefined, seen: string[][] = []) {
  return async (input: JevAskInput): Promise<JevAskResult> => {
    const files = (input.state as { files: Record<string, { path: string }> }).files;
    const answers: Record<string, { score?: number }> = {};
    const paths: string[] = [];
    for (const [id, f] of Object.entries(files)) {
      paths.push(f.path);
      const s = scoreOf(f.path);
      answers[id] = s === undefined ? {} : { score: s };
    }
    seen.push(paths);
    return { ok: true, answers, ms: 1, inputTokens: 100 };
  };
}

describe('surveyRankEnabled', () => {
  test('只有显式 1 才开 (反向自检: 改成恒开 → 这条红)', () => {
    expect(surveyRankEnabled({})).toBe(false);
    expect(surveyRankEnabled({ OMD_SURVEY_RANK: '0' })).toBe(false);
    expect(surveyRankEnabled({ OMD_SURVEY_RANK: 'true' })).toBe(false);
    expect(surveyRankEnabled({ OMD_SURVEY_RANK: '1' })).toBe(true);
  });
});

describe('buildSurveyRank', () => {
  test('最高分排第一, 只取前 5, 文本带大纲 (反向自检: 排序方向反过来 → 红)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`pkg/m${i}.py`] = `def f${i}():\n    pass\n`;
    const root = repo(files);
    const r = await buildSurveyRank('修一下 m6 的行为', root, { ask: fakeJev((p) => Number(p.match(/m(\d)/)?.[1]) / 4) });
    expect(r.facts.top.map((t) => t.path)).toEqual(['pkg/m7.py', 'pkg/m6.py', 'pkg/m5.py', 'pkg/m4.py', 'pkg/m3.py']);
    expect(r.text.startsWith(SURVEY_RANK_HEADER)).toBe(true);
    expect(r.text).toContain('1. pkg/m7.py (1.75)');
    expect(r.text).toContain('def f7():');
    expect(r.text).not.toContain('pkg/m2.py');
    expect(r.facts.scored).toBe(8);
    expect(r.facts.chars).toBe(r.text.length);
  });

  test('> 100 个候选只问 100 个, 20 个一批 (反向自检: 删预筛 → 红)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 130; i++) files[`src/f${i}.ts`] = i < 3 ? 'export const parser = 1;\n' : 'export const x = 1;\n';
    const root = repo(files);
    const seen: string[][] = [];
    const r = await buildSurveyRank('fix the parser', root, { ask: fakeJev(() => 1, seen) });
    expect(r.facts.prefiltered).toBe(true);
    expect(r.facts.candidates).toBe(100);
    expect(seen.flat().length).toBe(100);
    expect(seen.every((b) => b.length <= 20)).toBe(true);
    // 词法预筛把含 goal 词的文件留在候选里
    expect(seen.flat()).toContain('src/f0.ts');
  });

  test('Jev 全挂 → 空文本 + why 原文, 不抛 (fail-open 不吞证据)', async () => {
    const root = repo({ 'a.py': 'x = 1\n' });
    const r = await buildSurveyRank('goal', root, {
      ask: async () => ({ ok: false, why: 'no-key', ms: 0 }),
    });
    expect(r.text).toBe('');
    expect(r.facts.scored).toBe(0);
    expect(r.facts.why).toContain('no-key');
  });

  test('部分批次失败 → 用拿到的分, why 记下失败批数', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`f${i}.py`] = 'x = 1\n';
    const root = repo(files);
    let n = 0;
    const ok = fakeJev(() => 2);
    const r = await buildSurveyRank('goal', root, {
      ask: async (input) => (n++ === 0 ? ok(input) : { ok: false, why: 'timeout', ms: 1500 }),
    });
    expect(r.facts.scored).toBe(20);
    expect(r.text).not.toBe('');
    expect(r.facts.why).toContain('1/2');
  });

  test('仓里没有源文件 → 空段, why 说明, 一发都不问', async () => {
    const root = repo({ 'README.md': '# hi\n' });
    const seen: string[][] = [];
    const r = await buildSurveyRank('goal', root, { ask: fakeJev(() => 2, seen) });
    expect(r.text).toBe('');
    expect(r.facts.why).toBe('仓内没有源文件');
    expect(seen.length).toBe(0);
  });
});
