/**
 * plain provider content-type 分支 (C2 兜底) — 单元闸。钉 `isTextLikeContentType` 与
 * `PlainFetchProvider.fetch` 在非文本类响应上的短路行为:
 *
 * - **INV-4** GWT-7: application/pdf + 二进制样身 → `text === ''` 且 `contentType` 含 `'pdf'`;
 * - **INV-4** / **INV-5** GWT-8: text/html 正文 + 无 content-type 头 → 两者 text 非空且与现状
 *   口径一致 (html 去标签 / 原样);
 * - INV-5 缺省零回归: 现行 `text/html` / `application/json` / `text/plain` 三类走原有清洗路径,
 *   `isTextLikeContentType` 不影响 links 段。
 *
 * ## 反向自检 (每条写在测试注释): 删 / 改以下任一项, 对应 GWT 红
 *
 * - 删 `isTextLikeContentType` 的非文本短路 (改成无脑读 body) → GWT-7 拿到的 text 含
 *   mojibake 二进制样身, text !== '' 直接红;
 * - 把空 content-type 视为非文本 → GWT-8 第二支误杀, text === '' 红;
 * - 把 `application/json` 误归非文本 → "现行 json 原样"回归测 (INV-5) 红;
 * - 把 `text/*` 头判定去掉 → text/csv 等回归测红;
 * - 不导出 `isTextLikeContentType` → import 红, 本文件 0 命中失败;
 *   真源在 plain.ts 导出, 这里只引, 改源即红。
 */
import { describe, expect, test } from 'bun:test';
import { PlainFetchProvider, isTextLikeContentType } from './providers/plain';

const resp = (body: string, headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;

describe('isTextLikeContentType (C2 判别函数)', () => {
  test('★ 空 content-type 视为 text-like (缺头不误伤)', () => {
    expect(isTextLikeContentType('')).toBe(true);
  });

  test('★ text/* 一律视为 text-like (含 charset 参数)', () => {
    expect(isTextLikeContentType('text/html')).toBe(true);
    expect(isTextLikeContentType('text/html; charset=utf-8')).toBe(true);
    expect(isTextLikeContentType('text/plain')).toBe(true);
    expect(isTextLikeContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isTextLikeContentType('text/csv')).toBe(true);
    expect(isTextLikeContentType('text/markdown')).toBe(true);
  });

  test('★ 含 html / xml / json / markdown / javascript 关键字的类型视为 text-like', () => {
    expect(isTextLikeContentType('application/json')).toBe(true);
    expect(isTextLikeContentType('application/ld+json')).toBe(true);
    expect(isTextLikeContentType('application/xml')).toBe(true);
    expect(isTextLikeContentType('application/xhtml+xml')).toBe(true);
    expect(isTextLikeContentType('image/svg+xml')).toBe(true);
    expect(isTextLikeContentType('application/atom+xml')).toBe(true);
    expect(isTextLikeContentType('application/javascript')).toBe(true);
    expect(isTextLikeContentType('application/x-javascript')).toBe(true);
  });

  test('★ 非文本类型视为非 text-like (PDF / 图片 / 视频 / 音频 / 二进制 / 压缩)', () => {
    expect(isTextLikeContentType('application/pdf')).toBe(false);
    expect(isTextLikeContentType('application/pdf; charset=binary')).toBe(false);
    expect(isTextLikeContentType('application/octet-stream')).toBe(false);
    expect(isTextLikeContentType('image/png')).toBe(false);
    expect(isTextLikeContentType('image/jpeg')).toBe(false);
    expect(isTextLikeContentType('image/webp')).toBe(false);
    expect(isTextLikeContentType('video/mp4')).toBe(false);
    expect(isTextLikeContentType('audio/mpeg')).toBe(false);
    expect(isTextLikeContentType('application/zip')).toBe(false);
    expect(isTextLikeContentType('application/gzip')).toBe(false);
  });

  test('★ 大小写不敏感', () => {
    expect(isTextLikeContentType('APPLICATION/PDF')).toBe(false);
    expect(isTextLikeContentType('Text/HTML')).toBe(true);
    expect(isTextLikeContentType('Application/JSON')).toBe(true);
  });
});

describe('PlainFetchProvider — content-type 分支 (C2 兜底)', () => {
  test('★ GWT-7 INV-4: application/pdf + 二进制样身 → text === "" 且 contentType 含 "pdf"', async () => {
    // PDF 起始字节序列, 文本字面包含 \x80 (UTF-8 高位), 真要 text() 解码会出 mojibake。
    const pdfBody =
      '%PDF-1.4\n%\x80\x80\x80\x80\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstream\nBINARYDATA\nendstream';
    const p = new PlainFetchProvider({
      fetchImpl: resp(pdfBody, { 'content-type': 'application/pdf' }),
    });
    const r = await p.fetch('https://e.example/file.pdf');
    expect(r.text).toBe('');
    expect(r.contentType).toBeDefined();
    expect(r.contentType!.toLowerCase()).toContain('pdf');
  });

  test('★ application/octet-stream → text === "" 且 contentType 原样不丢', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('any-bytes', { 'content-type': 'application/octet-stream' }),
    });
    const r = await p.fetch('https://e.example/bin');
    expect(r.text).toBe('');
    expect(r.contentType).toBe('application/octet-stream');
  });

  test('★ image/png → text === "" (同理让位给远端 provider)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('PNG-BYTES', { 'content-type': 'image/png' }),
    });
    const r = await p.fetch('https://e.example/img');
    expect(r.text).toBe('');
    expect(r.contentType).toBe('image/png');
  });

  test('★ GWT-8 INV-5: text/html 正文 → text 非空 (走 stripHtmlToText)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('<html><body><p>正文段落</p></body></html>', {
        'content-type': 'text/html',
      }),
    });
    const r = await p.fetch('https://e.example/page');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toContain('正文段落');
    expect(r.text).not.toContain('<p>');
    expect(r.contentType).toBe('text/html');
  });

  test('★ GWT-8 INV-5: 无 content-type 头 → text 非空 (缺头不误伤, 原样回)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('plain text body no headers'),
    });
    const r = await p.fetch('https://e.example/headless');
    expect(r.text).toBe('plain text body no headers');
    // contentType 字段在空 content-type 时按现状约定不输出
    expect(r.contentType).toBeUndefined();
  });

  test('★ INV-5 回归: application/json → text 原样 (不被去标签)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('{"k":"v"}', { 'content-type': 'application/json' }),
    });
    const r = await p.fetch('https://e.example/data.json');
    expect(r.text).toBe('{"k":"v"}');
    expect(r.contentType).toBe('application/json');
  });

  test('★ INV-5 回归: text/plain → text 原样', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('line1\nline2', { 'content-type': 'text/plain' }),
    });
    const r = await p.fetch('https://e.example/note');
    expect(r.text).toBe('line1\nline2');
  });

  test('★ raw=true + 非 HTML 文本 content-type → 原样回 (旧行为不破)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: resp('<p>raw html</p>', { 'content-type': 'text/plain' }),
    });
    const r = await p.fetch('https://e.example/raw', { raw: true });
    expect(r.text).toBe('<p>raw html</p>');
  });
});
