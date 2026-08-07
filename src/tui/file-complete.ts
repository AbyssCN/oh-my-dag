/**
 * src/tui/file-complete —— **模糊文件补全**(原生实现 owner 点名的 `pi-fff` 能力,2026-08-07)。
 *
 * ## 为什么原生做而不是装那个 extension
 *
 * `pi-fff` 从来没装过(读过 `~/.pi/agent/settings.json` 的 17 个包,里面没有它)——
 * 它是一个**能力需求**,不是现有依赖。而这个能力落在「要活对象」那一类:
 * 补全要挂进 editor 的按键循环、要往下拉框里塞组件 —— **出进程沙箱结构上托不了**。
 *
 * 更要紧的是:**pi-tui 自带了这件事的两块料** —— `AutocompleteProvider`
 * (还带 `shouldTriggerFileCompletion`)与 `fuzzyFilter` / `fuzzyMatch`。
 * 所以原生做 = 接现成件 + 一个文件枚举器,而不是重写一个模糊匹配器。
 *
 * ## 枚举:一次扫,带上限,尊重忽略名单
 *
 * 大仓里递归扫全部文件会卡住按键循环。所以:
 *  - 复用 `agent-tools` 已有的忽略名单(`.git` / `node_modules` / `dist` …)—— **不另写一份**;
 *  - 扫出来的结果**缓存**,过期重扫(补全期间文件不会每毫秒变);
 *  - 硬上限,超了就截断并**说出来**(下拉框里少几条而不解释,会让人以为文件不存在)。
 */
import { type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, fuzzyFilter } from '@earendil-works/pi-tui';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 与 `agent-tools` 同一份忽略名单 —— 两处各写一份必漂。 */
const IGNORED = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '.venv',
]);

/** 扫出来的文件上限。超了截断 —— 一个 20 万文件的仓不该把补全变成一次全盘扫描。 */
export const MAX_FILES = 20_000;
/** 缓存有效期:补全期间文件不会每毫秒变,但也不该一整个 session 都用同一份。 */
export const CACHE_TTL_MS = 10_000;

export interface FileScan {
  /** 相对 cwd 的路径,已排序。 */
  files: string[];
  /** 有没有撞上限被截断 —— **要说出来**,不解释的话人会以为文件不存在。 */
  truncated: boolean;
}

/** 递归枚举。**同步**:它跑在补全回调里,而那条路不能 await 一个目录树。 */
export function scanFiles(root: string, max = MAX_FILES): FileScan {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as import('node:fs').Dirent[];
    } catch {
      return; // 权限不足 / 竞态删除 —— 跳过这一支, 不让整次补全失败
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.omd') continue;
      if (IGNORED.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        if (out.length >= max) {
          truncated = true;
          return;
        }
        out.push(relative(root, p));
      }
    }
  };
  walk(root);
  return { files: out.sort(), truncated };
}

/**
 * 从光标位置往回取出正在打的那个"词"。
 *
 * ⚠ 以**空白**为界,不以路径分隔符为界:用户打 `src/tui/foo` 时想补的是整条路径,
 * 按 `/` 切会让每一段各补各的,补出来的东西对不上。
 */
export function tokenAt(line: string, col: number): { prefix: string; start: number } {
  const upto = line.slice(0, Math.max(0, col));
  const m = /(\S+)$/.exec(upto);
  return m ? { prefix: m[1] as string, start: col - (m[1] as string).length } : { prefix: '', start: col };
}

export interface FileCompleteDeps {
  cwd: string;
  /** 注入用(测试不扫真盘)。 */
  scan?: (root: string) => FileScan;
  now?: () => number;
  /** 触发补全的最短前缀 —— 打一个字符就弹出整仓文件没有意义。 */
  minPrefix?: number;
  maxSuggestions?: number;
}

/**
 * 造一个能挂进 `Editor.setAutocompleteProvider` 的 provider。
 *
 * 匹配走 pi-tui 的 `fuzzyFilter`(它支持空白/斜杠分词,所有 token 都要命中)——
 * **不自己写模糊匹配**:那是这一片原本要装 extension 去买的东西,而它就在依赖里。
 */
export function createFileCompleteProvider(deps: FileCompleteDeps): AutocompleteProvider {
  const scan = deps.scan ?? scanFiles;
  const now = deps.now ?? Date.now;
  const minPrefix = deps.minPrefix ?? 2;
  const maxSuggestions = deps.maxSuggestions ?? 12;
  let cache: { at: number; scan: FileScan } | null = null;

  const files = (): FileScan => {
    if (cache && now() - cache.at < CACHE_TTL_MS) return cache.scan;
    cache = { at: now(), scan: scan(deps.cwd) };
    return cache.scan;
  };

  return {
    triggerCharacters: ['@'],
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? '';
      const raw = tokenAt(line, cursorCol);
      // `@` 前缀是显式触发;否则要够长才弹 —— 打一个字符就铺整仓文件没有意义。
      const explicit = raw.prefix.startsWith('@');
      const query = explicit ? raw.prefix.slice(1) : raw.prefix;
      if (!explicit && query.length < minPrefix) return null;
      if (explicit && query.length === 0) return null;

      const { files: all, truncated } = files();
      const hits = fuzzyFilter(all, query, (f) => f).slice(0, maxSuggestions);
      if (hits.length === 0) return null;
      const items: AutocompleteItem[] = hits.map((f) => ({ value: f, label: f }));
      // ⚠ 截断了要**说出来** —— 下拉框里少几条而不解释, 人会以为那个文件不存在。
      // `AutocompleteSuggestions` 没有 footer 字段 (实读 autocomplete.d.ts:13),
      // 所以塞成最后一条**不可选**的说明项: value 留空, 选中它什么都不插入。
      if (truncated) items.push({ value: '', label: `(仓库文件超过 ${MAX_FILES}, 列表已截断)` });
      return { items, prefix: raw.prefix } satisfies AutocompleteSuggestions;
    },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      const line = lines[cursorLine] ?? '';
      const { start } = tokenAt(line, cursorCol);
      const next = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
      const copy = [...lines];
      copy[cursorLine] = next;
      return { lines: copy, cursorLine, cursorCol: start + item.value.length };
    },
  };
}
