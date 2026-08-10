/**
 * 模板卡 frontmatter `mcp` 解析契约测试 (开放生态 D-3; S2 verification-gap 修复)。
 * 生产加载器 loadAgentTemplates + 真 tmp 目录真卡片 (非 shell 冒烟)。契约 (agent-templates.ts):
 *  ① 合法 string[] 原样保留 (元素 = server 名或 'server:tool');
 *  ② 非数组 → 丢整个字段 + warn, 卡照常加载 (TPL-1 fail-open);
 *  ③ 数组内非 string / 空白元素逐个丢弃 + warn, 合法项留下 (首尾空白 trim);
 *  ④ 加载器**不校验已注册性** (纯件; 注册表在 parsePlan 调用方手里)。
 *
 * 反向证伪:
 *  - 删掉 mcp 解析块或模板对象的 mcp 条件 spread → 测试 1 红 (tpl.mcp === undefined);
 *  - 删掉元素 filter (非法元素不过滤) → 测试 2 红 (42 / '' 混入结果);
 *  - 删掉非数组分支 (或把标量当数组保留) → 测试 3 红 (mcp 不再是 undefined)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentTemplates, type AgentTemplate } from './agent-templates';

function loadCards(cards: Record<string, string>): Map<string, AgentTemplate> {
  const root = mkdtempSync(join(tmpdir(), 'omd-agtpl-'));
  mkdirSync(join(root, '.omd', 'agents'), { recursive: true });
  for (const [file, text] of Object.entries(cards)) writeFileSync(join(root, '.omd', 'agents', file), text);
  return loadAgentTemplates({ root });
}

const card = (fmLines: string[]): string => ['---', ...fmLines, '---', '正文: 方法论与检查单。', ''].join('\n');

describe('模板卡 frontmatter mcp (D-3)', () => {
  test('合法 mcp: string[] 原样保留 (server 名与 server:tool 两形)', () => {
    const templates = loadCards({
      'wirer.md': card(['name: wirer', 'description: 接线卡', 'mcp:', "  - 'filesystem'", "  - 'playwright:shot'"]),
    });
    const tpl = templates.get('wirer');
    expect(tpl).toBeDefined(); // 卡照常加载
    expect(tpl!.mcp).toEqual(['filesystem', 'playwright:shot']); // 删解析/spread → undefined → 红
  });

  test('混入非 string / 空白元素 → 逐个丢弃, 合法项留下并 trim', () => {
    const templates = loadCards({
      'mixed.md': card(['name: mixed', 'description: 坏样本卡', 'mcp:', "  - 'ok-server'", '  - 42', "  - ''", "  - '  '", "  - 'also:ok'", "  - ' padded '"]),
    });
    const tpl = templates.get('mixed');
    expect(tpl).toBeDefined(); // 坏元素不拖垮卡 (TPL-1 fail-open)
    // 42 (非 string) 与 '' / '  ' (空白) 被过滤; ' padded ' trim 后留下。
    expect(tpl!.mcp).toEqual(['ok-server', 'also:ok', 'padded']); // 删 filter → 42/'' 混入 → 红
  });

  test('mcp 非数组 (标量) → 丢整个字段, 卡照常加载', () => {
    const templates = loadCards({
      'scalar.md': card(['name: scalar', 'description: 标量卡', "mcp: 'filesystem'"]),
    });
    const tpl = templates.get('scalar');
    expect(tpl).toBeDefined();
    expect(tpl!.mcp).toBeUndefined(); // 删非数组分支 → 标量被保留/抛错 → 红
  });

  test('无 mcp 字段的卡 → 属性不存在 (条件 spread, 不是 undefined 赋值)', () => {
    const templates = loadCards({
      'plain.md': card(['name: plain', 'description: 普通卡']),
    });
    const tpl = templates.get('plain');
    expect(tpl).toBeDefined();
    expect('mcp' in tpl!).toBe(false); // 与 model/evidence 同一条件 spread 惯例
  });
});
