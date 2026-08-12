/**
 * src/serve/read-api —— 座位/额度视图 (readSeats) 契约测试 (S4)。
 *
 * T-1..T-4 每条都写了「怎么让它红」并当场证伪过 —— 永远绿的闸不是闸。
 *
 * ⚠ 这里**不许用 `mock.module`**。Bun 的 `mock.restore()` 只撤 `spyOn`/`mock()` 造的桩,
 * **不撤 module mock** —— 而 module mock 改写的是进程级模块注册表, 会活到整个 `bun test` 结束,
 * 泄给后面**别的文件**。实测代价 (2026-08-12): 这里曾把 `../model/cost-ledger` 整个换成
 * 一个只有 `channelOf` 的对象, 于是全量跑里 `channelOf` 恒返 `subscription`、`computeCost`
 * 直接消失, 打红 7 个无关文件共 10 条闸 (cost-channel / tui ledger / model-router-reward /
 * S6 批级闸 / dag_status 活体进度 / dream assembly + extract-chat)。单跑每个都绿, 只有全量红 ——
 * 于是那 10 条被读成「已知红」, 成本账本那一片的闸在全量跑里等于哑的。
 * 原来那条「mock 测试排最后」的纪律只护得住**本文件**的后续, 护不住后面的文件。
 * `spyOn` 没有这个问题 (`mock.restore()` 管得着), 且实测穿得到 `read-api.ts` 的 import 绑定。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMcpServers,
  readPlaybooks,
  readProfiles,
  readRunBoard,
  readSeats,
  readSkills,
  type RunBoardClaimedEvent,
  type RunBoardTerminalEvent,
  type SeatRow,
  type SeatsView,
} from './read-api';
import * as costLedger from '../model/cost-ledger';
import { channelOf } from '../model/cost-ledger';
import { ALL_SEAT_IDS, SEAT_PREFERRED_COORD } from '../model/seats';
import type { PlanLedger } from '../harness/plan-ledger';
import { createOmdSessionStore, resetSessionCacheForTest } from '../harness/chat/session-store';
import { createDaemonFetch } from './daemon';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-seats-'));
  delete process.env.OMD_DATA_HOME;
  resetSessionCacheForTest(); // 单写者表是模块级的 —— 不清会把上一条临时目录的实例带进来
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('T-1: SeatRow.channel 与 cost-ledger.channelOf(coord) 一致', () => {
  test('真实数据: 每个有 coord 的座位 channel === channelOf(coord)(当前全是 openai-codex → api 分支)', () => {
    const view = readSeats(root);
    const withCoord = view.seats.filter((s) => s.coord !== undefined);
    // seats.ts 里显式配了 preferredCoord 的座位数(静态表 6 个, 全是 openai-codex:gpt-5.6-sol)
    expect(withCoord.length).toBeGreaterThan(0);
    for (const row of withCoord) {
      expect(row.channel).toBe(channelOf(row.coord!));
    }
    // 无 coord 的座位 channel 必须是 undefined —— channelOf 需要入参, 不许替它编一个 'api'
    for (const row of view.seats) {
      if (!row.coord) expect(row.channel).toBeUndefined();
    }
    // 订阅分支的真源判据: 静态表里没有订阅坐标样本, 但分道判据本身必须是真的
    // (claude-code:* 走 Agent SDK 订阅通道, 其余按美元计价 —— cost-ledger.ts 头注)
    expect(channelOf('claude-code:claude-opus-4-8')).toBe('subscription');
    expect(channelOf('openai-codex:gpt-5.6-sol')).toBe('api');
    // 怎么让它红: readSeats 里把 channel 写成恒 'api' / 或自写一份与 channelOf 不一致的判据 → 循环断言失败。
  });
});

describe('T-2: NULL ≠ 0 ≠ 不适用 —— 取不到必须 undefined + unavailable 带非空 reason', () => {
  test('leaf 座位(无 preferredCoord)全部可空字段 undefined, unavailable 逐项有非空 reason', () => {
    const view = readSeats(root);
    const leaf = view.seats.find((s) => s.role === 'leaf');
    expect(leaf, 'leaf 座位必须在列表里(seats.ts ALL_SEAT_IDS 含 leaf)').toBeDefined();
    expect(leaf!.coord).toBeUndefined();
    expect(leaf!.channel).toBeUndefined();
    expect(leaf!.spentUsd).toBeUndefined();
    expect(leaf!.tokensIn).toBeUndefined();
    expect(leaf!.tokensOut).toBeUndefined();
    expect(leaf!.overflowTo).toBeUndefined();

    // 反向自检(当场证伪过): 把 readSeats 里任一取不到路径改成 `?? 0` 或 `?? ''`
    // (例如 `coord: SEAT_PREFERRED_COORD[role] ?? ''`, 或 `spentUsd: 0`) → 上面断言立刻红。
    // undefined ≠ 0 ≠ 不适用 —— 一个取不到的数不许画成 0。
    for (const field of ['leaf.coord', 'spentUsd', 'tokensIn', 'tokensOut', 'overflowTo']) {
      const entry = view.unavailable.find((u) => u.field === field);
      expect(entry, `unavailable 缺 ${field} 条目(取不到不解释 = 骗人)`).toBeDefined();
      expect(entry!.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test('全部座位: 花费/用量/溢出恒 undefined(不只查 leaf 一只, 防漏网)', () => {
    const view = readSeats(root);
    for (const row of view.seats) {
      expect(row.spentUsd).toBeUndefined();
      expect(row.tokensIn).toBeUndefined();
      expect(row.tokensOut).toBeUndefined();
      expect(row.overflowTo).toBeUndefined();
    }
    // 有 coord 的座位数必须与 seats.ts 真源一致(SEAT_PREFERRED_COORD 只含显式配了的)
    expect(view.seats.filter((s) => s.coord !== undefined).length).toBe(
      ALL_SEAT_IDS.filter((id) => SEAT_PREFERRED_COORD[id] !== undefined).length,
    );
  });
});

describe('T-3: GET /api/seats —— createDaemonFetch 造 handler, 不占端口', () => {
  let fetchFn: (req: Request) => Promise<Response>;

  const fakeLedger: PlanLedger = {
    record: () => null,
    families: () => [],
    plans: () => [],
    planJson: () => null,
    rebuild: () => 0,
    close: () => {},
  };

  beforeEach(() => {
    // deps 桩照 daemon.test.ts 既有 fixture 的形状(读侧路由不碰 tools/chat/ledger 的实际内容)
    fetchFn = createDaemonFetch({
      cwd: root,
      tools: [],
      chatStore: createOmdSessionStore(root),
      ledger: fakeLedger,
      resolveChatModel: () => 'deepseek:deepseek-v4-flash',
      chatTools: [],
    });
  });

  test('200 且 body 形状匹配 SeatsView;非 GET 落 404', async () => {
    // 怎么让它红: daemon.ts 漏挂这条路由(或写成 POST-only)→ 请求落 notFound(404), status 断言失败。
    const res = await fetchFn(new Request('http://x/api/seats'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SeatsView;
    expect(Array.isArray(body.seats)).toBe(true);
    for (const s of body.seats) expect(typeof (s as SeatRow).role).toBe('string');
    for (const k of ['inFlight', 'waiting', 'cap', 'rpmTokens', 'rpmLimit'] as const) {
      expect(typeof body.budget[k]).toBe('number');
    }
    expect(Array.isArray(body.unavailable)).toBe(true);
    for (const u of body.unavailable) {
      expect(typeof u.field).toBe('string');
      expect(u.reason.trim().length).toBeGreaterThan(0);
    }
    // 与直接读 readSeats 的结果一致 —— HTTP 面只是透传, 不许在 daemon 里再算第二份
    expect(body.seats).toEqual(readSeats(root).seats);
    // 只读视图: 非 GET 一律 404(与 /board 同款纪律, 写方法不许被静默当成读)
    expect((await fetchFn(new Request('http://x/api/seats', { method: 'POST' }))).status).toBe(404);
  });
});

describe('T-4: readSeats 只读 —— .omd/ 下文件调用前后逐字节一致', () => {
  function snapshot(dir: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.set(p, readFileSync(p));
      }
    };
    walk(dir);
    return out;
  }

  test('调用多次前后, .omd/ 文件列表与逐字节内容不变', () => {
    const omd = join(root, '.omd');
    mkdirSync(omd, { recursive: true });
    writeFileSync(join(omd, 'probe.txt'), '座位视图不许写盘\n');
    const before = snapshot(omd);

    const view = readSeats(root);
    expect(view.seats.length).toBeGreaterThan(0);
    readSeats(root); // 调多次, 防「第一次写、第二次不写」的缓存式实现蒙混过关
    readSeats(root);

    const after = snapshot(omd);
    expect(after.size).toBe(before.size);
    for (const [p, buf] of before) {
      const buf2 = after.get(p);
      expect(buf2, `文件被删: ${p}`).toBeDefined();
      expect(buf2!.equals(buf), `文件内容变了: ${p}`).toBe(true);
    }
    // 怎么让它红: 在 readSeats 里加任何 fs 写(如仿 readReadout 的落盘缓存) → 多文件/内容变 → 红。
    // 当前实现零 fs 调用(编译期常量 + 内存态 budgetStats), 这条闸是防未来回潮, 不是冗余。
  });
});

describe('S10-1: readSkills —— user/project 两层, missing ≠ empty, 断链跳过不算 warning', () => {
  let homeDir: string;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'omd-home-'));
  });
  afterEach(() => rmSync(homeDir, { recursive: true, force: true }));

  test('两层目录都不存在 → sources.*.status === missing(不是 empty), items 空', () => {
    // 怎么让它红: 把 scanSkillsDir 的 !existsSync 分支删掉直接 readdirSync → 抛出而非 missing。
    const view = readSkills(root, homeDir);
    expect(view.sources.user.exists).toBe(false);
    expect(view.sources.user.status).toBe('missing');
    expect(view.sources.project.exists).toBe(false);
    expect(view.sources.project.status).toBe('missing');
    expect(view.items).toEqual([]);
    expect(view.warnings).toEqual([]);
  });

  test('目录存在但无子目录 → status === empty(与 missing 必须不同值)', () => {
    // 怎么让它红: 把 empty 分支写死成 'missing' 或省略 status 判定 → 与上一条断言撞车。
    mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
    const view = readSkills(root, homeDir);
    expect(view.sources.user.exists).toBe(true);
    expect(view.sources.user.status).toBe('empty');
    expect(view.sources.user.status).not.toBe(view.sources.project.status === 'missing' ? 'missing' : view.sources.user.status);
  });

  test('project 层一个技能目录, 递归收集 *.md, 不猜 SKILL.md 文件名', () => {
    const skillDir = join(root, '.omd', 'skills', 'foo-skill');
    mkdirSync(join(skillDir, 'nested'), { recursive: true });
    writeFileSync(join(skillDir, 'notes.md'), '# foo');
    writeFileSync(join(skillDir, 'nested', 'more.md'), '# more');
    writeFileSync(join(skillDir, 'ignore.txt'), 'not markdown');
    const view = readSkills(root, homeDir);
    expect(view.sources.project.status).toBe('ok');
    const item = view.items.find((i) => i.name === 'foo-skill');
    expect(item, '技能条目必须出现').toBeDefined();
    expect(item!.scope).toBe('project');
    expect(item!.markdownFiles).toEqual(
      [join(skillDir, 'nested', 'more.md'), join(skillDir, 'notes.md')].sort(),
    );
    // 怎么让它红: 把 collectMarkdownFiles 换成只找 SKILL.md → notes.md/more.md 丢失, 断言失败。
  });

  test('断链子目录静默跳过, 不计入 items 也不产生 warning(常见于旧 user skills 链接)', () => {
    const dir = join(homeDir, '.claude', 'skills');
    mkdirSync(dir, { recursive: true });
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(join(dir, 'does-not-exist'), join(dir, 'dead-link'));
    const view = readSkills(root, homeDir);
    expect(view.items.find((i) => i.name === 'dead-link')).toBeUndefined();
    expect(view.warnings).toEqual([]);
    // status 无候选也无失败 → empty, 不是 error(断链不算失败)
    expect(view.sources.user.status).toBe('empty');
    // 怎么让它红: 把 isSkillEntryDirectory 的 catch 分支从 `return false` 改成 `throw` 或产 warning。
  });
});

describe('S10-2: readMcpServers —— .omd/mcp.json missing/empty/ok/error, env 值绝不透传', () => {
  test('文件不存在 → missing, items 空', () => {
    const view = readMcpServers(root);
    expect(view.source.exists).toBe(false);
    expect(view.source.status).toBe('missing');
    expect(view.items).toEqual([]);
  });

  test('文件存在但 mcpServers 为空对象 → empty(与 missing 不同值)', () => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(join(root, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const view = readMcpServers(root);
    expect(view.source.exists).toBe(true);
    expect(view.source.status).toBe('empty');
  });

  test('坏 JSON → error, warnings 带路径 + 原始错误文本(不是空 catch)', () => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    const file = join(root, '.omd', 'mcp.json');
    writeFileSync(file, '{ not valid json');
    const view = readMcpServers(root);
    expect(view.source.status).toBe('error');
    expect(view.warnings.length).toBe(1);
    expect(view.warnings[0]!.path).toBe(file);
    expect(view.warnings[0]!.error.length).toBeGreaterThan(0);
    // 怎么让它红: 把 pushReadWarning 换成空 catch {} → warnings 长度断言从 1 变 0, 直接失败。
  });

  test('一个 server 合法一个缺 command → partial, env 只暴露键名不暴露值', () => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'bun', args: ['run', 'x'], env: { API_KEY: 'secret-value-should-not-appear' } },
          bad: { args: [] },
        },
      }),
    );
    const view = readMcpServers(root);
    expect(view.source.status).toBe('partial');
    expect(view.items.length).toBe(1);
    expect(view.items[0]!.name).toBe('good');
    expect(view.items[0]!.envKeys).toEqual(['API_KEY']);
    expect(JSON.stringify(view)).not.toContain('secret-value-should-not-appear');
    expect(view.warnings.some((w) => w.path.includes('bad'))).toBe(true);
    // 怎么让它红: 把 envKeys 换成透传 entry.env 本体 → JSON.stringify 断言命中密钥文本, 失败。
  });
});

describe('S10-3: readRunBoard —— .omd/run-board.jsonl missing/empty/partial, 保持行序', () => {
  test('文件不存在 → missing', () => {
    const view = readRunBoard(root);
    expect(view.source.exists).toBe(false);
    expect(view.source.status).toBe('missing');
    expect(view.items).toEqual([]);
  });

  test('文件存在但全空白行 → empty(与 missing 不同值)', () => {
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(join(root, '.omd', 'run-board.jsonl'), '\n\n');
    const view = readRunBoard(root);
    expect(view.source.exists).toBe(true);
    expect(view.source.status).toBe('empty');
  });

  test('一行合法一行坏 JSON → partial, 保持文件行序, warning 带 file:行号', () => {
    const file = join(root, '.omd', 'run-board.jsonl');
    mkdirSync(join(root, '.omd'), { recursive: true });
    const claimed = JSON.stringify({ v: 1, ts: 't1', runId: 'r1', event: 'claimed', writeSet: ['a.ts'] });
    writeFileSync(file, `${claimed}\nnot json at all\n`);
    const view = readRunBoard(root);
    expect(view.source.status).toBe('partial');
    expect(view.items.length).toBe(1);
    expect(view.items[0]).toEqual(JSON.parse(claimed));
    expect(view.warnings.length).toBe(1);
    expect(view.warnings[0]!.path).toBe(`${file}:2`);
    expect(view.warnings[0]!.error.length).toBeGreaterThan(0);
    // 怎么让它红: 把坏行的 push 挪到有效行前面, 或用 Set 重排 items → items[0] 断言失败(行序钉死)。
  });

  test('两行都合法(claimed + terminal)→ ok, 顺序与文件一致', () => {
    const file = join(root, '.omd', 'run-board.jsonl');
    mkdirSync(join(root, '.omd'), { recursive: true });
    // 标类型而不是逐字段 `as const`: v/event 都是字面量类型, 裸对象字面量会把它们推宽成
    // number/string, 而整个对象 `as const` 又会让 writeSet 变 readonly —— 两头都不对。
    const claimed: RunBoardClaimedEvent = { v: 1, ts: 't1', runId: 'r1', event: 'claimed', writeSet: ['a.ts'] };
    const terminal: RunBoardTerminalEvent = { v: 1, ts: 't2', runId: 'r1', event: 'terminal', outcome: 'done' };
    writeFileSync(file, `${JSON.stringify(claimed)}\n${JSON.stringify(terminal)}\n`);
    const view = readRunBoard(root);
    expect(view.source.status).toBe('ok');
    expect(view.items).toEqual([claimed, terminal]);
  });
});

describe('S10-4: readProfiles —— builtin 恒存在, project missing ≠ empty, 字段级合并', () => {
  test('project 层目录不存在(仓库现状: .omd/profiles 不存在)→ sources.project.status === missing', () => {
    // 怎么让它红: scanProfileDir 把 missing 分支删掉 → 落到 readdirSync 抛出, catch 成 error 而非 missing。
    const view = readProfiles(root);
    expect(view.sources.project.exists).toBe(false);
    expect(view.sources.project.status).toBe('missing');
    // builtin 目录本仓真实存在且非空(design-review.json 等), 与 project 的 missing 必须不同值
    expect(view.sources.builtin.status).not.toBe('missing');
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.every((i) => i.sourceLayers.includes('builtin') || i.sourceLayers.includes('project'))).toBe(true);
  });

  test('project 层目录存在但为空 → status === empty(与 missing 是不同值, 不许都压成空数组)', () => {
    mkdirSync(join(root, '.omd', 'profiles'), { recursive: true });
    const view = readProfiles(root);
    expect(view.sources.project.exists).toBe(true);
    expect(view.sources.project.status).toBe('empty');
  });

  test('project 层同名档案字段级覆盖 builtin, sourceLayers 记两层, project 未写字段保留 builtin 值', () => {
    const builtinNames = readdirSync(join(process.cwd(), 'src', 'harness', 'profiles', 'builtin'))
      .filter((n) => n.endsWith('.json'));
    expect(builtinNames.length, '本仓 builtin 目录至少要有一个真档案样本, 否则这条测不到覆盖').toBeGreaterThan(0);
    const builtinRaw = JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'harness', 'profiles', 'builtin', builtinNames[0]!), 'utf-8'),
    ) as { name: string; persona: string };

    mkdirSync(join(root, '.omd', 'profiles'), { recursive: true });
    writeFileSync(
      join(root, '.omd', 'profiles', 'override.json'),
      JSON.stringify({ name: builtinRaw.name, persona: 'project 覆盖的 persona' }),
    );
    const view = readProfiles(root);
    const merged = view.items.find((i) => i.name === builtinRaw.name);
    expect(merged, '同名档案必须合并进 items').toBeDefined();
    expect(merged!.persona).toBe('project 覆盖的 persona');
    expect(merged!.sourceLayers).toEqual(['builtin', 'project']);
    // 怎么让它红: 把字段级合并换成整体覆盖 `merged.set(name, spec)` → 若 project json 缺 seat 字段,
    // builtin 的 seat 会被抹掉; 这里换个断言查 seat 是否还在也能测到, 当前用 persona 覆盖 + sourceLayers 双证。
  });

  test('project 层坏 JSON 档案 → warnings 带路径 + 原始错误文本(不是空 catch), 不炸整表', () => {
    const dir = join(root, '.omd', 'profiles');
    mkdirSync(dir, { recursive: true });
    const badFile = join(dir, 'broken.json');
    writeFileSync(badFile, '{ not valid json');
    const view = readProfiles(root);
    expect(view.warnings.some((w) => w.path === badFile && w.error.length > 0)).toBe(true);
    expect(view.items.length).toBeGreaterThan(0); // builtin 档案不受项目层坏文件影响
    // 怎么让它红: 把 scanProfileDir 里 catch 换成空 catch {} → warnings 里找不到 badFile, 断言失败。
  });
});

describe('T-1 补: 真调用 channelOf, 不是另写一份判据(打桩证订阅分支原样透传)', () => {
  // 桩必还原 —— 靠 hook 不靠记性。spyOn 归 mock.restore() 管 (module mock 不归, 见文件头)。
  afterEach(() => mock.restore());

  test('把 channelOf 返回值打成 subscription, readSeats 输出必须跟着变', () => {
    // 怎么让它红: 若把 readSeats 的 channel 改成内联 `coord?.startsWith('claude-code:') ? 'subscription' : 'api'`
    // (绕开 import 的 channelOf), 桩改了返回值但输出不跟着变 → 下面断言失败。
    // 静态表里没有订阅坐标样本, 打桩是证明「订阅返回值能原样透传到 SeatRow.channel」的唯一途径。
    spyOn(costLedger, 'channelOf').mockReturnValue('subscription');
    const view = readSeats(root);
    const withCoord = view.seats.filter((s) => s.coord !== undefined);
    expect(withCoord.length).toBeGreaterThan(0);
    for (const row of withCoord) expect(row.channel).toBe('subscription');
  });

  // 还原闸: 上一条的桩没撤干净, 这条当场红 —— 它就是那 10 条跨文件误红的**本地代理**,
  // 让「泄漏」在本文件里就被抓住, 不必等全量跑才发现。
  test('★ 桩撤干净了: channelOf 回真身 (泄漏的本地代理闸)', () => {
    expect(costLedger.channelOf('deepseek:deepseek-v4-flash')).toBe('api');
    expect(costLedger.computeCost).toBeTypeOf('function'); // module mock 会把它整个抹掉
  });
});

/**
 * Workflows 外层 playbook 只读视图 (S5 消费者)。
 *
 * 这三条同时也是 `src/harness/playbook/**` 的**可达性接线闸**: 在此之前 load.ts / types.ts
 * 是 import 图上的孤儿 (库造好了没人用), 可达性测试为此红了一直。
 */
describe('readPlaybooks —— 内置层可读 · 坏 playbook 不炸整页 · 两种"空"分得开', () => {
  test('内置 playbook 被读出来, 且带 builtin DiskSource', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-'));
    try {
      const view = readPlaybooks(root);
      // 证伪: 把 readPlaybooks 里的 loadPlaybooks 调用换成 `new Map()` → items 空 → 红。
      expect(view.items.length).toBeGreaterThan(0);
      expect(view.items.map((p) => p.name)).toContain('documentation-coverage');
      expect(view.sources.builtin.exists).toBe(true);
      // 项目层不存在是**合法**状态, 与"读了但拒收"必须分得开 (坑 #1: NULL ≠ 0 ≠ 不适用)。
      expect(view.sources.project.status).toBe('missing');
      expect(view.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('项目层有坏 playbook → 视图不抛, 但留证据 (status=error + warnings 带原文)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-'));
    try {
      mkdirSync(join(root, '.omd', 'playbooks', 'broken'), { recursive: true });
      writeFileSync(join(root, '.omd', 'playbooks', 'broken', 'playbook.json'), '{ not json !!!');
      const view = readPlaybooks(root);
      // 引擎侧 loadPlaybooks 是 fail-closed (抛错); 视图层必须接住 —— 一份坏 playbook
      // 不该让控制台整页打不开。证伪: 去掉 try/catch → 本测试直接抛异常 → 红。
      expect(view.sources.project.status).toBe('error');
      expect(view.warnings.length).toBeGreaterThan(0);
      // 不吞证据: 错误原文要在, 不能只留一个空列表。
      expect(JSON.stringify(view.warnings)).toContain('broken');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persona 缺失的档案:引擎与视图判据一致 (D-3 后 persona 可选)', () => {
    // 回归闸: read-api 自己扫盘, 是这条规则的第二份实装。它曾经比引擎严 ——
    // 引擎认的档案控制台不列, 且不报错, 只是少一行。
    const root = mkdtempSync(join(tmpdir(), 'pf-'));
    try {
      mkdirSync(join(root, '.omd', 'profiles'), { recursive: true });
      writeFileSync(join(root, '.omd', 'profiles', 'seat-only.json'), JSON.stringify({ name: 'zz-seat-only', seat: 'x:y' }));
      const view = readProfiles(root);
      // 证伪: 把判据改回 `|| typeof raw.persona !== 'string'` → 该档案被拒 → 红。
      expect(view.items.map((p) => p.name)).toContain('zz-seat-only');
      expect(view.warnings.find((w) => JSON.stringify(w).includes('seat-only'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
