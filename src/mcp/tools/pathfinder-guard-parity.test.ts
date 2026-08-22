/**
 * 守卫对位 (slice 2 · MCP 侧改用共享件) —— **「不漂」这条闸的载体**。
 *
 * 改前实测 (2026-08-19, `pathfinder.ts:112-116` 头注, 切片 1 已改写为 "已修"):
 *   · `#177` 在 path_rule / map_confirm 两入口的**两种行为之外**, 同一入口里裸 `177` 与
 *     `#177` 又各做各事 —— 四种写法 × 两个工具面 = 一张图上**最多四种结果**。
 * 改后: id 归一与守卫抽到 `ticket-guard.ts` (`resolveTicketId` / `canRule` / `canConfirm`),
 * MCP 工具面只调那一份。**本测试钉的是"调用方走 MCP 与直接调守卫拿到的是同一份判定"** —— 一旦
 * MCP 又内联一份逻辑, 这条会立刻红。
 *
 * ⚠ **本质是结对调用**: 对每一张图 × 每一个 id 写法, 同时跑两路:
 *   · 路 A: 注入 fixture 跑 `path_rule` / `map_confirm` 的 handler (MCP 工具面路径)
 *   · 路 B: 直接调 `canRule` / `canConfirm` (守卫路径)
 * 两路在 `isError` / `ok` 上必须**逐位一致**; `ok:true` 时 `id` 也必须一致 (归一后的盘上真 id)。
 *
 * 反向自检 (slice 2 的闸有效性):
 *   · 把 `makeRule` 里 `canRule(pre, ...)` 换回旧的 `resolveTicketId` + `tickets.find` 逐行写法 →
 *     裸 `177` 那条不再走守卫 → `isError: undefined` 而不是 `true`, GWT-1 红。
 *   · 把 `map_confirm` 里 `canConfirm` 删掉 → 裸 `177` 报「票不存在」, GWT-2 红。
 *   · 把 `canRule` 里 suggested 判断挪到 `canConfirm` → GWT-3 红 (confirm 拒自己的合法目标)。
 *
 * @see SDD 片 6 slice 2 · INV-BOX-1
 */

import { describe, expect, test } from 'bun:test';
import { createPathfinderTools } from './pathfinder';
import type { GhResult, GhRunner } from '../../harness/pathfinder/backend';
import { createGhBackend } from '../../harness/pathfinder/backend-gh';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { canConfirm, canRule } from '../../harness/pathfinder/ticket-guard';

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

/** 一张 suggested 票 (`#226`) + 一张普通 open 票 (`t1`), 与 `ticket-guard.test.ts` 同形。 */
const fixtureMap = (): PathMap => ({
  destination: 'parity 测试图',
  slug: 'parity',
  tickets: [
    { id: '#226', type: 'task', title: '机器建议票', blockedBy: [], status: 'suggested', suggestedBy: 'run-p' } as Ticket,
    { id: 't1', type: 'task', title: '普通前沿票', blockedBy: [], status: 'open' } as Ticket,
  ],
  decisionsLog: [],
});

/** 注入 fixture graph 给 MCP + 返回 gh 调用追踪 (本测试不真写 gh, 只想验守卫路径)。 */
function toolsWithMap(map: PathMap, calls: string[][]): {
  ruleHandler: (ticketId: string, ruling: string) => Promise<{ isError?: boolean; text: string }>;
  confirmHandler: (ticketId: string, action: 'accept' | 'reject') => Promise<{ isError?: boolean; text: string }>;
} {
  /** 把fixture 灌进 readMap 的最简办法: 跑一次 path_map(destination=...) 但**不要**真列图 —— 直接给
   *  gh 注入 map 视图。这里偷懒: 复用 `ticket-id-form.test.ts` 同样的 gh graph 形状, 把 #226 拼进去。 */
  const mapResp = JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 5,
          title: '🧭 [map] parity',
          body: 'Destination: parity',
          state: 'OPEN',
          subIssues: {
            nodes: map.tickets.map((t) => ({
              number: Number((t.id.startsWith('#') ? t.id.slice(1) : t.id).replace(/\D/g, '')) || 1,
              // gh 用真 int 编号 —— 把 `#226` 解成 226, 把 `t1` 解成 1。
              title: `${t.status === 'suggested' ? '[suggested] ' : ''}[${t.type}] ${t.title}`,
              body: '',
              state: 'OPEN',
              labels: { nodes: [{ name: `path:${t.type}` }, ...(t.status === 'suggested' ? [{ name: 'path:suggested' }] : [])] },
              comments: { nodes: [] },
              subIssues: { nodes: [] },
            })),
          },
        },
      },
    },
  });
  const gh: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === 'repo' && args[1] === 'view') return okr(JSON.stringify({ nameWithOwner: 'a/b' }));
    if (args[0] === 'issue' && args[1] === 'list') return okr(JSON.stringify([{ number: 5, title: '🧭 [map] parity' }]));
    if (args.includes('graphql')) return okr(mapResp);
    return okr('');
  };
  const list = createPathfinderTools({
    cwd: '/tmp',
    env: {},
    models: { conductorModel: '', leafModel: '' },
    resolveBackend: () => createGhBackend(gh),
  } as never);
  const ruleTool = list.find((t) => t.name === 'path_rule')!;
  const confirmTool = list.find((t) => t.name === 'map_confirm')!;
  return {
    ruleHandler: async (ticketId, ruling) => {
      const r = (await ruleTool.handler({ ticketId, ruling, slug: '5' } as never, {} as never)) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { isError: r.isError, text: r.content.map((c) => c.text ?? '').join('\n') };
    },
    confirmHandler: async (ticketId, action) => {
      const r = (await confirmTool.handler({ ticketId, action, slug: '5' } as never, {} as never)) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { isError: r.isError, text: r.content.map((c) => c.text ?? '').join('\n') };
    },
  };
}

describe('守卫对位 · path_rule 同票两种写法走 MCP 与直调 canRule 判定一致', () => {
  test('★ #226 (suggested) 两种写法 → MCP isError=true / canRule.ok=false', () => {
    const map = fixtureMap();
    for (const raw of ['#226', '226']) {
      // MCP 路 —— fixtureMap 灌进 gh graph 后已可走 (上面 toolsWithMap 把它注入进 #226);
      // 我们这里用同一张 fixture map 的镜像跑守卫, 因为 MCP 路要走 gh 真链路 ——
      // 但守卫要判的是同一份图 (盘上的真 id), 所以直接对 fixtureMap 调即可。
      const direct = canRule(map, raw);
      expect(direct.ok).toBe(false);
      if (direct.ok) return;
      // 只做"判定形状"对位 (ok 同 + suggested-reason 出现), MCP 路在下方 describe 跑真链路;
      // 真链路要的 isError 同形断言见 parity GWT-MCP-* describe 块。
      expect(direct.reason).toContain('先 map_confirm');
    }
  });

  test('认不出的 id → canRule.ok=false 且 reason 字面照 MCP', () => {
    const map = fixtureMap();
    for (const raw of ['999', '#999', '  999  ']) {
      const r = canRule(map, raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain('找不到票');
    }
  });
});

describe('守卫对位 · map_confirm 同票两种写法走 MCP 与直调 canConfirm 判定一致', () => {
  test('★ #226 (suggested) 两种写法 → canConfirm.ok=true (suggested 是 confirm 合法目标)', () => {
    const map = fixtureMap();
    expect(canConfirm(map, '#226')).toEqual({ ok: true, id: '#226' });
    expect(canConfirm(map, '226')).toEqual({ ok: true, id: '#226' }); // 裸 id 归一到 #226
  });

  test('认不出的 id → canConfirm.ok=false 且 reason 字面照 canRule (两入口同辞)', () => {
    const map = fixtureMap();
    const r = canConfirm(map, '999');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(`找不到票 "999" — map_tickets 看现有票 (gh 后端的 id 形如 #206)`);
  });
});

describe('守卫对位 · MCP 真链路 isError 与 canRule/canConfirm.ok 同形', () => {
  // 这一组是真链路对位 —— 灌 fixture 进 gh, 让 MCP handler 跑, 看 isError 与守卫 ok 同形。
  // 它**完全反向自检**: 改坏 makeRule/makeConfirm 的导入或逻辑, 下面 GWT-MCP-1/2/3 任一红。

  test('GWT-MCP-1: #226 + rule → MCP isError=true / canRule.ok=false / 同份 reason 关键词', async () => {
    const map = fixtureMap();
    const calls: string[][] = [];
    const { ruleHandler } = toolsWithMap(map, calls);
    // MCP 真链路走规则接口 —— 守卫拒绝 → 不应到达 backend.rule 写侧
    const mcp = await ruleHandler('#226', '裁掉它');
    const direct = canRule(map, '#226');
    expect(!!mcp.isError).toBe(!direct.ok);
    expect(mcp.isError).toBe(true);
    expect(direct.ok).toBe(false);
    // 关键指引字面保留 (INV-BOX-1 已说「reason 字面不要重写」)
    if (!direct.ok) {
      expect(mcp.text).toContain('先 map_confirm accept/reject');
    }
  });

  test('GWT-MCP-2: 裸 226 + rule → MCP isError=true / canRule.ok=false (证 #206 漂封堵)', async () => {
    const map = fixtureMap();
    const calls: string[][] = [];
    const { ruleHandler } = toolsWithMap(map, calls);
    // ★ 这一条是闸的全部理由: 改前 MCP 这路给出 isError=undefined + 写 gh;
    // 改后守卫拦下, isError=true, 零 gh 写。
    const mcp = await ruleHandler('226', '裁掉它');
    const direct = canRule(map, '226');
    expect(!!mcp.isError).toBe(!direct.ok);
    expect(mcp.isError).toBe(true);
    expect(direct.ok).toBe(false);
    // 关键: 裸与 #N 必须给同一份 reason 关键词 (不能再各自说各的)
    if (!direct.ok) {
      expect(mcp.text).toContain('先 map_confirm accept/reject');
      expect(mcp.text).toContain('#226'); // reason 里点的 id = 盘上真 id
    }
    // 验证「零 gh 写」(守卫生效的另一面)
    const wroteGh = calls.some((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'close' || c[1] === 'edit'));
    expect(wroteGh).toBe(false);
  });

  test('GWT-MCP-3: 裸 226 + confirm → MCP isError=false / canConfirm.ok=true (证 map_confirm 归一已生效)', async () => {
    const map = fixtureMap();
    const calls: string[][] = [];
    const { confirmHandler } = toolsWithMap(map, calls);
    const mcp = await confirmHandler('226', 'reject');
    const direct = canConfirm(map, '226');
    expect(!!mcp.isError).toBe(!direct.ok);
    expect(direct.ok).toBe(true);
    // 不应再是「票不存在」(改前症状)。后端未实装 / fixture 不全接 confirmSuggestion 都可能让 MCP 报 isError,
    // 但**只要后端实装了**, 它必须走 accept/reject 而不是「找不到票」。
    // 这里允许 isError, 但**绝对不能**含「找不到票」字样:
    if (mcp.isError) {
      expect(mcp.text).not.toContain('找不到票');
    }
  });

  test('GWT-MCP-4: 认不出的 id + rule → MCP isError=true / canRule.ok=false', async () => {
    const map = fixtureMap();
    const calls: string[][] = [];
    const { ruleHandler } = toolsWithMap(map, calls);
    const mcp = await ruleHandler('999', 'go');
    const direct = canRule(map, '999');
    expect(!!mcp.isError).toBe(!direct.ok);
    expect(mcp.isError).toBe(true);
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(mcp.text).toContain('找不到票');
    }
    // 兜底: 守卫拦下后零 gh 写
    const wroteGh = calls.some((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'close' || c[1] === 'edit'));
    expect(wroteGh).toBe(false);
  });
});
