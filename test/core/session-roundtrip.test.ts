/**
 * test/core/session-roundtrip —— W1 session 蒸馏器写→读→验 round-trip 切片。
 *
 * 范围:在 mkdtemp 临时项目根里, 走 `src/harness/session/writer.ts` 公开 API 写一次
 * session checkpoint, 再走 read-back (resume brief · §1+§2) 做四组钉现状断言。
 *
 * 硬约束 (与实施纪律):
 *   - 不改 `writer.ts` / `sink.ts` / `noun-gate.ts` / `scripts/session-writer.ts` /
 *     任何 `test/core` 下既有文件; 只新建本件。
 *   - 全部合成 fixture 内联, 不新增 transcript/JSONL/fixture 资源文件。
 *   - 断言一律以 writer.ts **现行为**为准: 实装存在缺口, 钉下来报缺口, 不改实装迁就。
 *   - read-back 路径 = `result.checkpointPath` 直接读盘 + 内联正则解析 §1/§2
 *     (writer.section() 未公开导出, resume 端实装路径就是直接读 .md)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWriter,
  type CallModelFn,
  type WriterResult,
} from '../../src/harness/session/writer';

// ─── 段标头(与 writer.ts:24 SECTION_HEADERS 同源)────────────────────────────────

const SECTION_HEADERS = [
  '## §1 Active intent',
  '## §2 Next concrete action',
  '## §3 Session directives',
  '## §4 Tasks',
  '## §5 Current work',
  '## §6 Files & anchors',
  '## §7 Discovered knowledge',
  '## §8 Errors & fixes',
  '## §9 Decisions',
] as const;

// ─── fixture 工厂(纯内联)────────────────────────────────────────────────────────────

const jsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n');

interface Fixture {
  root: string;
  transcript: string;
}

function mkFixture(prefix: string, userText = 'plumb session-writer round-trip'): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(
    transcript,
    jsonl([{ type: 'user', message: { content: userText } }]),
  );
  return { root, transcript };
}

// ─── read-back 助手(resume brief · §1/§2 解析)────────────────────────────────────
// writer.section() 未公开导出; resume 端实装就是直接读 .md 后切段, 故此处 inline 复刻
// 同款 regex (writer.ts:267)。行为对齐钉: 段起始 = `## §N`, 终止 = 下一段标头或 EOF。

function readResumeBrief(checkpointPath: string): {
  md: string;
  s1: string;
  s2: string;
  hasAllHeaders: boolean;
} {
  const md = readFileSync(checkpointPath, 'utf-8');
  const slice = (n: string): string => {
    const re = new RegExp(`## §${n}[^\\n]*\\n([\\s\\S]*?)(?=\\n## §|$)`);
    return (md.match(re)?.[1] || '').trim();
  };
  return {
    md,
    s1: slice('1'),
    s2: slice('2'),
    hasAllHeaders: SECTION_HEADERS.every((h) => md.includes(h)),
  };
}

// ─── 测试用例 ────────────────────────────────────────────────────────────────────

describe('session writer — round-trip (写→读→验)', () => {
  test('① 写出的 checkpoint 结构完整: 9 段蒸馏的段落锚都存在 (resume brief 可解析)', async () => {
    const { root, transcript } = mkFixture('omd-roundtrip-struct-');

    // 走 mechanical 强制路径, 避开 model 依赖; 仍验证锚 + 读回路径
    const r: WriterResult = await runWriter({
      transcript,
      sessionId: 'struct-001',
      cwd: root,
      mechanical: true,
    });

    expect(r.ok).toBe(true);
    expect(r.checkpointPath).toBeTruthy();
    expect(r.degraded).toBe(true); // mechanical 版
    expect(r.skipped).toBe(false);

    const brief = readResumeBrief(r.checkpointPath);
    expect(brief.hasAllHeaders).toBe(true);
    for (const h of SECTION_HEADERS) {
      expect(brief.md).toContain(h);
    }

    // resume brief 解析非空 (§1 必有降级说明; §2 mechanical 版字面 "(无)")
    expect(brief.s1.length).toBeGreaterThan(0);
    expect(brief.s1).toContain('机械降级');
    expect(brief.s2).toBe('(无)');
  });

  test('② 确定性: 同一份输入连写两次 → checkpoint.md 产物逐字节相同', async () => {
    // 固定时钟 + 确定性 callModel + 相同 user 文本 → 蒸馏产物可复现
    const fixedClock = (): number => 1_700_000_000_000;
    const deterministicCall = (async () => ({
      text: SECTION_HEADERS.join('\n') + '\n\n(plumb ok)\n',
    })) as unknown as CallModelFn;

    // 两次独立 temp root (state 隔离), 但 inputs 一致
    const fa = mkFixture('omd-roundtrip-det-a-');
    const fb = mkFixture('omd-roundtrip-det-b-');
    const a = await runWriter({
      transcript: fa.transcript,
      sessionId: 'det-001',
      cwd: fa.root,
      callModel: deterministicCall,
      now: fixedClock,
    });
    const b = await runWriter({
      transcript: fb.transcript,
      sessionId: 'det-001',
      cwd: fb.root,
      callModel: deterministicCall,
      now: fixedClock,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const mdA = readFileSync(a.checkpointPath, 'utf-8');
    const mdB = readFileSync(b.checkpointPath, 'utf-8');
    expect(mdA).toBe(mdB); // 产物逐字节相同

    // read-back 一致 (resume brief 不因根路径不同而漂移)
    const briefA = readResumeBrief(a.checkpointPath);
    const briefB = readResumeBrief(b.checkpointPath);
    expect(briefA.s1).toBe(briefB.s1);
    expect(briefA.s2).toBe(briefB.s2);
  });

  test('③ 校验器行为: 引用不存在文件 / 不可 resolve commit / >容差 novel → fail-open 机械降级 (不抛)', async () => {
    const { root: cwd, transcript } = mkFixture(
      'omd-roundtrip-val-',
      'plumb validator behavioral test material',
    );

    // 注入伪造 model 输出 (钉 validator 三闸全触发):
    //   grounding ① path: src/totally/fabricated/zzz.ts (项目根不存在 · 材料中也无)
    //   grounding ② commit: commit 0000beef (git rev-parse 拒 + 材料中也无)
    //   grounding ③ noun-gate: 5 个 novel 名词 (≥ maxNovel=3, 触发超容差 fail)
    const fabricatedText = [
      ...SECTION_HEADERS,
      '',
      'src/totally/fabricated/zzz.ts',
      'commit 0000beef is fake and unresolved',
      'ZorglubQuux IdentifierFakeNoun AmazingWord ReallyFictional Fake_noun',
    ].join('\n');

    const fabModel = (async () => ({ text: fabricatedText })) as unknown as CallModelFn;

    // 不传 mechanical → 走 distill (callModel 注入 → 跳过 bootstrap)
    const r: WriterResult = await runWriter({
      transcript,
      sessionId: 'val-001',
      cwd,
      callModel: fabModel,
    });

    // 钉 writer.ts 现行为: distill 两次验真未过 → throw → runWriter catch → mechanicalCheckpoint
    expect(r.ok).toBe(true);          // fail-open: 永不抛给调用方
    expect(r.degraded).toBe(true);    // 降级版
    expect(r.checkpointPath).toBeTruthy();
    expect(r.skipped).toBe(false);

    const brief = readResumeBrief(r.checkpointPath);
    // 9 段锚仍在 (mechanical 版字面保留)
    expect(brief.hasAllHeaders).toBe(true);
    // 降级注释在文首
    expect(brief.md.startsWith('<!-- DEGRADED')).toBe(true);
    // §1 必有 writer 蒸馏失败说明 (而非编造文本)
    expect(brief.s1).toContain('机械降级');
    expect(brief.s1).not.toContain('ZorglubQuux'); // 编造名词不进存盘
    expect(brief.s1).not.toContain('src/totally/fabricated/zzz.ts'); // 编造路径不进存盘
  });

  test('④ fail-open: 无 memory sink → result.sink = {ok:false} 且 writer 永不抛', async () => {
    const { root, transcript } = mkFixture('omd-roundtrip-fo-');

    // 故意不传 memory → sink 静默跳过 (sink.ts:113-115 现状)
    const r: WriterResult = await runWriter({
      transcript,
      sessionId: 'fo-001',
      cwd: root,
      mechanical: true,
      // memory: undefined (显式不传)
    });

    // writer 主调用永不抛 — fail-open 契约
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(true); // mechanical
    expect(r.checkpointPath).toBeTruthy();

    // sink 形状: { ok:false, error: ... }
    expect(r.sink).toBeDefined();
    expect(r.sink!.ok).toBe(false);
    expect(typeof r.sink!.error).toBe('string');
    expect(r.sink!.error!.length).toBeGreaterThan(0);

    // 写入磁盘仍成功 (markdown 是真理源, sink 失败不阻断)
    const brief = readResumeBrief(r.checkpointPath);
    expect(brief.hasAllHeaders).toBe(true);
  });
});