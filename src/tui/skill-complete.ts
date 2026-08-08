/**
 * src/tui/skill-complete —— **skill 补全三段式**(切片④,G-4;owner 裁决:平时 umbrella,
 * 打 `/omd-` 要展开成员并显示描述)。
 *
 * | 打的是 | 出什么 | 谁出的 |
 * |---|---|---|
 * | `/`(或 `/om`) | 基础命令 + **组**(`omd` `lark` …),**不摊开成员** | pi-tui 的命令 fuzzy(静态清单) |
 * | `/omd-` | **全名成员**(`omd-council` …),每条带描述 | 本文件的 stage-2 拦截 |
 * | `/omd `(空格) | **不带前缀的成员**(`council` …),每条带描述 | pi-tui 原生 `getArgumentCompletions`(本文件补挂) |
 *
 * ## 为什么是"包一层"而不是重写 provider
 *
 * pi-tui 的 `CombinedAutocompleteProvider` 已经做对了两段:命令 fuzzy 与参数补全钩子。
 * 缺的只有一段 —— `/omd-c` 这种**带连字符的组前缀**在它的 fuzzy 里匹配不到命令 `omd`,
 * 出来是空。所以只拦这一段,其余原样透传(重写整个 provider = 把 pi 已经修好的
 * 文件补全/路径展开全部再走一遍雷区)。
 *
 * ## 成员清单带 TTL 缓存
 *
 * 每敲一个字符扫一遍一百多个 skill 目录不值当;但启动时算死又会"装了新 skill 看不见"。
 * 折中:5s TTL —— 补全期内是新的,键击之间不重扫。
 */
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import type { SkillGrouping } from './skills';

/** pi-tui 的补全条目形状(它的 d.ts 未导出,这里按契约复述)。 */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

interface SlashCommandLike {
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?(argumentPrefix: string): CompletionItem[] | null;
}

/** `/omd-coun` 这一段的形状:组名 + 已敲的成员半截。不匹配返回 `null`。 */
export function parseStageTwo(textBeforeCursor: string): { group: string; partial: string } | null {
  const m = /^\/([a-z0-9]+)-([a-z0-9-]*)$/i.exec(textBeforeCursor.trimStart());
  if (!m) return null;
  return { group: m[1] as string, partial: m[2] as string };
}

/** stage-2:`/omd-` → 全名成员,每条带描述。组不存在 → `null`(交回 pi 的 fuzzy)。 */
export function stageTwoItems(textBeforeCursor: string, grouping: SkillGrouping): CompletionItem[] | null {
  const p = parseStageTwo(textBeforeCursor);
  if (!p) return null;
  const group = grouping.groups.find((g) => g.name === p.group);
  if (!group) return null;
  const want = `${p.group}-${p.partial}`;
  const hits = group.members
    .filter((m) => m.name.startsWith(want))
    .map((m) => ({ value: m.name, label: m.name, ...(m.description ? { description: m.description } : {}) }));
  return hits.length > 0 ? hits : null;
}

/** stage-3:`/omd c` → 不带前缀的成员。挂在组命令的 `getArgumentCompletions` 上。 */
export function memberArgItems(groupName: string, argPrefix: string, grouping: SkillGrouping): CompletionItem[] | null {
  const group = grouping.groups.find((g) => g.name === groupName);
  if (!group) return null;
  const bare = argPrefix.trim();
  const hits = group.members
    .map((m) => ({ full: m.name, short: m.name.slice(groupName.length + 1), description: m.description }))
    .filter((m) => m.short.startsWith(bare))
    .map((m) => ({ value: m.short, label: m.short, ...(m.description ? { description: m.description } : {}) }));
  return hits.length > 0 ? hits : null;
}

export interface OmdProviderOpts {
  /** `slashCommands(...)` 的产物(静态清单 —— stage-1 的形状就是它)。 */
  commands: SlashCommandLike[];
  cwd: string;
  /** 组与成员的实时来源(内部带 TTL 缓存)。 */
  grouping: () => SkillGrouping;
  /** 缓存 TTL(ms)。默认 5000。测试给 0 关缓存。 */
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * 三段式 provider:stage-2 自己拦,stage-1/3 透传给 pi-tui
 * (stage-3 靠**在组命令上补挂** `getArgumentCompletions` 实现 —— 挂完后 pi 原生就会调)。
 */
export function createOmdAutocompleteProvider(o: OmdProviderOpts) {
  const now = o.now ?? Date.now;
  const ttl = o.cacheTtlMs ?? 5000;
  let cached: { at: number; g: SkillGrouping } | null = null;
  const grouping = (): SkillGrouping => {
    if (cached && now() - cached.at < ttl) return cached.g;
    cached = { at: now(), g: o.grouping() };
    return cached.g;
  };

  // stage-3 接线: 名字命中组的命令补挂参数补全 (原对象不动 —— 它可能被 /help 共用)。
  const groupNames = new Set(grouping().groups.map((g) => g.name));
  const commands = o.commands.map((c) =>
    groupNames.has(c.name) ? { ...c, getArgumentCompletions: (arg: string) => memberArgItems(c.name, arg, grouping()) } : c,
  );
  const inner = new CombinedAutocompleteProvider(commands as never, o.cwd);

  return {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
      const text = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const items = stageTwoItems(text, grouping());
      // prefix = 整个 `/omd-coun` 段 (不 trim —— applyCompletion 按它的长度回推起点)。
      if (items) return Promise.resolve({ items, prefix: text });
      return inner.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: CompletionItem, prefix: string) {
      const text = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const p2 = parseStageTwo(text);
      if (p2 && item.value.startsWith(`${p2.group}-`)) {
        // stage-2: 把 `/omd-coun` 整段换成 `/omd-council ` (尾空格 = 可以直接接补充说明)。
        const start = cursorCol - prefix.length;
        const line = lines[cursorLine] ?? '';
        const next = `${line.slice(0, start)}/${item.value} ${line.slice(cursorCol)}`;
        const out = [...lines];
        out[cursorLine] = next;
        return { lines: out, cursorLine, cursorCol: start + item.value.length + 2 };
      }
      return inner.applyCompletion(lines, cursorLine, cursorCol, item as never, prefix);
    },
    shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
      return inner.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
    },
  };
}
