/**
 * 对话位工具面的判据(S-4)。**这是交付闸 G-A/G-B 的机器可判部分。**
 *
 * G-A(能改这个仓的代码)与 G-B(能跑命令看结果)最终要靠真跑一轮验(S-11),
 * 但那条路要花钱、要真模型。这里先钉住**必要条件**:手在不在工具面上。
 * 手不在,后面怎么验都是空的。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { assembleOmdMcpTools } from '../../mcp/assemble';
import { buildConductorChatSystemPrompt } from '../../harness/harness-prompts';
import { createApprovalGate } from '../approval/gate';
import { HAND_TOOLS, createChatSeatTools } from './chat-seat';

const seat = () => createChatSeatTools({ cwd: process.cwd(), mcpTools: assembleOmdMcpTools() });

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

  test('★ 切片①:tui 分支把审批闸接进了工具面与 UI 两处(接一处 = 没接,坑 #7 同族)', () => {
    const b = tuiBranch();
    expect(b).toContain('createApprovalGate(');
    expect(b).toContain('approvals });'); // createChatSeatTools({ …, approvals })
    expect(b).toMatch(/runOmdTui\(\{[^}]*approvals/); // UI 那半也接了
  });
});

describe('切片①:审批闸包在工具面外(不变量:闸永远有一层)', () => {
  test('★ 有闸:write 走审批 —— 拒绝则不执行(抛 [approval], 不是静默空结果)', async () => {
    const gate = createApprovalGate({});
    gate.setAsk(async () => 'deny');
    const tools = createChatSeatTools({ cwd: process.cwd(), mcpTools: assembleOmdMcpTools(), approvals: gate });
    const write = tools.find((t) => t.name === 'write');
    await expect(write!.execute('t', { path: '/tmp/omd-approval-should-not-exist.txt', content: 'x' } as never)).rejects.toThrow(
      '[approval] 用户拒绝',
    );
  });

  test('★ 有闸:bash 不可逆命令走 admin 档审批(内层硬拒已交给外层)——拒绝时报 [approval] 而不是 BLOCKED', async () => {
    const gate = createApprovalGate({});
    gate.setAsk(async () => 'deny');
    const tools = createChatSeatTools({ cwd: process.cwd(), mcpTools: assembleOmdMcpTools(), approvals: gate });
    const bash = tools.find((t) => t.name === 'bash');
    await expect(bash!.execute('t', { command: 'git push --force origin main' } as never)).rejects.toThrow('[approval]');
  });

  test('★ 无闸:内层危险命令闸保持原样(fail-closed 硬拒)—— 两层不会同时缺席', async () => {
    const tools = createChatSeatTools({ cwd: process.cwd(), mcpTools: assembleOmdMcpTools() });
    const bash = tools.find((t) => t.name === 'bash');
    await expect(bash!.execute('t', { command: 'git push --force origin main' } as never)).rejects.toThrow('BLOCKED');
  });

  test('有闸:read 不经审批直接执行(G-1: read 全程不弹框)', async () => {
    const gate = createApprovalGate({});
    let askedCount = 0;
    gate.setAsk(async () => {
      askedCount += 1;
      return 'deny';
    });
    const tools = createChatSeatTools({ cwd: process.cwd(), mcpTools: assembleOmdMcpTools(), approvals: gate });
    const read = tools.find((t) => t.name === 'read');
    const r = await read!.execute('t', { path: 'package.json' } as never);
    expect(askedCount).toBe(0);
    expect((r.content[0] as { text: string }).text).toContain('oh-my-dag');
  });
});
