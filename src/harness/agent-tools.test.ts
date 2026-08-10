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
import { createOmdAgentTools, shouldSkipDir, type AnyOmdTool } from './agent-tools';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner, buildLeafSystemPrompt, loadProjectContext } from './agent-leaf';

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

describe('凭证文件:只告警不拦 (owner 2026-08-07 裁决「去掉这个」)', () => {
  /**
   * 这一段**原来断言的是硬拒**(read/bash 见 .env 即抛 BLOCKED)。改掉的理由不是"闸不重要",
   * 是**它挡的和它拦的不成比例**:按 basename 判、不按内容判 ——
   * `grep -r SECRET .` 照样打印命中行、`node -e` 一旦成立读什么都不过这张表,
   * 所以它挡的从来只是"顺手 cat 一下配置"这类手滑;代价却是"看一眼 .env 里那一项配错没"
   * 这种正当排查也做不了。
   *
   * ⚠ 正确形态是审批层的 `read_sensitive`(先预览、要继续才审批), 见设计稿第八节。
   *   那一档做出来之后, 这几条要再改一次 —— 改成"触发审批", 不是"直接放行"。
   * ⚠ **command-leaf 那一层的同名闸没有动**(见 test/core/blast-radius.test.ts):
   *   它管 DAG 验收命令, 与对话位的手是两回事。
   */
  it('★ read 能读 .env 了 —— 不再抛 BLOCKED', async () => {
    const root = fixture();
    const { read } = toolset(root);
    expect(text(await run(read!, { path: '.env' }))).toContain('DEEPSEEK_API_KEY');
  });

  it('★ bash 能 `cat .env` 了 —— 换 bin 那条路同样放行', async () => {
    const root = fixture();
    const { bash } = toolset(root);
    expect(text(await run(bash!, { command: 'cat .env' }))).toContain('DEEPSEEK_API_KEY');
  });

  it('★ `&&` 链的尾环也不再被拦', async () => {
    const root = fixture();
    const { bash } = toolset(root);
    expect(text(await run(bash!, { command: 'ls && cat .env' }))).toContain('DEEPSEEK_API_KEY');
  });

  it('.env.example 照旧放行 —— 样例文件生来就是给人读的', async () => {
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

  /**
   * ★★ **走到遍历上限必须说出来**(2026-08-08 实测发现的静默失效)。
   *
   * 老版 `walkFiles` 走到 20_000 就 `return out`,**一个字都不报**。单一变量实测
   * (只改文件数):5,000 个文件 → 命中 5,000 / 漏 0;25,000 个 → 命中 **20,000** / 漏 **5,000**,
   * 而输出里没有任何提示。于是大仓里 agent 收到的是 `(无命中)`,
   * 它的合理反应就是**认定这个符号不存在** —— 本仓 §3.2「fail-open 可以吞异常,不许吞证据」。
   *
   * 这里把上限注进来(`grepWalkLimit`)以便用 4 个文件量,不用真造 20_000 个。
   * **证伪方式**:把 `walkFiles` 的 `capped` 恒设成 `false`(等于回到老版)→ 三条全红。
   */
  /**
   * ★ **venv 变体要跳掉**(2026-08-08 实测:精确匹配一个都没拦住)。
   *
   * `SKIP_DIRS` 只有 `.venv`, 而真实的名字是 `.venv-crawl4ai` / `.venv-seuranta` / `.venv-pg`。
   * 代价:talous-v2 那个 `.venv-crawl4ai` 一个目录占全仓 SKIP_DIRS 口径文件数的 **58%**
   * (11,150 / 19,177), 遍历预算全烧在 site-packages 上, 而那里没有一行是这个仓的代码。
   *
   * **证伪方式**:把 `shouldSkipDir` 改回 `SKIP_DIRS.has(name)` → 前两条红。
   */
  it('★ .venv 的各种变体都跳掉(精确匹配漏光了)', () => {
    for (const n of ['.venv', '.venv-crawl4ai', '.venv-seuranta', '.venv-pg', 'venv', '.venv.bak', 'venv_old']) {
      expect(shouldSkipDir(n)).toBe(true);
    }
  });

  it('★ 反测:名字里带 venv 的**正常源码目录**不许被误跳', () => {
    // 收敛处要求分隔符 —— 否则 `venvironment/` 这种目录会被静默跳过, 而那是真代码。
    for (const n of ['venvironment', 'venvs-docs', 'myvenv', 'convention', 'src', 'lib']) {
      expect(shouldSkipDir(n)).toBe(false);
    }
  });

  /**
   * ★ mypy / pytest 缓存目录也跳掉。
   *
   * ⚠ **出处**:这一条与它对应的实装改动是 2026-08-08 那次「写任务」端到端实验里
   * **omd 自己的对话位写出来的**(`scripts/probes/write-task-e2e-probe.ts`),
   * 我独立复核过行为与 diff 之后照搬进主仓。留这行是为了让来源可追,不是为了好看。
   *
   * 它当时的判断也对:这两个名字**留在精确匹配里**而不是塞进 `shouldSkipDir` 的正则 ——
   * 真实世界里就叫这两个名字,没有 `.venv-xxx` 那样的变体。
   * **证伪方式**:把两个名字从 `SKIP_DIRS` 删回 → 第一条红。
   */
  it('★ .mypy_cache / .pytest_cache 跳掉', () => {
    for (const n of ['.mypy_cache', '.pytest_cache']) expect(shouldSkipDir(n)).toBe(true);
  });

  it('★ 反测:名字里带 mypy_cache 的**正常源码目录**不许被误跳', () => {
    for (const n of ['mypy_cache_utils', 'pytest_cache_helpers']) expect(shouldSkipDir(n)).toBe(false);
  });

  it('grep 真的不进 venv 变体目录 —— 判定接上了遍历, 不只是个没人调的函数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-venv-'));
    mkdirSync(join(root, '.venv-crawl4ai'));
    writeFileSync(join(root, '.venv-crawl4ai', 'site.ts'), `const q = 'venvskip_needle';\n`);
    writeFileSync(join(root, 'real.ts'), `const q = 'venvskip_needle';\n`);
    const { grep } = toolset(root);
    const out = text(await run(grep!, { pattern: 'venvskip_needle' }));
    expect(out).toContain('real.ts:1:');
    expect(out).not.toContain('.venv-crawl4ai');
  });

  it('★ grep 走到遍历上限时说出来 —— 「没走到那儿」不许抹成「那儿没有」', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-walkcap-'));
    // 4 个文件, 上限设 2 → 必然被截。needle 只在其中一个里, 命中与否取决于遍历序,
    // 所以判据锚的**不是**有没有命中, 是"有没有承认被截" —— 那才是这条要治的东西。
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `${n}.ts`), `const x = 'walkcap_needle';\n`);
    const capped = createOmdAgentTools({ cwd: root, grepWalkLimit: 2 }).find((t) => t.name === 'grep');
    const out = await run(capped!, { pattern: 'walkcap_needle' });
    expect(text(out)).toContain('遍历上限');
    expect(text(out)).toContain('命中很可能不全');
    // `details` 也要看得见 —— 不能只靠人去读那句话。
    expect((out as unknown as { details: { walkCapped: boolean; walked: number } }).details).toMatchObject({
      walkCapped: true,
      walked: 2,
    });
  });

  it('★ 没被截的时候**不许**画那句警告 —— 一条永远在的警告等于没有警告', async () => {
    const root = fixture();
    const { grep } = toolset(root);
    const out = await run(grep!, { pattern: 'needle' });
    expect(text(out)).not.toContain('遍历上限');
    expect((out as unknown as { details: { walkCapped: boolean } }).details.walkCapped).toBe(false);
  });

  it('★ glob 在**遍历时**就生效 —— 否则上限数的是任意文件, glob 逃不出上限', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-globwalk-'));
    // 3 个 .md 干扰 + 1 个 .ts 真目标。上限设 2:
    //   走完再筛 → 先收 2 个任意文件(很可能全是 .md), 筛完剩 0 → 报"无命中"
    //   走时就筛 → 只有 .ts 进得来, 1 个候选, 没到上限 ⇒ 找得到且**不报被截**
    for (const n of ['x', 'y', 'z']) writeFileSync(join(root, `${n}.md`), 'const q = 1;\n');
    writeFileSync(join(root, 'target.ts'), `const q = 'globwalk_needle';\n`);
    const g = createOmdAgentTools({ cwd: root, grepWalkLimit: 2 }).find((t) => t.name === 'grep');
    const out = await run(g!, { pattern: 'globwalk_needle', glob: '*.ts' });
    expect(text(out)).toContain('target.ts:1:');
    expect(text(out)).not.toContain('遍历上限');
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
// ── I-1 零配置叶子 (SDD D-8): 无 .omd/mcp.json → 工具面与 prompt 与接线前字节零变化 ──
const MODEL = 'claude-code:claude-sonnet-5';
const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 4 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;
const success = (): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} }) as unknown as SDKMessage;
const fakeQuery = (script: SDKMessage[], seen: { options?: Options } = {}) => {
  return (props: { prompt: string; options: Options }) => {
    seen.options = props.options;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
};

describe('I-1 零配置叶子: tools 数组与 system prompt 与接线前字节零变化', () => {
  // ★ 反向自检: 把 agent-leaf.ts 装配处的 createMcpClientTools 改成无条件挂载
  // (或删掉 meta-tools.ts:76 的零注册短路) → 本条当场红。
  it('tmp cwd 零配置 → 无 mcp_find/mcp_call, 工具名单恰为接线前六件, prompt 无 mcp 痕迹', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-leaf-i1-'));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('改完了'), success()], seen) });
    await run({ prompt: 'x', model: MODEL });
    // 桥的 allowedTools = runner tools 数组逐件映射 (buildOmdSdkMcpBridge) —— 断言**恰好**
    // 六件自有工具 (接线前集合): 多挂任何 mcp_* 件即红。
    expect(seen.options?.allowedTools).toEqual([
      'mcp__omd__read', 'mcp__omd__write', 'mcp__omd__edit', 'mcp__omd__ls', 'mcp__omd__grep', 'mcp__omd__bash',
    ]);
    // 完整 system prompt 逐字节相等 (I-1 加强): 零注册下接线后的 prompt ≡ 只用接线前六件工具
    // 拼出的 prompt —— 不许停在「不含 mcp_find」弱化版 (那会放过前缀/工具守则段的静默变化)。
    // 证伪: ①删 meta-tools.ts 零注册短路 → tools 多两件 → prompt 含 mcp snippet → toBe 红;
    // ②把 mcp promptSnippet 改无条件注入 → 同样 toBe 红。
    const baseline = buildLeafSystemPrompt({ cwd: root, tools: createOmdAgentTools({ cwd: root }), contextFiles: loadProjectContext(root) });
    expect(seen.options?.systemPrompt).toBe(baseline);
    // 显式 mcpAllow 也不能在零注册下凭空造出工具 (零注册短路优先于授权清单)。
    const seen2: { options?: Options } = {};
    const run2 = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('好'), success()], seen2) });
    await run2({ prompt: 'x', model: MODEL, mcpAllow: ['some:tool'] });
    expect(seen2.options?.allowedTools).not.toContain('mcp__omd__mcp_find');
    expect(seen2.options?.systemPrompt).not.toContain('mcp_find');
  });
});
