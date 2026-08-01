/**
 * agent leaf 自有工具集的**闸与语义**回归 (2026-08-01, 搬到 pi-agent-core 那一轮)。
 *
 * 这份网真正钉的是**闸的位置**: 此前危险命令拒 / 凭证 basename 拒是靠 `tool-gate` extension
 * 从外面贴在通用工具上的, 于是"忘了贴"是一个可达状态 —— `cat .env` 那个洞正是这么漏的
 * (闸落在 command-leaf 的白名单上, agent leaf 的 bash 从来不经过它)。
 * 现在闸长在工具里, 所以这里的断言是「**拿到工具就拿到闸**」, 不是「某个装配步骤记得挂闸」。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmdAgentTools, type AnyOmdTool } from './agent-tools';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-agent-tools-'));
  writeFileSync(join(root, 'hello.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=sk-real-secret\n');
  writeFileSync(join(root, '.env.example'), 'DEEPSEEK_API_KEY=\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'deep.ts'), 'const needle = 42;\n');
  return root;
}

function toolset(root: string): Record<string, AnyOmdTool> {
  return Object.fromEntries(createOmdAgentTools({ cwd: root }).map((t) => [t.name, t]));
}

const run = (t: AnyOmdTool, args: unknown): Promise<{ content: { type: string; text?: string }[] }> =>
  t.execute('call-1', args as never, undefined, undefined) as Promise<{ content: { type: string; text?: string }[] }>;
const text = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');

describe('工具集就是闸 —— 凭证文件', () => {
  it('★ read 拒 .env (拿到工具就拿到闸, 不靠外面挂 hook)', async () => {
    const root = fixture();
    const { read } = toolset(root);
    expect(run(read!, { path: '.env' })).rejects.toThrow(/BLOCKED.*凭证文件/);
  });

  it('★ bash 拒 `cat .env` —— 换个 bin 从同一个洞喂出去的那条路', async () => {
    const root = fixture();
    const { bash } = toolset(root);
    expect(run(bash!, { command: 'cat .env' })).rejects.toThrow(/BLOCKED.*凭证文件/);
  });

  it('拒因落在 basename 上, 所以绕路写法一样被拒', async () => {
    const root = fixture();
    const { read, bash } = toolset(root);
    expect(run(read!, { path: './.env' })).rejects.toThrow(/BLOCKED/);
    expect(run(bash!, { command: 'cat ../../.env' })).rejects.toThrow(/BLOCKED/);
  });

  it('★ `&&` 链的**尾环**也要被看见 (只看首环 = 合法头环放行整条链)', async () => {
    const root = fixture();
    const { bash } = toolset(root);
    expect(run(bash!, { command: 'ls && cat .env' })).rejects.toThrow(/BLOCKED.*凭证文件/);
  });

  it('.env.example 放行 —— 样例文件生来就是给人读的, 拒了只会让验证叶白挂', async () => {
    const root = fixture();
    const { read } = toolset(root);
    expect(text(await run(read!, { path: '.env.example' }))).toContain('DEEPSEEK_API_KEY');
  });
});

describe('工具集就是闸 —— 不可逆命令', () => {
  it('★ bash 拒 rm -rf /', async () => {
    const { bash } = toolset(fixture());
    expect(run(bash!, { command: 'rm -rf / --no-preserve-root' })).rejects.toThrow(/BLOCKED 不可逆命令/);
  });

  it('★ bash 拒 git push --force / git reset --hard', async () => {
    const { bash } = toolset(fixture());
    expect(run(bash!, { command: 'git push --force origin main' })).rejects.toThrow(/BLOCKED 不可逆命令/);
    expect(run(bash!, { command: 'git reset --hard HEAD~3' })).rejects.toThrow(/BLOCKED 不可逆命令/);
  });

  it('dangerousCommandGuard:false = null 逃生 (闸可关, 但默认是关着的反面)', async () => {
    const root = fixture();
    const loose = Object.fromEntries(
      createOmdAgentTools({ cwd: root, dangerousCommandGuard: false }).map((t) => [t.name, t]),
    );
    // 不真跑破坏命令: 只验它不再在**闸**这一步被拒 (echo 出来即证明过了闸)。
    expect(text(await run(loose.bash!, { command: 'echo "git reset --hard"' }))).toContain('git reset --hard');
  });

  it('普通命令照常跑, 且带回 exit code', async () => {
    const { bash } = toolset(fixture());
    expect(text(await run(bash!, { command: 'echo ok' }))).toContain('ok');
    expect(text(await run(bash!, { command: 'exit 3' }))).toContain('[exit 3]');
  });
});

describe('读写改的基本语义', () => {
  it('read 带 1-indexed 行号, offset/limit 切片后行号仍是真实行号', async () => {
    const root = fixture();
    const { read } = toolset(root);
    expect(text(await run(read!, { path: 'hello.ts' }))).toContain('1\texport const a = 1;');
    const sliced = text(await run(read!, { path: 'hello.ts', offset: 2, limit: 1 }));
    expect(sliced).toContain('2\texport const b = 2;');
    expect(sliced).not.toContain('const a');
  });

  it('write 建父目录, 内容逐字落盘', async () => {
    const root = fixture();
    const { write } = toolset(root);
    await run(write!, { path: 'a/b/c.txt', content: 'hi\n' });
    expect(readFileSync(join(root, 'a/b/c.txt'), 'utf-8')).toBe('hi\n');
  });

  it('★ edit 要求 oldText **唯一** —— 多处命中宁可拒, 不赌改的是哪一处', async () => {
    const root = fixture();
    const { edit } = toolset(root);
    writeFileSync(join(root, 'dup.ts'), 'x\nx\n');
    expect(run(edit!, { path: 'dup.ts', oldText: 'x', newText: 'y' })).rejects.toThrow(/出现多次/);
    expect(run(edit!, { path: 'dup.ts', oldText: 'zzz', newText: 'y' })).rejects.toThrow(/找不到/);
    await run(edit!, { path: 'hello.ts', oldText: 'const b = 2', newText: 'const b = 3' });
    expect(readFileSync(join(root, 'hello.ts'), 'utf-8')).toContain('const b = 3');
  });

  it('grep 返 `路径:行号: 内容`, 支持 glob 与 literal', async () => {
    const root = fixture();
    const { grep } = toolset(root);
    expect(text(await run(grep!, { pattern: 'needle' }))).toMatch(/sub\/deep\.ts:1: .*needle/);
    expect(text(await run(grep!, { pattern: 'needle', glob: '*.md' }))).toContain('(无命中)');
    // literal: 正则元字符按字面看待 (否则 `a = 1;` 里的 `.` 会乱命中)。
    expect(text(await run(grep!, { pattern: 'const a = 1;', literal: true }))).toContain('hello.ts:1:');
  });

  it('ls 目录带 `/` 后缀', async () => {
    const root = fixture();
    const { ls } = toolset(root);
    const out = text(await run(ls!, {}));
    expect(out).toContain('sub/');
    expect(out).toContain('hello.ts');
  });
});
