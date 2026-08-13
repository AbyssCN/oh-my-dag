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
import { createOmdAgentTools, shouldSkipDir, walkFiles, type AnyOmdTool } from './agent-tools';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentLeafRunner, buildLeafSystemPrompt, loadProjectContext } from './agent-leaf';
import { createSkillTools } from './skills/skill-tool';

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

  /**
   * ★★ **bash 输出流式往上报**(2026-08-14)。
   *
   * 此前 omd 六个工具**没有一个**接 `onUpdate`(全仓 0 命中),`executeShellWithCapture`
   * 的 `onChunk` 也一次都没传 ⇒ pi 的 `tool_execution_update` **结构上永远不会触发**。
   * 代价:一条跑 120 秒的命令,屏上 120 秒里一个字都没有 ——「在跑」与「卡死」长得一样。
   *
   * **证伪方式**(实跑):把 `bash.execute` 的第四个参数 `onUpdate` 删掉,或把
   * `onChunk` 那一段去掉 → 第一条当场红(`updates` 恒为 0)。
   */
  it('★ bash 跑着就往上报进度(不接 onUpdate 的话「在跑」与「卡死」在屏上一样)', async () => {
    const { bash } = toolset(fixture());
    const seen: string[] = [];
    // 每片之间 150ms > 节流 120ms ⇒ 至少报得出一次。
    await bash!.execute(
      'c1',
      { command: 'for i in 1 2 3; do echo line-$i; sleep 0.15; done' } as never,
      undefined,
      ((partial: { content: { text?: string }[] }) => {
        seen.push(partial.content.map((c) => c.text ?? '').join(''));
      }) as never,
    );
    expect(seen.length).toBeGreaterThan(0);
    // 报的是**到目前为止的整段输出**(累积), 所以最后一次里该有前面的行。
    expect(seen.at(-1)).toContain('line-1');
  });

  it('★ 中途读数的 exitCode 是 undefined —— 编一个 0 就是把「在跑」画成「跑成功了」', async () => {
    const { bash } = toolset(fixture());
    const details: unknown[] = [];
    await bash!.execute(
      'c2',
      { command: 'echo a; sleep 0.2; echo b' } as never,
      undefined,
      ((partial: { details: unknown }) => details.push(partial.details)) as never,
    );
    for (const d of details) expect((d as { exitCode: unknown }).exitCode).toBeUndefined();
  });

  it('不给 onUpdate 就一次都不报(省略 = 零行为变化, leaf 那条路不受影响)', async () => {
    const { bash } = toolset(fixture());
    // 不传第四参 —— 走的是与本条改动之前逐字相同的路径。
    expect(text(await run(bash!, { command: 'echo ok' }))).toContain('ok');
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

  /**
   * ★ glob 在**遍历时**就生效(结果面),但**不再帮你逃出上限**(代价面)。
   *
   * ## 这条 2026-08-13 翻过一次,理由记在这里
   *
   * 上一版的判据是「带 glob 时不报被截」—— 因为那时上限只数**候选**文件,
   * 不匹配的一个都不计数。那一步当时读起来很合理(「glob 收窄了,当然该走得更远」),
   * 而它的代价是**遍历实际无界**:`grep(x, path:'/mnt/d', glob:'*.ts')` 在一整块
   * 网络盘上走穿都到不了 20,000,上限形同虚设。2026-08-13 的 WSL 整机卡死就是这么来的
   * (`omd tui` 主进程占满一核 3h48m,而 `walkFiles` 是进程内 JS —— 不进 bwrap、
   * `bashTimeoutSec` 管不着、Esc 也打断不了)。
   *
   * 所以现在两件事分开:**glob 决定你要什么,上限决定允许花多少**。
   * 上限数的是 readdir 返回的条目总数。
   *
   * **证伪方式**:把 `walkFiles` 的 `visited += 1` 挪回只在 `out.push` 时加
   * (= 回到旧口径)→ 第二条当场红(4 个条目、上限 2,却报不被截)。
   */
  it('★ glob 决定要什么, 上限决定花多少 —— glob 不再帮你逃出上限', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-globwalk-'));
    // 3 个 .md 干扰 + 1 个 .ts 真目标, 共 4 个条目;上限设 2 ⇒ 必然被截。
    for (const n of ['x', 'y', 'z']) writeFileSync(join(root, `${n}.md`), 'const q = 1;\n');
    writeFileSync(join(root, 'target.ts'), `const q = 'globwalk_needle';\n`);
    const g = createOmdAgentTools({ cwd: root, grepWalkLimit: 2 }).find((t) => t.name === 'grep');
    const out = await run(g!, { pattern: 'globwalk_needle', glob: '*.ts' });
    // ① 结果面:glob 仍在遍历时生效 —— 收进来的只有 .ts, 没有走完再筛那一趟。
    expect((out as unknown as { details: { walked: number } }).details.walked).toBeLessThanOrEqual(1);
    // ② 代价面:4 个条目 > 上限 2 ⇒ **必须承认被截**(旧口径在这里会说没被截)。
    expect(text(out)).toContain('遍历上限');
  });

  /**
   * ★★ **远端挂载整棵剪掉,并且说出来**(2026-08-13,WSL 整机卡死的修法)。
   *
   * 判据是 **fstype 不是路径**:写死 `/mnt` 只挡得住 WSL 一种形态,而 NAS / sshfs
   * 挂在哪儿是用户定的。这里把挂载表**注进去**,不去读真机的 `/proc/mounts` ——
   * 否则这条闸在没有网络盘的机器上恒绿,量的是那台机器不是这段代码。
   *
   * **证伪方式**:把 `walkFiles` 里 `isRemote(full)` 那个分支删掉 → 两条全红
   * (needle 会从"远端"目录里被搜出来,且没有那句跳过说明)。
   */
  it('★ 远端挂载不进去, 且**说出来** —— 静默剪掉 = 用 (无命中) 骗人', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-mount-'));
    const remote = join(root, 'mnt-d');
    mkdirSync(remote);
    writeFileSync(join(remote, 'far.ts'), `const q = 'mountgate_needle';\n`);
    writeFileSync(join(root, 'near.ts'), `const q = 'mountgate_needle';\n`);
    const walked = await walkFiles(root, 1000, { remoteMounts: [remote] });
    expect(walked.files.map((f) => f.replace(`${root}/`, ''))).toEqual(['near.ts']);
    expect(walked.skippedMounts).toEqual([remote]);
  });

  /**
   * ★ **root 自己就在远端挂载上时不剪** —— 那是「明说要去那儿」,不是误入。
   * 剪掉的话这个工具在那条路径上永远返回 `(无命中)`,而那是本仓最怕的那种谎。
   * 那一支的护栏是另外两条:条目上限 + 墙钟预算。
   */
  it('★ 明确 path= 指到远端里面时照走 —— 护栏换成上限+预算, 不是装作那儿没有', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-mount-root-'));
    writeFileSync(join(root, 'inside.ts'), `const q = 'x';\n`);
    const walked = await walkFiles(root, 1000, { remoteMounts: [root] });
    expect(walked.files.map((f) => f.replace(`${root}/`, ''))).toEqual(['inside.ts']);
    expect(walked.skippedMounts).toEqual([]);
  });

  /**
   * ★ **墙钟预算**:条目数远没到上限、时间已经过去很久 —— 9P 上一个 readdir 就可能
   * 几百毫秒,2026-08-13 那次正是这一种(3h48m 而条目数根本到不了 20,000)。
   * 时钟注入,不靠 sleep 出一个不确定的读数。
   */
  it('★ 走超墙钟预算就停, 并承认被截(条目数没到上限也要停)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-agent-budget-'));
    for (const n of ['a', 'b', 'c']) writeFileSync(join(root, `${n}.ts`), 'x\n');
    let t = 0;
    const walked = await walkFiles(root, 1000, { budgetMs: 5, now: () => (t += 10) });
    expect(walked.capped).toBe(true);
    expect(walked.files).toEqual([]); // 第一次判预算就在 readdir 之前 —— 一个条目都没走
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
  // ★ 反向自检 (C-S3-6): ①删掉 skill-tool 的零 skill 短路 (零 skill 也挂 read_skill) →
  //   allowedTools 多一件 → toEqual 必红; ②把 skill 名或扫描数字拼进 promptSnippet →
  //   systemPrompt toBe 必红 (冻结前缀纪律 I-3); ③把 agent-leaf.ts 装配处的
  //   createMcpClientTools 改成无条件挂载 → mcp 两件多出来 → 同样红。
  it('S3-C8-B: 零 skill tmp cwd 的 leaf tools 数组与 system prompt 与 S2 基线逐字节相同', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-leaf-i1-'));
    const seen: { options?: Options } = {};
    // D-S3-8 特批改造: I-1 夹具改为零 skill 注入形态 (skillDeps.roots = []), 逐字节比较强度不变。
    // 注入空 roots 同时是 D-S3-9 隔离: 缺省 roots 会扫到包内与 ~/.claude/skills, 测试不许读它们。
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('改完了'), success()], seen), skillDeps: { roots: [] } });
    await run({ prompt: 'x', model: MODEL });
    // 桥的 allowedTools = runner tools 数组逐件映射 (buildOmdSdkMcpBridge) —— 断言**恰好**
    // 六件自有工具 (S2 收官基线): 多挂 read_skill 或任何 mcp_* 件即红。
    expect(seen.options?.allowedTools).toEqual([
      'mcp__omd__read', 'mcp__omd__write', 'mcp__omd__edit', 'mcp__omd__ls', 'mcp__omd__grep', 'mcp__omd__bash',
    ]);
    // 完整 system prompt 逐字节相等 (= S2 基线, 与原 I-1 同口径): 零 skill 注入下 S3 接线后的
    // prompt ≡ 只用六件基线工具拼出的 prompt —— 不许停在「不含 mcp_find」弱化版
    // (那会放过前缀/工具守则段的静默变化)。
    const baseline = buildLeafSystemPrompt({ cwd: root, tools: createOmdAgentTools({ cwd: root }), contextFiles: loadProjectContext(root) });
    expect(seen.options?.systemPrompt).toBe(baseline);
    // 显式 mcpAllow 也不能在零注册下凭空造出工具 (零注册短路优先于授权清单)。
    const seen2: { options?: Options } = {};
    const run2 = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('好'), success()], seen2), skillDeps: { roots: [] } });
    await run2({ prompt: 'x', model: MODEL, mcpAllow: ['some:tool'] });
    expect(seen2.options?.allowedTools).not.toContain('mcp__omd__mcp_find');
    expect(seen2.options?.systemPrompt).not.toContain('mcp_find');
  });
});

// ── 开放生态 S3: read_skill 下放 leaf (D-S3-5 挂载点 + D-S3-6 不过 policy 闸) ──
describe('S3: read_skill 经 leaf 装配 (tmp cwd + 注入 roots, D-S3-9 不碰真仓 .omd/ 与 ~/.claude/skills)', () => {
  const SKILL_BODY = '# OMD Council\n\n逐条对照评审。\n\n- 清单见 [评审清单](./refs/checklist.md)\n\n末尾一行。';

  /** 在 <root>/.omd/skills/omd-council/ 落 SKILL.md (含相对路径引用行) 与其引用文件。 */
  function plantCouncilSkill(root: string): string {
    const dir = join(root, '.omd', 'skills', 'omd-council');
    mkdirSync(join(dir, 'refs'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: omd-council\ndescription: 评审方法论\n---\n${SKILL_BODY}\n`);
    writeFileSync(join(dir, 'refs', 'checklist.md'), '- 条目一\n');
    return join(root, '.omd', 'skills');
  }

  // 证伪 (C-S3-6): ①把 execute 命中分支改成只返正文首行 (或返空串) → 全文逐字节断言必红
  // (空串还会被读成"这条 skill 没内容", skill-tool 找不到分支的既有纪律); ②从 agent-leaf.ts
  // 拼装点删掉 read_skill 挂载 → allowedTools 断言必红。缺一即证该闸是摆设。
  it('S3-C8-A: 项目 .omd/skills 的 SKILL.md 经 leaf 装配 read_skill 取到完整原文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-leaf-s3a-'));
    const roots = [plantCouncilSkill(root)];
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('好'), success()], seen), skillDeps: { roots } });
    await run({ prompt: 'x', model: MODEL });
    // ① leaf 工具面含 read_skill (桥后命名, 同六件基线的 mcp__omd__ 前缀形态)。
    expect(seen.options?.allowedTools).toContain('mcp__omd__read_skill');
    // ② 以同一注入 roots 取工具实例, execute 命中 → content 逐字节等于 SKILL.md 正文全文
    // (src.body.trim() 口径), 含相对引用行原文。
    const readSkill = createSkillTools({ roots }).find((t) => t.name === 'read_skill')!;
    const res = (await readSkill.execute('call-1', { name: 'omd-council' } as never, undefined, undefined)) as {
      content: { type: string; text?: string }[];
      details?: unknown;
    };
    const out = res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
    expect(out).toBe(SKILL_BODY);
    expect(out).toContain('[评审清单](./refs/checklist.md)');
    // ③ details 形态钉死。
    expect(res.details).toEqual({ name: 'omd-council', found: true });
  });

  // 证伪 (C-S3-6): 把 read_skill 的挂载挪进 MCP policy 求值路径 (经 mcp_call 桥 / leafMcpPolicy
  // 过一遍) → 未声明 mcpAllow 时它不是被拒就是不在 allowedTools → 两条断言必红; 反过来若
  // 顺带把 S2 policy 闸拆了 (mcp meta-tool 零注册也挂/不挂判据变了) → mcp 侧断言红。
  it('C-S3-4: 未声明 mcp/skills 的 leaf 挂 read_skill, 不触发 C-5/D-7 拒绝路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-leaf-s3policy-'));
    const roots = [plantCouncilSkill(root)];
    // 注册一个 MCP server 但**不声明** mcpAllow → D-7 缺省 deny: meta-tool 在岗而调用会被拒。
    writeFileSync(join(root, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { foo: { command: 'true' } } }));
    const seen: { options?: Options } = {};
    const run = createAgentLeafRunner({ cwd: root, sdkQueryFn: fakeQuery([asst('好'), success()], seen), skillDeps: { roots } });
    await run({ prompt: 'x', model: MODEL });
    // read_skill 是直接挂的只读本进程工具, 不在 mcp_call 桥后 —— leafMcpPolicy 的求值路径
    // 根本碰不到它 (D-S3-6: 不过 C-5/D-7 闸)。
    expect(seen.options?.allowedTools).toContain('mcp__omd__read_skill');
    // S2 policy 闸语义不动: 注册了 server → meta-tool 仍在岗 (deny 是调用期求值, 不是不挂)。
    expect(seen.options?.allowedTools).toContain('mcp__omd__mcp_call');
  });
});
