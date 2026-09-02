/**
 * dotenv-isolation 的纯函数半 —— **零副作用**, 测试可以放心 import。
 * 副作用 (真删 process.env) 只在 `dotenv-isolation.ts` (preload) 里; 闸要是 import 了那个文件,
 * import 的副作用就替 preload 把键删了, 闸永远绿 (2026-09-03 反向自检当场抓到, 因此拆成两个文件)。
 */

/** `.env` 文本 → 键名列表 (只认 `KEY=` / `export KEY=` 行; 注释、空行、畸形行跳过; 保序去重)。 */
export function dotenvKeyNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 从 env 里删掉这些键, 返回真删掉的 (原本就不在的不算)。 */
export function stripKeys(env: Record<string, string | undefined>, keys: readonly string[]): string[] {
  const removed: string[] = [];
  for (const k of keys) {
    if (env[k] === undefined) continue;
    delete env[k];
    removed.push(k);
  }
  return removed;
}

/** preload 留给闸的标记: 本进程删掉的键名, 逗号连接 (空串 = 一个没删)。闸读它, 不 import preload。 */
export const STRIPPED_MARKER = 'OMD_TEST_DOTENV_STRIPPED';
