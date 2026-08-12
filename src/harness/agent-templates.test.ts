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
import { BUILTIN_AGENT_TEMPLATES } from './agent-templates-builtin';

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

/**
 * 模板卡 frontmatter `trigger` 解析契约 (SDD 2026-08-11 卡与profile分工 D-9/D-10)。
 * 形状 = `{ writeSetGlob: string }`; 与 mcp 同一条 fail-open 通道 (非法 → 丢字段 + warn, 卡照常加载)。
 *
 * 反向证伪: 删掉加载器的 trigger 解析块或对象的条件 spread → 测试 1 红 (tpl.trigger === undefined);
 *          删掉形状校验分支 → 测试 2/3 红 (非法值被当合法保留)。
 */
describe('模板卡 frontmatter trigger (D-9)', () => {
  test('合法 trigger: { writeSetGlob } 保留并 trim', () => {
    const templates = loadCards({
      'fe.md': card(['name: fe', 'description: 前端审核卡', 'trigger:', "  writeSetGlob: '  **/*.tsx  '"]),
    });
    const tpl = templates.get('fe');
    expect(tpl).toBeDefined();
    expect(tpl!.trigger).toEqual({ writeSetGlob: '**/*.tsx' });
  });

  test('trigger 是标量 / 缺 writeSetGlob / 空串 → 丢整个字段, 卡照常加载', () => {
    const templates = loadCards({
      'scalar.md': card(['name: scalar', 'description: 标量卡', "trigger: '**/*.tsx'"]),
      'nokey.md': card(['name: nokey', 'description: 缺键卡', 'trigger:', '  glob: 打错的键名']),
      'empty.md': card(['name: empty', 'description: 空串卡', 'trigger:', "  writeSetGlob: '   '"]),
    });
    for (const n of ['scalar', 'nokey', 'empty']) {
      expect(templates.get(n)).toBeDefined(); // TPL-1: 坏字段不拖垮卡
      expect(templates.get(n)!.trigger).toBeUndefined();
    }
  });

  test('无 trigger 字段 → 属性不存在 (条件 spread)', () => {
    const templates = loadCards({ 'plain2.md': card(['name: plain2', 'description: 无触发卡']) });
    expect('trigger' in templates.get('plain2')!).toBe(false);
  });
});

/**
 * 卡词表**格式闸** (C-2 / C-3 / C-4)。
 *
 * 判据跑在 `loadAgentTemplates()` 的**全量**返回上 (内置卡 + `.omd/agents/*.md` 项目卡, O-4 已裁「过闸」),
 * 不是只扫 BUILTIN_AGENT_TEMPLATES —— 只扫内置就是给项目卡留了个洞。
 * ⚠ 今天本仓 `.omd/agents/` 不存在, 项目卡为零 → 这三条闸此刻的样本 = 9 张内置卡。
 * 通过率 100% **不是质量证据, 是样本为空**: 第一张项目卡进来时若立刻红, 那是闸头一回真量到东西。
 *
 * 开量当场抓到的存量违规 (不是本次改动造成的): C-3 上 `frontend-impl` 122 / `ui-reviewer` 136 字符,
 * 已按 D-7 改短 —— 记在这里, 免得日后把「新增闸抓到旧债」读成「这次改坏了」。
 */
describe('卡词表格式闸 (C-2/C-3/C-4)', () => {
  const registry = [...loadAgentTemplates().values()];

  test('C-2 卡 body 禁运行期插值 (D-6: 插一个就把该卡的 cache 面碎成每节点一份)', () => {
    expect(registry.length).toBeGreaterThan(0); // 空词表会让本闸假绿
    const offenders = registry
      .filter((t) => t.body.includes('${') || t.body.includes('{{'))
      .map((t) => t.name);
    // 反向自检 (2026-08-12 实跑): 往 spec-author 的 body 塞一行 '节点 ${id}' →
    //   红,断言 diff = `- []` / `+ [ "spec-author", ]`。变异撤回后复绿 10 pass。
    expect(offenders).toEqual([]);
  });

  test('C-3 description ≤120 字 (D-7: conductor 选卡只看这一行, 注册表每卡只付一行)', () => {
    expect(registry.length).toBeGreaterThan(0);
    const tooLong = registry.filter((t) => t.description.length > 120).map((t) => `${t.name}=${t.description.length}`);
    // 反向自检 (2026-08-12 实跑): 把 researcher 的 description 接长到 121 →
    //   红,断言 diff = `- []` / `+ [ "researcher=121", ]`。
    expect(tooLong).toEqual([]);
  });

  test('C-4 内置卡不 bake model (D-8: 座位是唯一真源; 项目卡豁免 = owner 显式覆盖)', () => {
    // 口径是「**非空**」而不是「字段不存在」: `implementer` 卡写的是显式 `model: undefined`,
    // 那与不写等价 (TPL-3 取不到值就走座位链), 用 `'model' in t` 会把它误判成违规。
    // 选了这个口径而不是去删那一行 —— 删它属于本 SDD 写集外的顺手改 (Surgical Changes)。
    const baked = BUILTIN_AGENT_TEMPLATES.filter((t) => t.model !== undefined && t.model !== '').map((t) => t.name);
    // 反向自检 (2026-08-12 实跑): 给 code-reviewer 加 `model: 'deepseek:deepseek-v4-flash'` →
    //   红,断言 diff = `- []` / `+ [ "code-reviewer", ]` (agent-templates.test.ts:143)。
    expect(baked).toEqual([]);
  });
});
