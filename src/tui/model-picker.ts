/**
 * src/tui/model-picker —— **模型选单**(S-7,2026-08-07,owner 点名)。
 *
 * ## 它补的是"盲打"
 *
 * `/seat` 选完座位之后是一个 `dialogInput`:让人**凭记忆敲** `provider:model`。
 * owner 的原话是"就算是很基础的 pi 的 model 也列出了 list" —— pi 那边是
 * `→ deepseek-v4-flash [deepseek] ✓` 一条条列出来、可搜索、有计数。
 * 敲错一个字符的代价是座位改成一个不存在的坐标,而**回执照样说"改好了"**
 * (它只写文件,不校验坐标是否可解析)—— 这正是要用选单而不是输入框的理由。
 *
 * ## 目录从哪来
 *
 * `listProviders()`(已注册的 provider)× `listModelIds(p)`(models.json 里登记的 id)。
 * 两者都已存在,这里只做**组合与排序**,不新造数据源。
 *
 * ⚠ 目录**可能是空的**(没配过 models.json / provider 没注册)。空目录时调用方
 * 必须退回手输,而不是开一个空框 —— 开空框等于把人锁死在一个只能按 Esc 的界面里。
 */

export interface ModelChoice {
  provider: string;
  id: string;
  /** `provider:model` —— 座位配置里存的就是这个形状。 */
  coord: string;
}

export interface ModelCatalogDeps {
  /** 注入用。默认真的 `listProviders()`。 */
  providers?: () => string[];
  /** 注入用。默认真的 `listModelIds(provider)`。 */
  models?: (provider: string) => string[];
}

/** 组合出全部候选。**去重**:同一个 `provider:model` 出现两次是配置问题,不该让人看见两行。 */
export function listModelChoices(deps: ModelCatalogDeps = {}): ModelChoice[] {
  const providers = deps.providers ?? (() => require('../model/providers').listProviders() as string[]);
  const models = deps.models ?? ((p: string) => require('../model/models-json').listModelIds(p) as string[]);
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const provider of providers()) {
    for (const id of models(provider)) {
      const coord = `${provider}:${id}`;
      if (seen.has(coord)) continue;
      seen.add(coord);
      out.push({ provider, id, coord });
    }
  }
  return out;
}

/**
 * 排序:**当前那个排最前**,其余按 provider 再按 id。
 *
 * 当前项排最前是照 pi 的做法(`model-selector.js:sortModels`)。理由不是好看:
 * 选单打开时光标默认落在第一行,而人最常做的操作是"看一眼现在是什么"再决定换不换。
 */
export function sortChoices(choices: readonly ModelChoice[], current: string | null): ModelChoice[] {
  // ★ **当前那个不在目录里时, 补一条进去。** 实测撞到:座位是 `kimi-coding:k3`,
  //   而 `kimi-coding` 这个 provider 没注册(没配 key), 于是选单里既没有它、也没有任何 ✓ ——
  //   人看到的是"22 个模型, 一个都不是我现在用的", 而真相是**当前那个没被列出来**。
  //   一个连"现在是什么"都答不出的选单是误导性的。
  const withCurrent =
    current && !choices.some((c) => c.coord === current) ? [parseCoord(current), ...choices] : [...choices];
  return withCurrent.sort((a, b) => {
    const ac = a.coord === current;
    const bc = b.coord === current;
    if (ac !== bc) return ac ? -1 : 1;
    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
}

/** `provider:model` → 结构。**只切第一个冒号** —— 模型 id 里可以有冒号, provider 名里不能。 */
export function parseCoord(coord: string): ModelChoice {
  const i = coord.indexOf(':');
  if (i <= 0) return { provider: '?', id: coord, coord };
  return { provider: coord.slice(0, i), id: coord.slice(i + 1), coord };
}

/** 一行的样子:`<id>  [provider]` + 当前项挂 `✓`。字形都在白名单里。 */
export function choiceLabel(c: ModelChoice, current: string | null): string {
  return `${c.id}  [${c.provider}]${c.coord === current ? ' ✓' : ''}`;
}

/**
 * 模糊过滤。匹配的是 `id`、`provider` 与完整坐标 —— 三者都要:
 * 人可能记得 provider(`deepseek`)、可能记得型号(`v4-flash`),也可能整串粘贴。
 *
 * ⚠ 大小写不敏感。**子序列不做** —— pi 用 `fuzzyFilter` 的子序列匹配,而那会让
 * `dsf` 匹上一堆看不出为什么匹上的条目;这里只做子串,匹上的理由一眼可见。
 */
export function filterChoices(choices: readonly ModelChoice[], query: string): ModelChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...choices];
  return choices.filter((c) => c.coord.toLowerCase().includes(q));
}

/** `/models`(或 `/model`)的解析。纯函数 —— 分发那一层不是 async, 解析必须能同步问。 */
export function parseModelsCommand(text: string): boolean {
  const t = text.trim();
  return t === '/models' || t === '/model';
}
