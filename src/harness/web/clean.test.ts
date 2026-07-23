/**
 * web/clean 测试 —— HTML 兜底剥离 (Task A)。
 * 注入 fake base provider + PassthroughCleaner (真漏斗) → 不打网络 / Python。
 * 覆盖: 整页 HTML 剥出正文 (title 保留, nav/script 丢) · 剥后过短标失败 · 正常 markdown 零丢失。
 */
import { describe, expect, test } from 'bun:test';
import {
  CleaningFetchProvider,
  PassthroughCleaner,
  looksLikeRawHtml,
  stripHtmlToText,
} from './clean';
import type { FetchProvider, FetchResult } from './types';

/** raw:true 时吐给定文本的 fake provider (模拟 jina raw HTML)。 */
function fakeBase(text: string, name = 'jina'): FetchProvider {
  return {
    name,
    async fetch(url): Promise<FetchResult> {
      return { url, text, contentType: 'text/html' };
    },
  };
}

const PAGE = `<!doctype html>
<html><head><title>Fork a repo - GitHub Docs</title>
<style>.nav{color:red}</style>
<script>window.__DATA__={"junk":"应当被丢弃的脚本文本"}</script>
</head>
<body>
<nav><a href="/">Home</a><a href="/login">Sign in</a></nav>
<article>
<h1>Fork a repository</h1>
<p>A fork is a new repository that shares code &amp; visibility settings with the original.</p>
<p>You can fork a repo to propose changes or to use it as a starting point.</p>
</article>
<footer>© GitHub</footer>
</body></html>`;

describe('looksLikeRawHtml', () => {
  test('整页 HTML 骨架标签 → true', () => {
    expect(looksLikeRawHtml(PAGE)).toBe(true);
    expect(looksLikeRawHtml('<body>hi</body>')).toBe(true);
  });
  test('正常 markdown / 纯文本 → false (零丢失不触发)', () => {
    expect(looksLikeRawHtml('# 标题\n\n正文段落, 引用 [链接](http://x) 和 `code`。')).toBe(false);
    expect(looksLikeRawHtml('普通一句话, 偶尔一个 <br> 换行标签也不算 HTML 壳。')).toBe(false);
    expect(looksLikeRawHtml('')).toBe(false);
  });
  test('高标签密度片段 (无骨架) → true', () => {
    const dense = '<div><span></span><span></span><span></span><i></i><b></b></div>x';
    expect(looksLikeRawHtml(dense)).toBe(true);
  });
});

describe('stripHtmlToText', () => {
  test('title 保留, script/style/nav/footer 连内容丢, 实体解码', () => {
    const out = stripHtmlToText(PAGE);
    expect(out).toContain('# Fork a repo - GitHub Docs'); // title 置顶
    expect(out).toContain('Fork a repository');
    expect(out).toContain('shares code & visibility settings'); // &amp; 解码
    expect(out).not.toContain('应当被丢弃的脚本文本'); // script 内容丢
    expect(out).not.toContain('color:red'); // style 内容丢
    expect(out).not.toContain('Sign in'); // nav 内容丢
    expect(out).not.toMatch(/<[a-z]/i); // 无残留标签
  });
});

describe('CleaningFetchProvider HTML 兜底', () => {
  const pass = new PassthroughCleaner();

  test('passthrough 漏网的整页 HTML → 剥出正文喂语料', async () => {
    const p = new CleaningFetchProvider(fakeBase(PAGE), pass);
    const r = await p.fetch('http://docs.github.com/fork');
    expect(r.text).toContain('Fork a repository');
    expect(r.text).not.toContain('Sign in');
    expect(r.contentType).toBe('text/markdown');
  });

  test('剥离后正文过短 → 抛错标失败 (不喂壳渣)', async () => {
    const shell = '<html><head><title>t</title></head><body><nav><a>x</a></nav><script>var a=1</script></body></html>';
    const p = new CleaningFetchProvider(fakeBase(shell), pass, { minCleanChars: 200 });
    await expect(p.fetch('http://x')).rejects.toThrow(/正文过短/);
  });

  test('正常 markdown 内容 → 原样不动 (零丢失)', async () => {
    const md = '# 真实标题\n\n这是一段正常的 markdown 正文, 足够长以通过任何长度闸, '.repeat(4);
    const p = new CleaningFetchProvider(fakeBase(md), pass);
    const r = await p.fetch('http://blog.example.com/post');
    expect(r.text).toBe(md); // 逐字节原样 (含尾空格) → 零丢失
  });

  test('raw:true → 不清洗不剥离 (调用方要原始 HTML)', async () => {
    const p = new CleaningFetchProvider(fakeBase(PAGE), pass);
    const r = await p.fetch('http://x', { raw: true });
    expect(r.text).toBe(PAGE);
  });
});
