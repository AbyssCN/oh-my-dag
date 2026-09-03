/**
 * src/harness/lead/readonly-shell.test —— lead 只读 bash 闸 (D-20 机械面)。反向自检写在文件头。
 */
import { describe, expect, test } from 'bun:test';
import type { AnyOmdTool } from '../agent-tools';
import { READONLY_SHELL_BLOCKED_HEAD, readOnlyShellBlockReason, wrapReadOnlyShell } from './readonly-shell';

describe('readOnlyShellBlockReason', () => {
  test('★ 写目标 / 重定向 / 改盘动词 / git 写子命令 / 包管理器 都拒', () => {
    const blocked = [
      'cat > analysis.json <<EOF\n{}\nEOF',
      'echo x >> notes.md',
      'echo x > "$OUT"',
      'python3 - <<PY\nopen("a.json","w").write("x")\nPY',
      'tee out.txt',
      'sed -i s/a/b/ src/x.py',
      'rm -rf build',
      'mkdir -p tmp',
      'touch a.txt',
      'cp a b',
      'mv a b',
      'git commit -am x',
      'git checkout -- .',
      'git stash',
      'pip install requests',
      'bun add zod',
      'FOO=1 sudo rm x',
      'ls && rm x',
    ];
    for (const c of blocked) expect(readOnlyShellBlockReason(c), c).not.toBeNull();
  });

  test('★ 只读命令与测试命令放行 (lead prompt §1 承诺的那几类)', () => {
    const allowed = [
      'ls -la',
      'grep -rn "best_match" jsonschema/',
      'find . -name "*.py" | head',
      'git log --oneline -5',
      'git status --short',
      'git diff --stat',
      'cat README.md',
      'pytest -q tests/test_x.py',
      'python3 -m pytest -q',
      'bun test src/a.test.ts',
      'python3 -c "import json; print(json.load(open(\'a.json\')))"',
      'echo hi 2>&1',
      'pytest -q > /dev/null 2>&1',
      'wc -l src/*.py',
    ];
    for (const c of allowed) expect(readOnlyShellBlockReason(c), c).toBeNull();
  });
});

describe('wrapReadOnlyShell', () => {
  const inner: AnyOmdTool = {
    name: 'bash',
    label: 'bash',
    description: 'run',
    parameters: {} as never,
    executionMode: 'sequential',
    async execute(_id: string, params: unknown) {
      return { content: [{ type: 'text', text: `ran: ${(params as { command: string }).command}` }], details: undefined };
    },
  } as AnyOmdTool;

  test('拒的走 tool result 带原因首行, 内层不被调; 放行的原样透传', async () => {
    const w = wrapReadOnlyShell(inner);
    const b = (await w.execute('t', { command: 'echo x > a.txt' })) as { content: { text: string }[] };
    expect(b.content[0]!.text.startsWith(READONLY_SHELL_BLOCKED_HEAD)).toBe(true);
    expect(b.content[0]!.text).toContain('work()');
    const a = (await w.execute('t', { command: 'ls' })) as { content: { text: string }[] };
    expect(a.content[0]!.text).toBe('ran: ls');
    expect(w.name).toBe('bash');
  });
});
