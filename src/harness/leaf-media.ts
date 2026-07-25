/**
 * src/harness/leaf-media —— D-14v2 多模态媒体管道的执行期解析件 (SDD v2 S4)。
 *
 * attach_media:true 的 leaf 在执行期从**直接前驱的原始输出**(非 fan-in 摘要 — 摘要可能丢路径)
 * 解析图片引用 → 存在性校验 → 编码 ContentPart[] (本地文件读盘转 data URI; http(s) URL 直通),
 * 由 executor-dag 注入 inproc leaf 的 user 消息 (模型由 stamp pass 分到 multimodal 池)。
 *
 * Invariants:
 *  MEDIA-1 纯解析零 LLM: 本模块只做正则提取 + fs 读取 + base64 编码, 不调模型。
 *  MEDIA-2 无静默丢弃: 解析到但没附上的引用全部进 missing/skipped 返回值, 由调用方留痕。
 *  MEDIA-3 有界载荷: 图片数量/单图字节数有硬顶 (超限进 skipped, 不炸 provider 请求体)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import type { ContentPart } from '../model/gateway';

/** 支持的图片扩展名 → mime (与 multimodal-route-extension 的 IMAGE_MIME 同词表)。 */
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * 行内图片引用: http(s) URL 或本地路径 (绝对/相对), 以图片扩展名结尾。
 * 含空格的路径不支持 (v1 — 渲染节点自产截图路径无空格; 引号包裹路径的空格支持留到有真实需求)。
 */
const MEDIA_REF_RE = /(?:https?:\/\/[^\s"'`)\]}>]+|[\w./~-][\w./@~-]*)\.(?:png|jpe?g|gif|webp|bmp)\b/gi;

/** 从一段文本提取全部图片引用 (去重, 保出现序)。纯函数。 */
export function extractMediaRefs(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MEDIA_REF_RE)) seen.add(m[0]);
  return [...seen];
}

export interface DepMediaResult {
  /** 编码好的 image parts (data URI / http URL 直通), 注入 user 消息用。 */
  parts: ContentPart[];
  /** 成功附上的引用 (日志/审计)。 */
  attached: string[];
  /** 解析到但存在性校验失败的本地路径 (MEDIA-2 留痕, fail-closed 判据的证据)。 */
  missing: string[];
  /** 超限被丢弃的引用 (数量 cap / 单图过大 / 读盘失败; MEDIA-2 no silent caps)。 */
  skipped: string[];
}

/** MEDIA-3 缺省硬顶: 单 leaf 最多 8 图 (UI best-of-N 截图批的合理上界), 单图 ≤20MB。 */
const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 直接前驱输出 → 媒体 parts。本地路径相对 root 解析 (repoRoot; 渲染 command 节点的 cwd 锚)。
 * http(s) URL 不做存在性校验直通 (由 provider 端取; 校验会引入网络 IO 与执行耦合)。
 */
export function collectDepMedia(
  depTexts: string[],
  opts: { root: string; maxImages?: number; maxBytesPerImage?: number },
): DepMediaResult {
  const maxImages = opts.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxBytes = opts.maxBytesPerImage ?? DEFAULT_MAX_BYTES;
  const refs = [...new Set(depTexts.flatMap(extractMediaRefs))];
  const out: DepMediaResult = { parts: [], attached: [], missing: [], skipped: [] };
  for (const ref of refs) {
    if (out.parts.length >= maxImages) {
      out.skipped.push(ref);
      continue;
    }
    if (/^https?:\/\//i.test(ref)) {
      out.parts.push({ type: 'image_url', image_url: { url: ref } });
      out.attached.push(ref);
      continue;
    }
    const abs = isAbsolute(ref) ? ref : join(opts.root, ref);
    if (!existsSync(abs)) {
      out.missing.push(ref);
      continue;
    }
    try {
      if (statSync(abs).size > maxBytes) {
        out.skipped.push(ref);
        continue;
      }
      const mime = IMAGE_EXT_MIME[extname(abs).toLowerCase()] ?? 'image/png';
      const b64 = readFileSync(abs).toString('base64');
      out.parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
      out.attached.push(ref);
    } catch {
      out.skipped.push(ref); // 读盘竞态 (存在性判后被删) → 留痕不炸节点
    }
  }
  return out;
}
