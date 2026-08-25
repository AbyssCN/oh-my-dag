/**
 * src/harness/view-image-tool.test.ts —— D-1/D-2 的契约钉死 (2026-08-25, D2 视觉通道)。
 *
 * **反向自检 / 证伪方式**: 删 `agent-tools.ts` 里的 `view_image` / 取消 `read` 里的图片拒
 * → 本文件全红; 改动落地后全绿。
 *
 * ⚠ 与 `agent-tools.test.ts` 关系: 那是「6 个手工具的闸与语义」老回归, 钉的是「拿到工具
 *    就拿到闸」这一格; 本文件专测 `view_image` 工具本身与 `read` 对图片的拒行为。
 *    本文件新建, 不动 `agent-tools.test.ts`。
 *    ⚠ 已知连带: `agent-tools.test.ts:457` 的 I-1 S3-C8-B baseline 用
 *    `toEqual` 断言 7 件, 加 `view_image` 后变 8 件必红。该测试不在本片写集内, 按
 *    「既有断言被打断的, 按写集一部分处理」原则需要后续单独提一笔收尾。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';

// ── 1×1 白 PNG (8×8 像素版, 67 字节) —— 已知字节与 base64 钉死的固定夹具 ──────────
//   字节来自手工生成, hex 序列见 bash 命令: `printf '\x89PNG\r\n\x1a\n...' | xxd`
const PNG_1X1_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0x0F, 0x00, 0x00,
  0x01, 0x01, 0x00, 0x01, 0x5C, 0xCD, 0xFF, 0x69, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);
const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4DwAAAQEAAVzN/2kAAAAASUVORK5CYII=';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-view-image-'));
  writeFileSync(join(root, 'pixel.png'), PNG_1X1_BYTES);
  writeFileSync(join(root, 'picture.JPG'), PNG_1X1_BYTES); // 大写扩展名 — 走 case-insensitive 分支
  writeFileSync(join(root, 'note.txt'), 'hello world\n');
  return root;
}

function toolset(root: string): Record<string, AnyOmdTool> {
  return Object.fromEntries(createOmdAgentTools({ cwd: root }).map((t) => [t.name, t]));
}

const run = (t: AnyOmdTool, args: unknown) => t.execute('call-1', args as never, undefined, undefined);

// ── INV-1 · view_image 返回真图块 (GWT-1) ────────────────────────────────────────
describe('INV-1 · view_image 返回真图块 (GWT-1)', () => {
  it('PNG → content 首块 type==="image" 且 mimeType==="image/png" 且 data 可解回原字节', async () => {
    const { view_image } = toolset(fixture());
    expect(view_image).toBeDefined();
    const r = (await run(view_image!, { path: 'pixel.png' })) as {
      content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
      details: { path: string; bytes: number };
    };
    expect(r.content).toHaveLength(1);
    const block = r.content[0]!;
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(typeof block.data).toBe('string');
    // base64 解码必须能拿回原字节 —— 否则模型收到的是错位像素, 比乱码更难发现。
    expect(Buffer.from(block.data!, 'base64').equals(PNG_1X1_BYTES)).toBe(true);
    // 反向自检: data 必须与已知固定值字节相等, 避免「base64 字符串对、内容被偷换」漏检。
    expect(block.data).toBe(PNG_1X1_B64);
    // details 也照规范值那一面 (与 read/write 同款, H6 投影能复用同一根管线)。
    expect(r.details).toEqual({ path: 'pixel.png', bytes: PNG_1X1_BYTES.length });
  });

  it('JPG (.JPG 大写) → mime 仍为 image/jpeg —— 扩展名映射走 lowercase', async () => {
    const { view_image } = toolset(fixture());
    const r = (await run(view_image!, { path: 'picture.JPG' })) as {
      content: Array<{ type: string; mimeType?: string }>;
    };
    expect(r.content[0]!.type).toBe('image');
    expect(r.content[0]!.mimeType).toBe('image/jpeg');
  });
});

// ── INV-1 · 错误路径不返回 image 块 (GWT-2) ─────────────────────────────────────
describe('INV-1 · 不存在路径与非图扩展 → 错误 (GWT-2)', () => {
  it('不存在路径 → 抛错, 错误文本不含 view_image 之外的误导 (即不假装是别的工具的事)', async () => {
    const { view_image } = toolset(fixture());
    await expect(run(view_image!, { path: 'no-such.png' })).rejects.toThrow(/路径不存在/);
  });

  it('.txt 扩展名 → 抛错, 错误文本必须说「不是图片」(避免模型以为 file-not-found)', async () => {
    const { view_image } = toolset(fixture());
    await expect(run(view_image!, { path: 'note.txt' })).rejects.toThrow(/不是图片文件/);
  });

  it('超 20MB → 抛错, 错误文本含实际字节数与上限', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-view-image-big-'));
    try {
      // 21MB 假大文件 — 真实写入太慢, 改用稀疏文件 (O_TRUNC + 不调 write)。
      // 但 fs.writeFile 必然真写, 这里用一个已经够大的真实填充 —— 1MB 一片,
      // 21 片够用, 测完立即 rm。
      const buf = Buffer.alloc(1024 * 1024, 0x00);
      const f = join(root, 'big.png');
      // 用 sync 写入省一道; 21MB 一次写穿 < 1s 在 tmpfs。
      const fd = require('node:fs').openSync(f, 'w');
      try {
        for (let i = 0; i < 21; i++) require('node:fs').writeSync(fd, buf);
      } finally {
        require('node:fs').closeSync(fd);
      }
      const { view_image } = toolset(root);
      const size = statSync(f).size;
      await expect(run(view_image!, { path: 'big.png' })).rejects.toThrow(
        new RegExp(`超过上限 20971520 字节`),
      );
      expect(size).toBeGreaterThan(20 * 1024 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录路径 (扩展名骗过的场景) → 抛错, 不返回 image 块', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-view-image-dir-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(root, 'sub.png'));
      const { view_image } = toolset(root);
      await expect(run(view_image!, { path: 'sub.png' })).rejects.toThrow(/不是文件/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── INV-2 · read 对图片改明确拒绝, 错误文本含 view_image (GWT-3) ───────────────
describe('INV-2 · read 不再静默喂乱码 (GWT-3)', () => {
  it('PNG → read 抛错, 错误文本含 view_image, 正文不含替换字符 (U+FFFD)', async () => {
    const root = fixture();
    const { read } = toolset(root);
    let err: Error | null = null;
    try {
      await run(read!, { path: 'pixel.png' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    // INV-2 钉死的两条: 含 view_image 字样 + 不含替换字符乱码正文。
    expect(msg).toContain('view_image');
    expect(msg).not.toContain('\uFFFD');
    // 顺带钉: 错误里说清楚是图片, 模型才知道换工具, 不是再试一次。
    expect(msg).toMatch(/图片/);
  });

  it('.txt 走 read 仍照常读 (零回归护栏)', async () => {
    const root = fixture();
    const { read } = toolset(root);
    const r = (await run(read!, { path: 'note.txt' })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = r.content.map((c) => c.text ?? '').join('');
    expect(text).toContain('hello world');
  });
});

// ── INV-6 · 既有 6 个工具不被改名/换位 ─────────────────────────────────────────
describe('INV-6 · 既有工具名称与能力不被 view_image 进出挪动', () => {
  it('工具集 = read / view_image / write / edit / ls / grep / bash', () => {
    const names = Object.keys(toolset(fixture())).sort();
    expect(names).toEqual(['bash', 'edit', 'grep', 'ls', 'read', 'view_image', 'write']);
  });
});
