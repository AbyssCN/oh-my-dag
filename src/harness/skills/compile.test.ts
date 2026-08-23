/**
 * compile.ts D-6 判据改写 (开放生态 S3) —— `mcp__<server>` 宿主判据改查 `knownMcpServerNames(cwd)`。
 *
 * 覆盖 (契约 §四条独立闸之二 + C-S3-5):
 *  S3-D6-REGISTERED    已注册的 mcp__ 引用不算宿主标记 → 不 skip;
 *  S3-D6-UNREGISTERED  未注册的 mcp__ 引用照旧 skip 且 reason 列明该标记;
 *  C-S3-5              browser-harness 等非 MCP 宿主标记判据不动, 无论注册表内容如何均 skip。
 *
 * 环境隔离 (D-S3-9): 注册表全落 mkdtempSync 的 tmp cwd, 不碰真仓 `.omd/mcp.json`。
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySkill, type SkillSource } from './compile';

/** 空 files → 不走 capability 分支, 纯判 skip/craft 分类。 */
const srcWithBody = (body: string): SkillSource => ({
  name: 'probe',
  dir: '/nonexistent',
  raw: body,
  fm: {},
  body,
  files: [],
});

function tmpCwd(withMcpJson?: object): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-s3-d6-'));
  if (withMcpJson) {
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify(withMcpJson));
  }
  return cwd;
}

/** 形态实测自 config.ts 与本仓 .omd/mcp.json: {"mcpServers":{"<name>":{"command":...}}}。 */
const REGISTER_FOO = { mcpServers: { foo: { command: 'true' } } };

describe('D-6: mcp__<server> 宿主判据查注册表 (compile.ts)', () => {
  // 证伪 (C-S3-6): REGISTERED 条 —— 把 D-6 改写退回旧判据 (mcp__ 命中即 skip, 不查注册表,
  // compile.ts 原 :97-99 形态) → 必红; 此即"前提已消失但判据没改"的回归样本。
  // UNREGISTERED 条 —— ①把 mcp__ 整个从 HOST_MARKER_RE 删掉 (任何 mcp__ 都不 skip) → 必红;
  // ②保留 skip 但 reason 不再含标记原文 → "reason 含 mcp__foo" 断言必红。
  it('S3-D6-REGISTERED: SKILL.md 引用 mcp__foo 且注册表含 foo 时不跳过', () => {
    const cwd = tmpCwd(REGISTER_FOO);
    const cls = classifySkill(srcWithBody('调用 mcp__foo__search 拿数据'), cwd);
    expect(cls.kind).not.toBe('skip'); // 已注册 → 不算宿主工具标记 (D-S3-7)
    expect(cls.kind).toBe('craft'); // 无其他宿主标记时的落点
  });

  it('S3-D6-UNREGISTERED: 注册表为空时 mcp__foo 照旧 skip 且 reason 列明该标记', () => {
    const cwd = tmpCwd(); // 不写盘 .omd/mcp.json → knownMcpServerNames 返空 Set
    const cls = classifySkill(srcWithBody('调用 mcp__foo__search 拿数据'), cwd);
    expect(cls.kind).toBe('skip');
    if (cls.kind === 'skip') expect(cls.reason).toContain('mcp__foo'); // 列明原因, 含标记原文
  });
});

describe('C-S3-5: 非 MCP 宿主标记不动 —— 无论注册表内容如何均 skip', () => {
  // 证伪 (C-S3-6): 注册表豁免若写成"任一宿主标记都可被注册掉"(而非仅 mcp__<server> 一查) →
  // 本 describe 全红; 词表被改宽/改窄 (compile.ts :79-82 窄而具体的纪律) → 对应标记行红。
  it.each(['browser-harness', 'browser-act', 'scrapling', 'lark-cli', '登录态', '接管浏览器'])(
    '标记 %s 在注册表含 foo 时仍 skip 且 reason 列明标记',
    (marker) => {
      const cwd = tmpCwd(REGISTER_FOO);
      const cls = classifySkill(srcWithBody(`正文引用 ${marker} 干宿主活`), cwd);
      expect(cls.kind).toBe('skip');
      if (cls.kind === 'skip') expect(cls.reason).toContain(marker);
    },
  );

  it('mcp__foo 已注册但同文含 browser-harness → 仍 skip (注册只豁免 mcp__ 那一类)', () => {
    const cwd = tmpCwd(REGISTER_FOO);
    const cls = classifySkill(srcWithBody('先 mcp__foo__search 再 browser-harness 截图'), cwd);
    expect(cls.kind).toBe('skip');
    if (cls.kind === 'skip') expect(cls.reason).toContain('browser-harness');
  });
});
