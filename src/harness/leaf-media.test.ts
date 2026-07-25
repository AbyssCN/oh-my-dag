/**
 * leaf-media 单元测试 (SDD v2 S4, D-14v2 媒体解析件)。
 * 覆盖: 引用提取 (路径/URL/去重/非图扩展) · 存在性校验 · data-URI 编码 · MEDIA-2/3 留痕与硬顶。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDepMedia, extractMediaRefs } from './leaf-media';

describe('extractMediaRefs', () => {
  test('绝对/相对路径 + URL 全提取, 去重, 保出现序', () => {
    const refs = extractMediaRefs(
      '截图: /tmp/a.png 与 shots/b.jpeg, 另见 https://cdn.example.com/c.webp?v=1 重复 /tmp/a.png',
    );
    expect(refs).toEqual(['/tmp/a.png', 'shots/b.jpeg', 'https://cdn.example.com/c.webp']);
  });

  test('非图片扩展与裸词不命中', () => {
    expect(extractMediaRefs('src/a.ts 和 report.pdf 以及 png 这个词')).toEqual([]);
  });

  test('标点收尾不吞 (括号/引号包裹)', () => {
    expect(extractMediaRefs('见 (out/x.png) 与 "y.jpg"')).toEqual(['out/x.png', 'y.jpg']);
  });
});

describe('collectDepMedia', () => {
  test('本地文件 → data URI (mime 按扩展); 相对路径锚 root; 缺失路径进 missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-leaf-media-'));
    writeFileSync(join(dir, 'a.png'), Buffer.from('png-bytes'));
    const r = collectDepMedia([`产出 a.png 与 ${join(dir, 'ghost.jpg')}`], { root: dir });
    expect(r.attached).toEqual(['a.png']);
    expect(r.missing).toEqual([join(dir, 'ghost.jpg')]);
    expect(r.parts).toHaveLength(1);
    const p = r.parts[0]!;
    if (p.type !== 'image_url') throw new Error('expect image part');
    expect(p.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('http(s) URL 直通不校验存在性', () => {
    const r = collectDepMedia(['see https://x.test/shot.jpeg'], { root: '/nonexistent' });
    expect(r.parts).toEqual([{ type: 'image_url', image_url: { url: 'https://x.test/shot.jpeg' } }]);
    expect(r.missing).toEqual([]);
  });

  test('MEDIA-3 数量硬顶: 超出 maxImages 进 skipped (无静默丢弃)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-leaf-media-'));
    for (const n of ['a', 'b', 'c']) writeFileSync(join(dir, `${n}.png`), Buffer.from(n));
    const r = collectDepMedia(['a.png b.png c.png'], { root: dir, maxImages: 2 });
    expect(r.attached).toEqual(['a.png', 'b.png']);
    expect(r.skipped).toEqual(['c.png']);
  });

  test('MEDIA-3 单图字节硬顶: 过大文件进 skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-leaf-media-'));
    writeFileSync(join(dir, 'big.png'), Buffer.alloc(64, 1));
    const r = collectDepMedia(['big.png'], { root: dir, maxBytesPerImage: 8 });
    expect(r.parts).toEqual([]);
    expect(r.skipped).toEqual(['big.png']);
  });

  test('跨前驱去重: 两个 dep 提同一路径只附一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-leaf-media-'));
    writeFileSync(join(dir, 'a.png'), Buffer.from('x'));
    const r = collectDepMedia(['a.png', '再提 a.png'], { root: dir });
    expect(r.attached).toEqual(['a.png']);
    expect(r.parts).toHaveLength(1);
  });
});
