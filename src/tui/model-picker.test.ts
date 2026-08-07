/**
 * L1 判据:模型选单(S-7)。
 *
 * 起因是 owner 的原话——"就算是很基础的 pi 的 model 也列出了 list"。
 * 此前 `/seat` 选完座位是一个输入框, 让人凭记忆敲 `provider:model`;
 * 敲错的代价不是报错, 是座位被改成一个**不存在的坐标**而回执照样说"改好了"。
 */
import { describe, expect, test } from 'bun:test';
import { findRiskyGlyphs } from './render/glyphs';
import { type ModelChoice, choiceLabel, filterChoices, listModelChoices, parseCoord, parseModelsCommand, sortChoices } from './model-picker';

const deps = {
  providers: () => ['deepseek', 'kimi-coding'],
  models: (p: string) => (p === 'deepseek' ? ['v4-flash', 'v4-pro'] : ['k3']),
};

describe('目录', () => {
  test('provider × model 组合成坐标', () => {
    expect(listModelChoices(deps).map((c) => c.coord)).toEqual(['deepseek:v4-flash', 'deepseek:v4-pro', 'kimi-coding:k3']);
  });

  test('★ 同一坐标只出现一次 —— 重复是配置问题, 不该让人看见两行', () => {
    const dup = { providers: () => ['a', 'a'], models: () => ['m'] };
    expect(listModelChoices(dup)).toHaveLength(1);
  });

  test('★ 一个 provider 一个模型都没登记时不报错, 只是没有它的条目', () => {
    const empty = { providers: () => ['x', 'y'], models: (p: string) => (p === 'x' ? ['m'] : []) };
    expect(listModelChoices(empty).map((c) => c.coord)).toEqual(['x:m']);
  });

  test('目录整个是空的 → 空数组(调用方据此退回手输, 不开空框)', () => {
    expect(listModelChoices({ providers: () => [], models: () => [] })).toEqual([]);
  });
});

describe('排序', () => {
  const all = listModelChoices(deps);

  // ★ 照 pi 的做法(model-selector.js:sortModels)。理由不是好看:选单打开时光标默认落第一行,
  //   而人最常做的是"看一眼现在是什么"再决定换不换。
  test('★ 当前那个排最前', () => {
    expect(sortChoices(all, 'kimi-coding:k3')[0]?.coord).toBe('kimi-coding:k3');
  });

  test('没有当前项(座位没配过)也不炸, 按 provider 排', () => {
    expect(sortChoices(all, null).map((c) => c.coord)).toEqual(['deepseek:v4-flash', 'deepseek:v4-pro', 'kimi-coding:k3']);
  });

  // ★ 实测撞到:座位是 kimi-coding:k3, 而那个 provider 没注册 —— 选单里既没有它也没有任何 ✓,
  //   人看到的是"22 个模型, 一个都不是我在用的", 而真相是当前那个没被列出来。
  test('★ 当前项不在目录里时补一条进去并排最前 —— 选单必须答得出"现在是什么"', () => {
    // ⚠ 这里的坐标必须**真的不在**上面那份夹具目录里。第一版用了 kimi-coding:k3,
    //   而它就在目录里 —— 于是这条测的是别的事, 当场红。判据自己也会写错。
    const absent = 'anthropic:claude-x';
    const out = sortChoices(all, absent);
    expect(out).toHaveLength(4);
    expect(out[0]?.coord).toBe(absent);
    expect(choiceLabel(out[0] as ModelChoice, absent)).toContain('✓');
  });

  test('坐标只切第一个冒号 —— 模型 id 里可以有冒号', () => {
    expect(parseCoord('p:a:b')).toEqual({ provider: 'p', id: 'a:b', coord: 'p:a:b' });
    expect(parseCoord('没有冒号')).toEqual({ provider: '?', id: '没有冒号', coord: '没有冒号' });
  });

  test('不改动入参数组 —— 排序是纯的', () => {
    const before = all.map((c) => c.coord);
    sortChoices(all, 'kimi-coding:k3');
    expect(all.map((c) => c.coord)).toEqual(before);
  });
});

describe('标签', () => {
  const c: ModelChoice = { provider: 'deepseek', id: 'v4-flash', coord: 'deepseek:v4-flash' };

  test('★ 当前项挂 ✓, 其余不挂 —— 否则"现在用的是哪个"看不出来', () => {
    expect(choiceLabel(c, 'deepseek:v4-flash')).toContain('✓');
    expect(choiceLabel(c, 'kimi-coding:k3')).not.toContain('✓');
  });

  test('带 provider 徽标 —— 同名模型在不同 provider 下是两回事', () => {
    expect(choiceLabel(c, null)).toContain('[deepseek]');
  });

  test('★ 用到的字形都在白名单里', () => {
    expect(findRiskyGlyphs(choiceLabel(c, 'deepseek:v4-flash'))).toEqual([]);
  });
});

describe('搜索', () => {
  const all = listModelChoices(deps);

  test('按型号、按 provider、按整串都能搜到', () => {
    expect(filterChoices(all, 'v4-pro').map((c) => c.coord)).toEqual(['deepseek:v4-pro']);
    expect(filterChoices(all, 'kimi')).toHaveLength(1);
    expect(filterChoices(all, 'deepseek:v4-flash')).toHaveLength(1);
  });

  test('大小写不敏感', () => {
    expect(filterChoices(all, 'K3')).toHaveLength(1);
  });

  test('空查询给全表(不是空表)', () => {
    expect(filterChoices(all, '   ')).toHaveLength(3);
  });

  // ★ 刻意**不做子序列匹配**:pi 用 fuzzyFilter, 而 `dsf` 会匹上一堆看不出为什么匹上的条目。
  test('★ 子序列不算命中 —— 匹上的理由要一眼可见', () => {
    expect(filterChoices(all, 'dsf')).toEqual([]);
  });

  test('搜不到就是空 —— 调用方画"没有匹配", 不回退成全表', () => {
    expect(filterChoices(all, 'zzz')).toEqual([]);
  });
});

describe('命令解析', () => {
  test('/models 与 /model 都认', () => {
    expect(parseModelsCommand('/models')).toBe(true);
    expect(parseModelsCommand(' /model ')).toBe(true);
  });

  test('★ 带参数的不接管 —— 免得把别的意图吃掉', () => {
    expect(parseModelsCommand('/models auto')).toBe(false);
    expect(parseModelsCommand('/modelsomething')).toBe(false);
    expect(parseModelsCommand('说说模型')).toBe(false);
  });
});
