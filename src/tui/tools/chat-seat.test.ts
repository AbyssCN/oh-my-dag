/**
 * 对话位工具面的判据(S-4)。**这是交付闸 G-A/G-B 的机器可判部分。**
 *
 * G-A(能改这个仓的代码)与 G-B(能跑命令看结果)最终要靠真跑一轮验(S-11),
 * 但那条路要花钱、要真模型。这里先钉住**必要条件**:手在不在工具面上。
 * 手不在,后面怎么验都是空的。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { assembleOmdMcpTools } from '../../mcp/assemble';
import { createDagRecorder } from '../../harness/dag-record';
import { buildConductorChatSystemPrompt } from '../../harness/harness-prompts';
import { HAND_TOOLS, createChatSeatTools } from './chat-seat';

// recorder 注入 :memory: —— 默认 createDagRecorder() 打开真仓 .omd/dag-runs.db (进程 cwd 锚,
// 缺陷②同族第四例): 外部 run 活跃时并发出 SQLiteError: disk I/O error 的假红 (NOTES 2026-08-10)。
const mcpTools = () => assembleOmdMcpTools({ recorder: createDagRecorder({ db: new Database(':memory:') }) });
const seat = () => createChatSeatTools({ cwd: process.cwd(), mcpTools: mcpTools() });

describe('对话位工具面 (S-4)', () => {
  // 反向自检 (实跑): 把 createChatSeatTools 里的 createOmdAgentTools 那一行去掉 → 这条当场红。
  test('★ 六只手都在 —— 少一只, "能独立在一个仓里工作"就不成立', () => {
    const names = seat().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...HAND_TOOLS]));
  });

  // ⚠ 这条防的是"给了手就把指挥面挤掉":判据升级要的是**又能指挥又能动手**,
  //   不是把 omd 降级成一个普通 coding agent。
  test('★ 指挥面没被挤掉 —— 派遣与动手是并存的两档', () => {
    const names = seat().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['omd_run', 'omd_solve', 'omd_status']));
  });

  test('手排在最前 —— 顺序就是 system prompt 里的列举顺序', () => {
    expect(seat().slice(0, HAND_TOOLS.length).map((t) => t.name)).toEqual([...HAND_TOOLS]);
  });

  test('工具名不重复 —— 重名的那只会被模型端静默丢掉一只', () => {
    const names = seat().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('system prompt 认得这些手 (S-4)', () => {
  // 反向自检: 把 harness-prompts 的 <hands> 段删掉 → 这条当场红。
  test('★ 有 <hands> 段 —— 给了工具不说能用, 模型不会去用', () => {
    const p = buildConductorChatSystemPrompt({ cwd: '/tmp/x' });
    expect(p).toContain('<hands>');
    expect(p).toContain('</hands>');
  });

  test('★ 每只手的 promptSnippet 都进了 prompt —— 否则它在工具面上但模型不知道', () => {
    const tools = seat();
    const p = buildConductorChatSystemPrompt({ cwd: '/tmp/x', tools });
    for (const name of HAND_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t?.promptSnippet, `${name} 没有 promptSnippet`).toBeTruthy();
      expect(p).toContain(t?.promptSnippet as string);
    }
  });
});

describe('接线闸:cli.ts 真的走这条装配', () => {
  /**
   * ⚠ 上面那些闸测的是**装配函数**,它们对"cli.ts 有没有调用它"一无所知 ——
   * 交接 37 坑 #7 正是这一族(`dag_run` 与 `dag_run_plan` 各组一份 config,只接一处 = 没接)。
   *
   * ⚠ 而且**不能只搜函数名**:坑 #5 记过,命令接线闸第一版靠"名字在文件里出现过"判,
   * 结果被**注释**蒙混过关。所以这里剔掉注释行再搜。
   */
  /**
   * ⚠ 判据必须**只看 tui 分支**。第一版扫了整个 `cli.ts` 并断言 `createConductorChatTools`
   * 不再出现 —— 当场红,而红得对:`omd serve` 那条分支还在用它,**且本来就该用**
   * (web 控制台是查看位,不是日常主力位;给它手是另一个决定,不在这一片的范围里)。
   * 那是我的判据写宽了,不是代码写错了。收窄比放宽正确。
   */
  const tuiBranch = (): string => {
    const src = readFileSync(new URL('../../harness/cli.ts', import.meta.url), 'utf-8');
    const from = src.indexOf("if (userArgs[0] === 'tui')");
    const to = src.indexOf("if (userArgs[0] === 'serve')");
    expect(from, 'cli.ts 里找不到 tui 分支 —— 判据锚点漂了').toBeGreaterThan(0);
    expect(to, 'cli.ts 里找不到 serve 分支 —— 判据锚点漂了').toBeGreaterThan(from);
    // 坑 #5:不能只搜名字, 注释会蒙混过关 —— 剔掉整行注释再搜。
    return src
      .slice(from, to)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  };

  test('★ cli.ts 的 tui 分支调用 createChatSeatTools(不算注释里的)', () => {
    expect(tuiBranch()).toContain('createChatSeatTools({');
  });

  test('★ 反过来:tui 分支不再自己拼工具面 —— 两处各拼一份必漂', () => {
    expect(tuiBranch()).not.toContain('createConductorChatTools(');
  });

  test('★ 2026-08-13:tui 分支把沙箱接进了工具面与 UI 两处(接一处 = 没接,坑 #7 同族)', () => {
    const b = tuiBranch();
    expect(b).toContain('loadSandboxConfig(');
    expect(b).toContain('probeShellSandbox(');
    // ⚠ 判据锚在**各自的调用点**上 —— 裸子串 'sandbox' 会匹配到扩展那行的 `sandboxed?:`,
    //   那种判据是碰运气(旧版审批那条就为此红过一次)。
    expect(b).toMatch(/createChatSeatTools\(\{[^)]*sandbox:/); // 工具面那半(读配置)
    expect(b).toMatch(/runOmdTui\(\{[^)]*sandbox:/); // UI 那半(画告警)
  });

  test('★ 2026-08-18:tui 分支不给 backend 传 memory —— 传了就是每轮自动召回', () => {
    // owner 裁:召回按需调(`memory_recall` 工具),不每轮往 prompt 里塞。传 `memory` 会让
    // `agent.ts` 挂上 `transformContext`,每次请求前召回一次 —— 实测屏上重复同一条
    // (`~/.omd/recall-events.jsonl` 8 次注入,每次 hits:1)。
    // 反向自检(2026-08-18 真跑过):把 `memory: createDefaultMemory(process.env),` 加回
    // cli.ts 的 createEmbeddedBackend 调用 → 本行红。
    // ⚠ 判据是**行首的键**,不是 `createEmbeddedBackend\(\{[^)]*memory:` —— 那个写法当场被
    //   证伪打回:`[^)]*` 在同一段里的 `createOmdSessionStore(cwd)` 就断了,永远够不到 memory 键
    //   (加回 memory 行照样绿)。这条注释留着,因为那正是「一条永远绿的闸」的样子。
    expect(tuiBranch()).not.toMatch(/^\s*memory:/m);
  });

  test('★ 审批层真的不在了 —— 留一句 setAsk 就等于打断器还活着', () => {
    const b = tuiBranch();
    expect(b).not.toContain('createApprovalGate');
    expect(b).not.toContain('approvals');
  });
});

/**
 * 2026-08-13 owner 裁:审批闸删掉,默认 yolo。**不变量仍是「闸永远有一层」**,
 * 只是那一层不再是人 —— 黑名单硬拒 + bwrap 围栏。这一组钉的就是那两层都真的在。
 *
 * 反向自检(实跑,判据必须会红):
 *   · 把 `chat-seat.ts` 的 `commandPolicy: sandboxCfg` 删掉 → 第 2 条仍绿(内置默认同表),
 *     但把 `createOmdAgentTools` 的 `guardDangerous` 默认改成 false → 第 1 条当场红。
 *   · 把 `sandbox: { root: o.cwd, … }` 那段删掉 → 第 3 条当场红(越界写会真的成功)。
 */
describe('yolo 之后剩下的两层闸(黑名单 + 围栏)', () => {
  const seatIn = (cwd: string) => createChatSeatTools({ cwd, mcpTools: mcpTools() });

  test('★ 黑名单:不可逆命令硬拒(没有审批可以按 y 绕过去了)', async () => {
    const bash = seatIn(process.cwd()).find((t) => t.name === 'bash');
    await expect(bash!.execute('t', { command: 'git push --force origin main' } as never)).rejects.toThrow('BLOCKED');
  });

  test('★ 白名单赦免黑名单 —— 顺序是白先黑后, 反了就等于没有逃生口', async () => {
    // 拿一条**无害**命令当探针: 黑名单命中它 → BLOCKED; 白名单赦免同一条 → 真跑。
    // 用真的 `git push --force` 会让"闸放行了"与"shell 失败了"混在一个错误里, 分不开。
    const bash = createChatSeatTools({
      cwd: process.cwd(),
      mcpTools: mcpTools(),
      sandbox: { enabled: false, writable: [], allow: [/^echo pardoned$/], deny: [{ label: 't', reason: 'test', re: /^echo / }] },
    }).find((t) => t.name === 'bash');
    await expect(bash!.execute('t', { command: 'echo blocked' } as never)).rejects.toThrow('BLOCKED');
    const ok = await bash!.execute('t', { command: 'echo pardoned' } as never);
    expect((ok.content[0] as { text: string }).text).toContain('pardoned');
  });

  test('★ 围栏:write 越出工作根即拒 —— 围栏只挡 bash 的话它挡不住任何东西', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omd-seat-fence-'));
    const write = seatIn(root).find((t) => t.name === 'write');
    // 工作根之内: 照写。
    const inside = await write!.execute('t', { path: 'ok.txt', content: 'x' } as never);
    expect((inside.content[0] as { text: string }).text).toContain('ok.txt');
    // 工作根之外(且不在 /tmp 白名单的那一支下): 拒, 并说清边界在哪。
    await expect(write!.execute('t', { path: '/etc/omd-should-not-exist', content: 'x' } as never)).rejects.toThrow('沙箱越界');
  });

  test('read 一个字都不拦 —— yolo 的前提就是读半区零摩擦', async () => {
    const read = seatIn(process.cwd()).find((t) => t.name === 'read');
    const r = await read!.execute('t', { path: 'package.json' } as never);
    expect((r.content[0] as { text: string }).text).toContain('oh-my-dag');
  });
});

describe('开放生态 S1:外部 MCP 双 meta-tool 接线 (I-1 / I-2)', () => {
  // 反向自检: 把 chat-seat.ts 里 createMcpClientTools 那行删掉 → I-2 那条当场红。
  test('★ I-1 零注册 → 工具面与今日相同, 没有 mcp_find/mcp_call', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-seat-nomcp-'));
    const names = createChatSeatTools({ cwd, mcpTools: mcpTools() }).map((t) => t.name);
    expect(names).not.toContain('mcp_find');
    expect(names).not.toContain('mcp_call');
  });

  test('★ I-2 有注册 → 恰好多两件 meta-tool, 外部工具本身不进工具面', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-seat-mcp-'));
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { some: { command: 'x' } } }));
    const bare = createChatSeatTools({ cwd: mkdtempSync(join(tmpdir(), 'omd-seat-nomcp2-')), mcpTools: mcpTools() });
    const withMcp = createChatSeatTools({ cwd, mcpTools: mcpTools() });
    expect(withMcp.length).toBe(bare.length + 2);
    expect(withMcp.map((t) => t.name)).toEqual(expect.arrayContaining(['mcp_find', 'mcp_call']));
  });

  test('meta-tool 的 promptSnippet 进 system prompt(工具在面上, 模型得知道)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-seat-mcp2-'));
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { some: { command: 'x' } } }));
    const tools = createChatSeatTools({ cwd, mcpTools: mcpTools() });
    const p = buildConductorChatSystemPrompt({ cwd, tools });
    expect(p).toContain('mcp_find');
    expect(p).toContain('mcp_call');
  });
});
