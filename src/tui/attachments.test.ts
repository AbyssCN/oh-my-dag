/**
 * L1 判据:图片附件判定(W5 片1,契约 I1/I2/I5)。
 *
 * 反向自检(实跑):把 ENOENT 静默分支改成进 skipped → 「@只是在说话」当场红;
 * 把超限判定删掉 → 「超限跳过且说出来」当场红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_MAX_BYTES, extractImageRefs, fmtAttachment } from './attachments';

const world = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'omd-att-'));
  writeFileSync(join(d, 'a.png'), Buffer.from('89504e47', 'hex'));
  writeFileSync(join(d, 'big.png'), Buffer.alloc(IMAGE_MAX_BYTES + 1));
  writeFileSync(join(d, 'note.txt'), 'not an image');
  return d;
};

describe('extractImageRefs —— 判定保守 (I1)', () => {
  test('★ 存在的图附上 (base64 + mime); 同图引两次附一次', () => {
    const d = world();
    const r = extractImageRefs('看看 @a.png 再看一遍 @a.png', d);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toMatchObject({ ref: 'a.png', mimeType: 'image/png', bytes: 4 });
    expect(r.images[0]!.data).toBe(Buffer.from('89504e47', 'hex').toString('base64'));
    expect(r.skipped).toEqual([]);
  });

  test('★ 不存在的 @ 引用不算错 (可能只是在说话); 超限的跳过且说出来 (I5)', () => {
    const d = world();
    expect(extractImageRefs('@ghost.png 呢', d)).toEqual({ images: [], skipped: [] });
    const r = extractImageRefs('@big.png', d);
    expect(r.images).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('5MB cap');
  });

  test('非图扩展名 / 无 @ 前缀的路径一律当文本 —— 误吃比漏附严重', () => {
    const d = world();
    expect(extractImageRefs('@note.txt 和裸的 a.png', d)).toEqual({ images: [], skipped: [] });
  });

  test('fmtAttachment: KB/MB 分档, 小文件不画 0KB', () => {
    expect(fmtAttachment({ ref: 'a.png', bytes: 4 })).toBe('a.png (1KB)');
    expect(fmtAttachment({ ref: 'b.jpg', bytes: 2.1 * 1024 * 1024 })).toBe('b.jpg (2.1MB)');
  });
});
