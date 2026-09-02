/**
 * P3 S4 —— leaf prompt v2: 冻结前缀 + RUN FACTS 后缀 (D-7 / D-8 / D-9 / INV-9)。
 * 证伪: 把任一 `{{…}}` 语义 (写集 / 分钟 / 命令原文) 挪进前缀 → ①红;加回 TURNS_LEFT → ②红;
 * 在 bash 那几行写 allowlist → ③红;白名单行不用 allowlistForRoot 的表 → ④红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLeafSystemPromptV2, LEAF_FACTS_BOUNDARY, LEAF_PROMPT_V2_PREFIX, LEAN_LEAF_TOOLS, renderLeafFacts } from './leaf-prompt-v2';
import { allowlistForRoot } from './command-leaf';

const cwd = mkdtempSync(join(tmpdir(), 'omd-lpv2-'));
const prefixOf = (p: string) => p.slice(0, p.indexOf(LEAF_FACTS_BOUNDARY));

describe('leaf prompt v2', () => {
  test('★ ① 冻结前缀字节稳定: 两份完全不同的 facts, 边界前切片相等; 边界前不含任何注入事实', () => {
    const a = buildLeafSystemPromptV2({ writeRoot: '/w/one', writeSet: ['src/a.ts'], acceptance: { command: 'pytest -q tests/x.py', expect_exit: 0 }, allowlist: ['bun', 'pytest'], minutesLeft: 7 });
    const b = buildLeafSystemPromptV2({ writeRoot: '/w/two', allowlist: ['bun'], minutesLeft: null, contextFiles: [{ path: 'CLAUDE.md', content: '仓规' }] });
    expect(prefixOf(a)).toBe(prefixOf(b));
    expect(prefixOf(a)).toBe(`${LEAF_PROMPT_V2_PREFIX}\n`);
    for (const leaked of ['/w/one', 'src/a.ts', 'pytest -q tests/x.py', '7 minutes', '仓规']) expect(prefixOf(a)).not.toContain(leaked);
    expect(a).toContain('/w/one');
    expect(a).toContain('pytest -q tests/x.py');
    expect(a).toContain('7 minutes left');
  });

  test('★ ② 模板不含 {{TURNS_LEFT}}; 渲染后无残留 {{; 预算只出分钟', () => {
    const p = buildLeafSystemPromptV2({ writeRoot: cwd, allowlist: ['bun'], minutesLeft: 3 });
    expect(p).not.toContain('TURNS_LEFT');
    expect(p).not.toContain('{{');
    expect(p).toContain('3 minutes left');
    expect(buildLeafSystemPromptV2({ writeRoot: cwd, allowlist: ['bun'], minutesLeft: null })).toContain('no per-run minute budget');
  });

  test('★ ③ D-7: allowlist 字样只在 run_acceptance/command 那一行与事实后缀; 交互 bash 的闸行是黑名单三族', () => {
    const prefixLines = LEAF_PROMPT_V2_PREFIX.split('\n').filter((l) => /allowlist/i.test(l));
    expect(prefixLines).toHaveLength(1);
    expect(prefixLines[0]!.startsWith('| Command allowlist')).toBe(true);
    for (const bashRow of ['| Irreversible commands', '| Git writes', '| Credential paths']) {
      const row = LEAF_PROMPT_V2_PREFIX.split('\n').find((l) => l.startsWith(bashRow));
      expect(row).toBeDefined();
      expect(row!).not.toMatch(/allowlist/i);
    }
  });

  test('★ ④ 白名单文本逐字等于 allowlistForRoot(cwd); 读域行等于工作根', () => {
    const allow = allowlistForRoot(cwd);
    const facts = renderLeafFacts({ writeRoot: cwd, allowlist: allow, minutesLeft: null });
    expect(facts).toContain(`Command allowlist (first words, for the frozen command and command nodes): ${allow.join(' ')}`);
    expect(facts).toContain(`- Work root: ${cwd}. Relative paths resolve against it. Reads are confined to it.`);
  });

  test('⑤ 闸表每一行三列齐且 what-you-do 非空', () => {
    const rows = LEAF_PROMPT_V2_PREFIX.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Gate') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      const cells = r.split('|').map((c) => c.trim()).filter(Boolean);
      expect(cells).toHaveLength(3);
      expect(cells[2]!.length).toBeGreaterThan(10);
    }
  });

  test('⑥ 写集三态: 未声明 / 空 / 列表 各一句, 路径按工作根相对化', () => {
    expect(renderLeafFacts({ writeRoot: '/w', allowlist: [], minutesLeft: null })).toContain('any path under the work root');
    expect(renderLeafFacts({ writeRoot: '/w', writeSet: [], allowlist: [], minutesLeft: null })).toContain('must not write');
    expect(renderLeafFacts({ writeRoot: '/w', writeSet: ['/w/src/a.ts'], allowlist: [], minutesLeft: null })).toContain('Files you may write: src/a.ts.');
  });

  test('LEAN_LEAF_TOOLS 恰四件 (owner 裁)', () => {
    expect([...LEAN_LEAF_TOOLS]).toEqual(['read', 'write', 'edit', 'bash']);
  });
});
