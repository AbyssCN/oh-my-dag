/**
 * 扩展宿主(S15a,2026-08-07)。
 *
 * ## 这条测试起**真子进程**
 *
 * 三条 owner 裁决全在进程边界上兑现(沙箱 / 只能追加 / 加载期硬失败)——
 * 打桩掉子进程等于把被测的那条边一起打掉。夹具扩展是本目录下的 `__fixtures__/*.mjs`,
 * 它们是**我们自己写的**,不是第三方代码。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceAppendOnly } from './protocol';
import { loadExtension, missingApis, readExtensionList } from './host';

const FIX = join(import.meta.dir, '__fixtures__');
/** 沙箱在真跑里由 bwrap 提供;这里注入 `which: () => null` 走降级路径,免得测试依赖 bwrap 装没装。 */
const deps = (cwd: string) => ({ cwd, which: () => null, timeoutMs: 20_000 });

describe('enforceAppendOnly(owner 裁决 ①:只能追加)', () => {
  test('没返回 → 原样', () => {
    expect(enforceAppendOnly('AAA', undefined)).toEqual({ ok: true, value: 'AAA' });
  });

  test('追加 → 放行', () => {
    expect(enforceAppendOnly('AAA', 'AAA + 更多')).toEqual({ ok: true, value: 'AAA + 更多' });
  });

  test('★ 替换 → 拒绝, 并回**原串**', () => {
    const r = enforceAppendOnly('AAA', '换成别的');
    expect(r.ok).toBe(false);
    expect(r.value).toBe('AAA');
  });

  test('★ 判据是"以原串开头"不是"变长了" —— 后者挡不住改开头再接一大段', () => {
    expect(enforceAppendOnly('AAA', 'BAA + 很长很长的一段补充').ok).toBe(false);
  });

  test('返回非字符串 → 拒绝并说出实得类型', () => {
    const r = enforceAppendOnly('AAA', { systemPrompt: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('object');
  });
});

describe('missingApis', () => {
  test('实现了的不算缺', () => {
    expect(missingApis(['on', 'registerTool', 'on:before_agent_start'])).toEqual([]);
  });

  test('★ 没实现的逐条列出(这就是加载期硬失败的全部价值)', () => {
    expect(missingApis(['on', 'ctx.fork', 'registerShortcut', 'ctx.sessionManager'])).toEqual([
      'ctx.fork',
      'ctx.sessionManager',
      'registerShortcut',
    ]);
  });

  test('不支持的事件也算缺', () => {
    expect(missingApis(['on:session_start'])).toEqual(['on:session_start']);
  });
});

describe('★ 真子进程:加载一个合规扩展', () => {
  test('工具声明与事件都报上来了, 工具调得动', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('good', join(FIX, 'good.mjs'), deps(cwd));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      expect(r.ext.tools.map((t) => t.name)).toEqual(['fixture_echo']);
      expect(r.ext.events).toEqual(['before_agent_start']);
      expect(await r.ext.callTool('fixture_echo', { text: '你好' })).toBe('echo: 你好');
    } finally {
      r.ext.stop();
    }
  });

  test('★ before_agent_start 的追加被放行', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('good', join(FIX, 'good.mjs'), deps(cwd));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      expect(await r.ext.beforeAgentStart('原始前缀')).toBe('原始前缀\n[fixture 追加]');
    } finally {
      r.ext.stop();
    }
  });

  test('★ bwrap 不在时 sandboxed=false —— 响亮降级, 不假装隔离了', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('good', join(FIX, 'good.mjs'), deps(cwd));
    if (!r.ok) return;
    try {
      expect(r.ext.sandboxed).toBe(false);
    } finally {
      r.ext.stop();
    }
  });
});

describe('★ 真子进程:三种拒绝', () => {
  test('★ 试图替换 system prompt → 拦下, 用原串(owner 裁决 ③:block + 提醒)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('evil', join(FIX, 'replaces-prompt.mjs'), deps(cwd));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      // 它返回的是一段完全不同的 prompt —— 必须拿回原串。
      expect(await r.ext.beforeAgentStart('冻结前缀')).toBe('冻结前缀');
    } finally {
      r.ext.stop();
    }
  });

  test('★ 碰了没实现的 API → **加载期拒绝并逐条列出**, 不半残地跑起来', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('greedy', join(FIX, 'needs-more.mjs'), deps(cwd));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.missing).toContain('ctx.sessionManager');
    expect(r.rejected.missing).toContain('registerShortcut');
    expect(r.rejected.reason).toContain('没有这');
  });

  test('★ 加载就炸 → 带原文, 不只说"加载失败"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-'));
    const r = await loadExtension('broken', join(FIX, 'throws.mjs'), deps(cwd));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejected.reason).toContain('故意炸的');
  });
});

describe('readExtensionList', () => {
  test('没配过扩展不是错误 → 空数组', () => {
    expect(readExtensionList(mkdtempSync(join(tmpdir(), 'omd-ext-none-')))).toEqual([]);
  });

  test('★ 入口文件不存在的条目**跳过并记一行**, 不让整份清单作废', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-list-'));
    require('node:fs').mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(
      join(cwd, '.omd', 'extensions.json'),
      JSON.stringify({ extensions: [{ name: 'gone', entry: '/nope/x.mjs' }, { name: 'good', entry: join(FIX, 'good.mjs') }] }),
    );
    expect(readExtensionList(cwd).map((e) => e.name)).toEqual(['good']);
  });

  test('坏 JSON → 当没配扩展, 不抛', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-ext-bad-'));
    require('node:fs').mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'extensions.json'), '{ 坏的');
    expect(readExtensionList(cwd)).toEqual([]);
  });
});
