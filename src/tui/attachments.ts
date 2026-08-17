/**
 * src/tui/attachments —— **图片附件的判定半**(W5 片1,契约 I1/I2/I5)。
 *
 * 判定**保守**(I1):只认 `@` 引用的、存在的、图片扩展名的、≤5MB 的文件;
 * 其余一律原样当文本 —— 误吃一段话里的路径比漏附一张图严重。
 * 文本不动(I2):附件是**加**不是**换**,`@路径` 字样留在 prompt 里。
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface ImageRef {
  /** prompt 里写的原样(不含 `@`)。 */
  ref: string;
  bytes: number;
  mimeType: string;
  /** base64 —— pi 的 `ImageContent.data` 形。 */
  data: string;
}

export interface ExtractResult {
  images: ImageRef[];
  /** 读不出/超限的**说出来**(I5),不静默跳过。 */
  skipped: { ref: string; reason: string }[];
}

/** `@a.png` / `@dir/b.jpg` —— 与文件补全同一入口语法;空白截断。 */
const REF_RE = /@([^\s@]+\.(?:png|jpg|jpeg|gif|webp))/gi;

export function extractImageRefs(prompt: string, cwd: string): ExtractResult {
  const images: ImageRef[] = [];
  const skipped: { ref: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const m of prompt.matchAll(REF_RE)) {
    const ref = m[1]!;
    if (seen.has(ref)) continue; // 同图引两次附一次 —— 附两份是纯浪费
    seen.add(ref);
    const abs = isAbsolute(ref) ? ref : join(cwd, ref);
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        skipped.push({ ref, reason: 'not a file' });
        continue;
      }
      if (st.size > IMAGE_MAX_BYTES) {
        skipped.push({ ref, reason: `${(st.size / 1024 / 1024).toFixed(1)}MB exceeds the 5MB cap` });
        continue;
      }
      const ext = ref.toLowerCase().split('.').pop()!;
      images.push({ ref, bytes: st.size, mimeType: MIME[ext]!, data: readFileSync(abs).toString('base64') });
    } catch (err) {
      // 不存在的引用不是错误 —— `@` 也可能只是在说话; 但读到一半失败要说出来。
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') continue;
      skipped.push({ ref, reason: (err as Error).message });
    }
  }
  return { images, skipped };
}

/** 回执那半句:`a.png (120KB)` —— CHROME 用它拼一行。 */
export function fmtAttachment(a: Pick<ImageRef, 'ref' | 'bytes'>): string {
  const kb = a.bytes / 1024;
  return `${a.ref} (${kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(kb))}KB`})`;
}
