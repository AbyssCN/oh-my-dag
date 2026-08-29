/**
 * 叶子留痕汇 (2026-08-29)。
 *
 * 反向自检(逐条已实测会红):
 *   · 去掉 `stopped` 那一支 → 「超上限后不再增长」红;
 *   · 把 `__truncated__` 那行删掉 → 「截断要留证」红;
 *   · 把 catch 里的 `stopped = true` 改成继续写 → 「写不进去不炸」仍绿, 但会刷屏 (故另断 warn 只一次不测,
 *     那条由 logger 行为保证, 不在本文件的可测面内)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeafTranscriptSink } from './leaf-transcript';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'leaf-transcript-'));
}

describe('createLeafTranscriptSink', () => {
  test('逐条落 JSONL, 结构原样保留 (结构才是分析要看的东西)', () => {
    const dir = fresh();
    try {
      const p = join(dir, 'nested', 'x.jsonl'); // 父目录不存在 → 应自己建
      const sink = createLeafTranscriptSink({ path: p });
      sink({ type: 'tool_execution_start', toolName: 'bash', input: { command: 'ls -la' } });
      sink({ type: 'tool_execution_end', toolName: 'bash', ok: true });
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const a = JSON.parse(lines[0]!) as { type: string; input: { command: string }; ts: number };
      expect(a.type).toBe('tool_execution_start');
      expect(a.input.command).toBe('ls -la');
      expect(typeof a.ts).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('超事件上限 → 停止增长, 且**留一行 __truncated__**(悄悄停会被读成"叶子不动了")', () => {
    const dir = fresh();
    try {
      const p = join(dir, 'x.jsonl');
      const sink = createLeafTranscriptSink({ path: p, maxEvents: 2 });
      for (let i = 0; i < 10; i++) sink({ type: 'e', i });
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3); // 2 条正文 + 1 条截断标记
      const last = JSON.parse(lines[2]!) as { type: string; events: number; maxEvents: number };
      expect(last.type).toBe('__truncated__');
      expect(last.maxEvents).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('超长字符串按字段截断并标出丢了多少 (不是悄悄砍)', () => {
    const dir = fresh();
    try {
      const p = join(dir, 'x.jsonl');
      const sink = createLeafTranscriptSink({ path: p });
      sink({ type: 'tool_execution_end', output: 'x'.repeat(10_000) });
      const rec = JSON.parse(readFileSync(p, 'utf8').trim()) as { output: string };
      expect(rec.output.length).toBeLessThan(10_000);
      expect(rec.output).toContain('[+6000]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('写盘失败不抛 (留痕是排障件, 不许把 run 弄挂)', () => {
    // 路径指向一个**存在的目录**的下级同名冲突: mkdir 会成, appendFile 写目录会 EISDIR。
    const dir = fresh();
    try {
      const sink = createLeafTranscriptSink({ path: dir }); // 直接写一个目录
      expect(() => sink({ type: 'e' })).not.toThrow();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
