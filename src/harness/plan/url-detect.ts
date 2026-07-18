/**
 * plan/url-detect —— 从用户输入识别 URL (D 子系统: 自动摄取 the owner 粘贴的链接)。纯函数, 可单测。
 */

const URL_RE = /https?:\/\/[^\s<>()"'`]+/g;

/** 提取文本中的 http(s) URL, 去重 + 剥尾随标点 (含 markdown `)` 与 angle-bracket `<url>`)。 */
export function extractUrls(text: string): string[] {
  const m = text.match(URL_RE);
  if (!m) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of m) {
    const url = raw.replace(/[.,;:!?)\]}>'"]+$/, '');
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** 去掉文本里的 URL, 留下用户的框定语 (作蒸馏 focus)。 */
export function stripUrls(text: string): string {
  return text.replace(URL_RE, '').replace(/\s+/g, ' ').trim();
}
