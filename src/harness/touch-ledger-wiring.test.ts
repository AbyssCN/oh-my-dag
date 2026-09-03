/**
 * #262 —— 碰撞台账在 **agent 工具面** 这条生产链上的接线闸。
 *
 * ## 它守的是一个已经量到的洞
 *
 * `omd touches` 的库级自述(#253 收尾 commit 0285cce9 引入的 `stats()`)第一次真跑就抓到:
 *
 * ```
 * ledger: rows=2924 · source strict=0/inferred=0/cli=2924
 * ```
 *
 * **strict 与 inferred 双零** —— 主树这本库 100% 来自 `omd touch` CLI(hook 链路),
 * agent 自己经 `write` / `edit` / bash 写嗅探碰的文件**一条都没进来**。
 * 而 `findings()` 有 140 条(全 cli 档),**看起来台账很健康** ——
 * 证据档位分列(strict/inferred/cli 三列不合并)是唯一能让「一档满、另两档空」显形的东西。
 *
 * ## 根因不在 assemble,在这一行的**门**上
 *
 * 链路每一环都早就写好了:
 * - `dag/engine.ts:3777` 按调用发 `touchSession: `<runId>:<nodeId>``(lister 在 :3031);
 * - `agent-leaf.ts` 的 `touchSessionStore`(AsyncLocalStorage)按调用接住它;
 * - `agent-tools.ts` 的 `touchWrite` 拿 getter 取 session,**`undefined` 就不记**;
 * - `openTouchLedger` 自己按 cwd 建 `<cwd>/.omd/touch.db`。
 *
 * 断的只有一处:`agent-leaf.ts` 那行 `...(touchOpt ? { touch: … } : {})` 把**按调用**的
 * 特性锁在了**装配期**选项后面。生产装配(`src/mcp/assemble.ts` 两处 `createAgentLeafRunner`)
 * 从不传 `opts.touch`,于是 getter 根本没装上,引擎按调用发的 session 无处可落。
 *
 * ⚠ 修法**不是**在 assemble 里塞一个装配期常量 session:引擎的 per-call 值才是真源
 * (`<runId>:<nodeId>`),装配期常量只会在引擎没给 session 时把所有触碰打上同一个假标签。
 * 正确的修法是拆掉那道门 + 让库**懒开**(有 session 才开库,没有则连文件都不建)。
 *
 * ## 反向自检(实测过,见提交说明)
 *
 * - 把 `agent-leaf.ts` 的门装回去(`touchOpt ? … : {}`)⇒ ★① ★② 红;
 * - 把库改回**急开**(装配即 `openTouchLedger`)⇒ ★③ 红(没 session 的 cwd 也会长出 touch.db)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runExecutorDag } from '../../test/helpers/legacy-plan-entry';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';
import { createAgentLeafRunner } from './agent-leaf';
import { CheckpointManager } from './continuity/checkpoint-manager';

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

/** 拿 runner 装配好的 omd 桥, 经 InMemory 真 Client 驱一段脚本 —— 工具面走的是生产闭包里的真件。 */
function driveBridge(opts: Options, script: (client: Client) => Promise<void>): AsyncIterable<SDKMessage> {
  return (async function* () {
    const inst = (opts.mcpServers as unknown as Record<string, { instance: McpServer }>).omd!.instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'touch-wiring', version: '0' });
    await Promise.all([inst.server.connect(a), client.connect(b)]);
    await script(client);
    await client.close();
    yield asst('写完了');
    yield success();
  })();
}

const tmpCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-touch-wiring-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  return cwd;
};

/** 直接读盘上的 touch.db —— 断言的是**真源**, 不是任何内存替身。 */
const rowsOf = (cwd: string): { abs_path: string; session: string; op: string; source: string }[] => {
  const p = join(cwd, '.omd', 'touch.db');
  if (!existsSync(p)) return [];
  const db = new Database(p, { readonly: true });
  try {
    return db.query('SELECT abs_path, session, op, source FROM touches').all() as never;
  } finally {
    db.close();
  }
};

const PLAN = JSON.stringify({
  name: 'p',
  nodes: { w: { goal: '写一个文件', executor: 'agent', output_path: 'out.txt' } },
});

function makeConfig(cwd: string, generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    agentLeafModel: MODEL,
    generate,
    continuity: { manager: new CheckpointManager(cwd), runId: 'RUN1', repoRoot: cwd },
    ...extra,
  };
}

describe('#262 碰撞台账 agent 工具面接线 (生产链: engine touchSession → leaf ALS → agent-tools → touch.db)', () => {
  test('★① write 工具的触碰落进 <cwd>/.omd/touch.db, source=strict, session 由引擎按调用给', async () => {
    const cwd = tmpCwd();
    // 生产形状: **不传** opts.touch —— assemble.ts 两处 createAgentLeafRunner 就是这么调的。
    const leaf = createAgentLeafRunner({
      cwd,
      sdkQueryFn: (props) =>
        driveBridge(props.options, async (client) => {
          await client.callTool({ name: 'write', arguments: { path: 'out.txt', content: 'hello' } });
        }),
    });
    const conductor: GenerateFn = async () => ({ text: PLAN, usage: { in: 1, out: 1 } });
    const r = await runExecutorDag('写文件', makeConfig(cwd, conductor, { agentRunner: leaf }));
    expect(r.results.w!.status).toBe('done');
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('hello');

    const rows = rowsOf(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('strict');   // ← 这一档在生产上此前恒空 (实测 strict=0)
    expect(rows[0]!.op).toBe('write');
    expect(rows[0]!.abs_path).toBe(join(cwd, 'out.txt'));
    // session 是**引擎按调用算的** `<runId>:<nodeId>`, 不是装配期常量。
    expect(rows[0]!.session).toBe('RUN1:w');
  });

  test('★② 同一 run 的两个节点写同一文件 → 两行两 session, 碰撞发现读得出来', async () => {
    const cwd = tmpCwd();
    const leaf = createAgentLeafRunner({
      cwd,
      sdkQueryFn: (props) =>
        driveBridge(props.options, async (client) => {
          // 2026-09-01 版本守卫上线之后, 「整体覆写一份本次调用没读过的已存在文件」会被当场拒 ——
          // 而节点 b 覆写的正是 a 的产物, 这个 fixture 撞的就是那一格。先 read 再 write 是判词点名
          // 的那条路, 也是真 leaf 会走的路。a 那一跑文件还不存在, read 会失败 → 吞掉 (那一跑是新建)。
          // ⚠ read 不进台账 (只有写侧记), 所以下面的行数判据一个字都不用改。
          await client.callTool({ name: 'read', arguments: { path: 'shared.txt' } }).catch(() => undefined);
          await client.callTool({ name: 'write', arguments: { path: 'shared.txt', content: 'x' } });
        }),
    });
    const plan = JSON.stringify({
      name: 'p',
      nodes: {
        a: { goal: '写', executor: 'agent', output_path: 'shared.txt' },
        b: { goal: '也写', executor: 'agent', output_path: 'shared.txt', depends_on: ['a'] },
      },
    });
    const conductor: GenerateFn = async () => ({ text: plan, usage: { in: 1, out: 1 } });
    await runExecutorDag('两个都写', makeConfig(cwd, conductor, { agentRunner: leaf }));

    const rows = rowsOf(cwd).filter((x) => x.abs_path.endsWith('shared.txt'));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.session))).toEqual(new Set(['RUN1:a', 'RUN1:b']));
    expect(rows.every((x) => x.source === 'strict')).toBe(true);
  });

  test('★③ 没有 session → 连 touch.db 都不建 (懒开; 缺席 ≠ 空库, 也不给每个 cwd 撒文件)', async () => {
    const cwd = tmpCwd();
    const leaf = createAgentLeafRunner({
      cwd,
      sdkQueryFn: (props) =>
        driveBridge(props.options, async (client) => {
          await client.callTool({ name: 'write', arguments: { path: 'lonely.txt', content: 'x' } });
        }),
    });
    // 直调 leaf, **不经引擎** ⇒ 没有 touchSession。文件照写, 台账不开。
    await leaf({ prompt: '写', model: MODEL });
    expect(readFileSync(join(cwd, 'lonely.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(cwd, '.omd', 'touch.db'))).toBe(false);
  });
});
