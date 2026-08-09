/**
 * L1 判据:座位选择器(TUI SDD 切片 S12)。
 *
 * goal §4 点名的那条:**列的是座位视图,不是裸模型列表**。所以这里钉的是
 * "职责/建议这两列真的来自座位登记表" —— 如果它们来自这个文件自己写的常量,
 * 就成了第二份登记表,而两份必漂。
 */
import { describe, expect, test } from 'bun:test';
import { TUNABLE_CONFIG_ROLES } from '../harness/init/headless-config';
import { seatSpec } from '../model/seats';
import { formatSeatRows, parseSeatCommand, seatRows } from './seat-picker';

describe('parseSeatCommand', () => {
  test('不是 /seat 的一律不接管 —— 普通输入必须照常发给模型', () => {
    expect(parseSeatCommand('帮我看看 DAG')).toBeNull();
    expect(parseSeatCommand('/seatbelt 什么的')).toBeNull();
    expect(parseSeatCommand('前面有字 /seat')).toBeNull();
  });

  test('裸 /seat → 列表', () => {
    expect(parseSeatCommand('/seat')).toEqual({ kind: 'list' });
    expect(parseSeatCommand('  /seat  ')).toEqual({ kind: 'list' });
  });

  test('★ 只给 role 不给坐标 → 说清用法, 不当成"设置成空"', () => {
    const r = parseSeatCommand('/seat conductor');
    expect(r?.kind).toBe('usage');
    expect((r as { reason: string }).reason).toContain('/seat <');
  });

  test('role + 坐标 → 设置', () => {
    expect(parseSeatCommand('/seat conductor kimi-coding:k3')).toEqual({
      kind: 'set', role: 'conductor', coord: 'kimi-coding:k3',
    });
  });
});

describe('★ 座位视图来自登记表, 不是第二份常量', () => {
  test('职责与建议逐字来自 src/model/seats.ts', () => {
    const rows = seatRows({ conductor: 'a:1' });
    const conductor = rows.find((r) => r.role === 'conductor');
    expect(conductor?.what).toBe(seatSpec('conductor')?.what as string);
    expect(conductor?.recommend).toBe(seatSpec('conductor')?.recommend as string);
  });

  test('列的正是**可调的那几个** —— 铺出 30 个改不动的座位没有用', () => {
    expect(seatRows({}).map((r) => r.role)).toEqual([...TUNABLE_CONFIG_ROLES]);
  });

  test('★ 解析不出坐标的座位画 (未解析), 不拿别的档冒充', () => {
    // verifier 不在 resolveEngineModels 的返回里 —— 那一格的真值就是"没解析到"。
    const rows = seatRows({ conductor: 'a:1', leaf: 'b:2' });
    expect(rows.find((r) => r.role === 'verifier')?.coord).toBe('(unresolved)');
  });

  test('登记表里查不到的座位 → what/recommend 是 null, 不编一句', () => {
    // 这条钉的是"没有就说没有"这一半 —— 视图层不许替登记表补内容。
    const rows = seatRows({});
    for (const r of rows) {
      if (!seatSpec(r.role)) expect(r.what).toBeNull();
    }
  });
});

describe('formatSeatRows', () => {
  test('说清改的是哪个文件 —— 别让人猜它生效了没', () => {
    const out = formatSeatRows(seatRows({ conductor: 'a:1' }));
    expect(out).toContain('.omd/config.json');
    expect(out).toContain('conductor: a:1');
    expect(out).toContain('/seat <role> <provider:model>');
  });

  test('缺字段画 `-`', () => {
    expect(formatSeatRows([{ role: 'x', coord: 'c', what: null, recommend: null }])).toContain('pick: -');
  });
});
