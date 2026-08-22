/**
 * src/harness/agent-tools-spill.test.ts —— bash 输出溢出的 spill 行为 (2026-08-…, RED)。
 *
 * 背景: pi-agent-core 的 `executeShellWithCapture` 在 totalBytes > 50KB 时会把完整输出
 * 落进一份 temp file (`r.value.fullOutputPath`)。omd 的 bash 工具目前把这条扔了
 * (`agent-tools.ts:887` 解构 `{ output, exitCode, cancelled, truncated }` 直接丢
 * `fullOutputPath` 与详细 `truncation`) —— 用户既看不到指针, 也不知道溢出落到了哪儿。
 * 这是本仓 §静默坑 #2 的典型形态: 「看不到」等于「假装没有」, 大输出里命中的 needle
 * 会被读成「不存在」。
 *
 * 这份网钉三条契约:
 *   (a) 溢出时正文必须含完整输出的指针路径, 且能从该路径读到落进 spill 的**头部**内容
 *       (尾部本来就在 body 里)。—— 实装之前: 指针根本不在 body 里 → 红。
 *   (b) 不溢出时正文一个字节都不许含 spill 指针/告示 (零回归 —— 短输出别被加告示)。——
 *       实装前后都该绿, 是「不许无脑加告示」的护栏。
 *   (c) 全文累积撞到字节上限时, 告示必须如实说「完整输出被截断, 仅留前 N」, 且 spill
 *       文件本身不许超过该上限 (不许装作留了全文)。—— 实装之前: 没有溢出告示 + spill
 *       文件跟原始输出一样大 → 红。
 *
 * **证伪方式**: 把 `agent-tools.ts:887` 那一行解构改成保留 `fullOutputPath` 与
 * `truncation`、把 truncateSpill + 拼到 body 上 → 三条都转绿; 改一半 (例如只加 pointer
 * 不加溢出告示) → (c) 仍红; 全部无脑加到 body → (b) 红。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';

const toolset = (cwd: string): Record<string, AnyOmdTool> =>
  Object.fromEntries(createOmdAgentTools({ cwd }).map((t) => [t.name, t]));

const run = (t: AnyOmdTool, args: unknown): Promise<{ content: { type: string; text?: string }[] }> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<{ content: { type: string; text?: string }[] }>;

const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

/** 从正文里把 spill 路径抽出来。约定: 正文里有形如 `完整输出: /tmp/bash-xxx.log` 的标记。 */
function extractSpillPath(body: string): string | null {
  const m = body.match(/完整输出:\s*(\S+)/);
  return m ? m[1] ?? null : null;
}

describe('★ bash 输出溢出 → spill 指针 + 头部内容可达 (2026-08-…, RED)', () => {
  it('★ 跑 60KB 命令 → 正文含完整输出指针 + 该路径里能找到头部 token (尾部本来就在 body 里)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-spill-head-'));
    const { bash } = toolset(cwd);
    const HEAD_TOKEN = 'SPILL_HEAD_TOKEN:UNIQUE_TO_HEAD_SEGMENT_ONLY';
    // 60KB > DEFAULT_MAX_BYTES(50KB) ⇒ 触发 pi-agent-core 的 fullOutput 落地。
    // printf 把 token 顶到第一行; yes 灌满剩下的字节。
    // 实测: pi 在 totalBytes 首次越过 50KB 的那一刻把 tailOutput 快照进 spill, 此时
    // HEAD_TOKEN 已经在 tailOutput 里 ⇒ spill 文件必含 HEAD_TOKEN; body 是 tailOutput
    // 的最后 ~50KB ⇒ HEAD_TOKEN 已被截出 body。
    const r = await run(bash!, {
      command:
        `{ printf '${HEAD_TOKEN}\\n'; ` +
        `yes 'BODY_FILLER_LINE_DATA_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING'; ` +
        `} | head -c 60000`,
    });
    const body = text(r);
    // ① spill 指针必须出现, 且必须是绝对路径 (read 工具/外部脚本要能直接用)。
    const path = extractSpillPath(body);
    expect(path).not.toBeNull();
    expect(path!).toMatch(/^\//);
    // ② spill 文件存在且能读 —— 不许只指针、不存在。
    const content = readFileSync(path!, 'utf-8');
    // ③ 落进 spill 的头部 token 必须在 spill 文件里找到 (尾部本来就在 body 里)。
    expect(content).toContain(HEAD_TOKEN);
  });
});

describe('★ bash 短输出 → 正文零 spill 告示/指针 (零回归护栏, 2026-08-…)', () => {
  it('echo 一行短的 → 正文**不含**完整输出指针或溢出告示', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-spill-short-'));
    const { bash } = toolset(cwd);
    const body = text(await run(bash!, { command: 'echo SHORT_HELLO_OUTPUT_NO_TRUNCATION' }));
    // 短命令本就该一字不差回到正文。
    expect(body).toContain('SHORT_HELLO_OUTPUT_NO_TRUNCATION');
    // 没溢出 → 正文一个字节不许含 spill 告示/指针 —— 这是「不许把告示无脑加进所有返回」的护栏。
    expect(body).not.toMatch(/完整输出:/);
    expect(body).not.toMatch(/完整输出被截断/);
  });
});

describe('★ bash 全文累积撞字节上限 → 告示如实 + spill 文件实际有界 (2026-08-…, RED)', () => {
  it('★ 跑 12MB 命令 → 正文含「完整输出被截断」+ spill 文件大小 < 12MB', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-spill-overflow-'));
    const { bash } = toolset(cwd);
    // 12MB > 任何合理的 spill 上限 (10MB 一档) ⇒ 必然撞上限。
    const r = await run(bash!, {
      command:
        `yes 'BIG_FILLER_LINE_DATA_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING_PADDING' | head -c 12000000`,
    });
    const body = text(r);
    const path = extractSpillPath(body);
    expect(path).not.toBeNull();
    // ① 告示必须如实说"完整输出被截断" —— 不许装作只截了 body 那一段。
    expect(body).toMatch(/完整输出被截断/);
    // ② spill 文件本身不许超过 12MB —— 比生成的 12MB 输出小, 说明确实截了
    //    (用 lessThan 留个 buffer, 不绑死 impl 选的具体上限值)。
    const size = statSync(path!).size;
    expect(size).toBeLessThan(12 * 1024 * 1024);
  });
});
