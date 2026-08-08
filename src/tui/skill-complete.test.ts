/**
 * L1/L2:skill 补全三段式(切片④,G-4)。
 *
 * 反向自检:
 * - 「`/` 只出组不摊开成员」—— 把 stage-1 断言里的 not.toContain 翻成 toContain 当场红;
 *   真正的失效形状是把成员也塞进静态清单,那时这条抓得住。
 * - 「stage-2 只认存在的组」—— `/xyz-` 走回 pi fuzzy(返回空不返回成员)。
 */
import { describe, expect, test } from 'bun:test';
import type { SkillGrouping } from './skills';
import { createOmdAutocompleteProvider, memberArgItems, parseStageTwo, stageTwoItems } from './skill-complete';

const grouping: SkillGrouping = {
  groups: [
    {
      name: 'omd',
      members: [
        { name: 'omd-council', description: '多视角议会', root: '/r' },
        { name: 'omd-debug', description: '根因调试', root: '/r' },
        { name: 'omd-video', description: null, root: '/r' },
      ],
    },
  ],
  loners: [],
};

const commands = [
  { name: 'help', description: '列出这张表' },
  { name: 'omd', description: '3 条 omd-* skill', argumentHint: '[成员]' },
];

const provider = () => createOmdAutocompleteProvider({ commands, cwd: process.cwd(), grouping: () => grouping, cacheTtlMs: 0 });

const suggest = async (line: string) => {
  const p = provider();
  return p.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
};

describe('parseStageTwo', () => {
  test('认 /omd- 与 /omd-cou; 不认无连字符、不认带空格的', () => {
    expect(parseStageTwo('/omd-')).toEqual({ group: 'omd', partial: '' });
    expect(parseStageTwo('/omd-cou')).toEqual({ group: 'omd', partial: 'cou' });
    expect(parseStageTwo('/omd')).toBe(null);
    expect(parseStageTwo('/omd co')).toBe(null);
    expect(parseStageTwo('omd-')).toBe(null);
  });
});

describe('三段各自的形状', () => {
  test('★ stage-1: `/` 只出命令与组, 不摊开成员', async () => {
    const s = await suggest('/');
    const values = (s?.items ?? []).map((i) => i.value);
    expect(values).toContain('omd');
    expect(values).toContain('help');
    expect(values).not.toContain('omd-council'); // 成员不在 `/` 一层
  });

  test('★ stage-2: `/omd-` 出全名成员且带描述; `/omd-c` 收窄', () => {
    const items = stageTwoItems('/omd-', grouping);
    expect(items?.map((i) => i.value)).toEqual(['omd-council', 'omd-debug', 'omd-video']);
    expect(items?.[0]?.description).toBe('多视角议会');
    expect(stageTwoItems('/omd-c', grouping)?.map((i) => i.value)).toEqual(['omd-council']);
  });

  test('stage-2: 没描述的成员不编一个(description 字段缺席, 不是空串)', () => {
    const video = stageTwoItems('/omd-v', grouping)?.[0];
    expect(video?.value).toBe('omd-video');
    expect('description' in (video ?? {})).toBe(false);
  });

  test('stage-2: 组不存在 → null(交回 pi 的 fuzzy, 不编成员)', () => {
    expect(stageTwoItems('/xyz-', grouping)).toBe(null);
  });

  test('★ stage-3: `/omd c` 出不带前缀的成员', async () => {
    const s = await suggest('/omd c');
    expect(s?.items.map((i) => i.value)).toEqual(['council']);
    expect(s?.items[0]?.description).toBe('多视角议会');
    // 空参数 → 全部成员 (裸名)
    const all = await suggest('/omd ');
    expect(all?.items.map((i) => i.value)).toEqual(['council', 'debug', 'video']);
  });

  test('memberArgItems: 组不存在 → null', () => {
    expect(memberArgItems('nope', '', grouping)).toBe(null);
  });
});

describe('applyCompletion(stage-2 的整段替换)', () => {
  test('★ `/omd-cou` 选中 omd-council → `/omd-council ` 光标在尾', () => {
    const p = provider();
    const line = '/omd-cou';
    const r = p.applyCompletion([line], 0, line.length, { value: 'omd-council', label: 'omd-council' }, line);
    expect(r.lines[0]).toBe('/omd-council ');
    expect(r.cursorCol).toBe('/omd-council '.length);
  });
});

describe('缓存', () => {
  test('TTL 内不重扫; 过期重扫(装新 skill 不用重启)', async () => {
    let clock = 0;
    let scans = 0;
    const p = createOmdAutocompleteProvider({
      commands,
      cwd: process.cwd(),
      grouping: () => {
        scans += 1;
        return grouping;
      },
      cacheTtlMs: 5000,
      now: () => clock,
    });
    await p.getSuggestions(['/omd-'], 0, 5, { signal: new AbortController().signal });
    await p.getSuggestions(['/omd-c'], 0, 6, { signal: new AbortController().signal });
    const before = scans;
    clock = 6000;
    await p.getSuggestions(['/omd-d'], 0, 6, { signal: new AbortController().signal });
    expect(scans).toBeGreaterThan(before);
    expect(before).toBeLessThanOrEqual(2); // 构造时 1 次 + 首次补全 1 次; 键击之间没有再扫
  });
});
