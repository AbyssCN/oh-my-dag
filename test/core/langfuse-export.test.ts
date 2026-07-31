/**
 * Langfuse 导出器的行为网 (2026-07-31)。
 *
 * 钉的是**观测层的三条底线**,而不是"我加的字段传对了":
 *
 *   ① **不配就真的什么都不做** —— 这个文件本身是在治「机制在、生产零生效」,
 *      它自己绝不能长成一个"配了才知道没生效"的东西, 所以状态要**说得出原因**。
 *   ② **观测不许拖挂主路径** —— 导出失败时引擎照跑, 且错误不改变语义。
 *   ③ **失败的调用也要记** —— 429/超时正是 prompt 迭代最需要的样本, 而"只记成功"的
 *      观测面永远看不见它们。
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _peekLangfuseQueue,
  _resetLangfuseForTest,
  flushLangfuse,
  langfuseConfigFromEnv,
  langfuseStatus,
  recordGeneration,
  resolveLangfuseConfig,
} from '../../src/model/langfuse';

const ENV = { LANGFUSE_HOST: 'http://nas:3000/', LANGFUSE_PUBLIC_KEY: 'pk-x', LANGFUSE_SECRET_KEY: 'sk-y' };
const rec = (over: Record<string, unknown> = {}) => ({
  traceId: 'run-1',
  name: 'omd-leaf',
  model: 'deepseek:deepseek-v4-flash',
  input: [{ role: 'user', content: '把这一步做了' }],
  output: '做完了',
  startTime: new Date('2026-07-31T00:00:00Z'),
  endTime: new Date('2026-07-31T00:00:02Z'),
  ...over,
});

beforeEach(() => _resetLangfuseForTest());

describe('① 不配 = 真的什么都不做, 且说得出原因', () => {
  test('三个 env 缺任何一个 → 不启用, 且状态里点名缺的是哪个', () => {
    // 用纯 env 解析: 带文件兜底的那个会读到仓里真实的 .omd/config.json (见函数注释)。
    // langfuseStatus 同理会读文件, 所以"点名缺哪个"要在一个没有 .omd 的 cwd 里验 —— 见下一条。
    expect(langfuseConfigFromEnv({})).toBeNull();
    const { LANGFUSE_SECRET_KEY: _drop, ...partial } = ENV;
    expect(langfuseConfigFromEnv(partial)).toBeNull();
  });

  test('★ 都没配时状态**点名缺的是哪个** —— "未启用"三个字不够, 那正是让人配了半天才发现没生效的写法', () => {
    const cwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'omd-nolf2-')));
    try {
      const { LANGFUSE_SECRET_KEY: _drop, ...partial } = ENV;
      expect(langfuseStatus({})).toContain('LANGFUSE_HOST');
      expect(langfuseStatus(partial)).toContain('LANGFUSE_SECRET_KEY');
      expect(langfuseStatus(partial)).not.toContain('LANGFUSE_PUBLIC_KEY');
    } finally {
      process.chdir(cwd);
    }
  });

  test('齐了 → 启用并回显 host (末尾斜杠归一, 免得拼出 //api/…)', () => {
    expect(resolveLangfuseConfig(ENV)?.host).toBe('http://nas:3000');
    expect(langfuseStatus(ENV)).toContain('http://nas:3000');
  });

  test('未配置时 recordGeneration 一个事件都不入队 (主路径零成本)', () => {
    // 造一份"env 与文件都没有"的世界: 换到一个没有 .omd/config.json 的临时 cwd。
    const cwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'omd-nolf-')));
    try {
      recordGeneration(rec(), {});
      expect(_peekLangfuseQueue()).toHaveLength(0);
    } finally {
      process.chdir(cwd);
    }
  });

  test('env 没给但 .omd/config.json 给了 → 也算配上 (daemon 由客户端拉起, 加 env 要动客户端配置)', () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'omd-filelf-'));
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(
      join(dir, '.omd', 'config.json'),
      JSON.stringify({ observability: { langfuse: { host: 'http://nas:3000', publicKey: 'pk-f', secretKey: 'sk-f' } } }),
    );
    process.chdir(dir);
    try {
      expect(resolveLangfuseConfig({})?.publicKey).toBe('pk-f');
      expect(langfuseStatus({})).toContain('.omd/config.json');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('② 攒的批长什么样', () => {
  test('第一次见到一个 traceId → 先发 trace 头, 再发 generation', () => {
    recordGeneration(rec(), ENV);
    const q = _peekLangfuseQueue();
    expect(q.map((e) => e.type)).toEqual(['trace-create', 'generation-create']);
    // 一次 run = 一条 trace = 一个 session: 按 run 看和按 session 看是同一份东西
    expect(q[0]!.body.id).toBe('run-1');
    expect(q[0]!.body.sessionId).toBe('run-1');
    expect(q[1]!.body.traceId).toBe('run-1');
  });

  test('同一条 trace 的第二次调用不再重复发 trace 头', () => {
    recordGeneration(rec(), ENV);
    recordGeneration(rec({ name: 'conductor' }), ENV);
    expect(_peekLangfuseQueue().filter((e) => e.type === 'trace-create')).toHaveLength(1);
  });

  test('prompt 原样进 input —— 接这条线的**目的**就是让它可审查', () => {
    recordGeneration(rec(), ENV);
    const gen = _peekLangfuseQueue()[1]!.body;
    expect(JSON.stringify(gen.input)).toContain('把这一步做了');
  });

  test('usage 三格进 usage, cacheHit 进 metadata (Langfuse 的 usage 只认那三格)', () => {
    recordGeneration(rec({ usage: { in: 100, out: 20, cacheHit: 80 } }), ENV);
    const gen = _peekLangfuseQueue()[1]!.body as { usage: Record<string, unknown>; metadata: Record<string, unknown> };
    expect(gen.usage).toEqual({ input: 100, output: 20, total: 120, unit: 'TOKENS' });
    // 成本账的真源是 cost-ledger, 这里只是把命中数带上去给人看 —— 别塞进 usage 让它去算钱
    expect(gen.metadata.cacheHit).toBe(80);
  });

  test('超大字段截断而不是整批丢 (ingestion 对超大 body 会整批拒)', () => {
    recordGeneration(rec({ output: 'x'.repeat(250_000) }), ENV);
    const out = _peekLangfuseQueue()[1]!.body.output as string;
    expect(out.length).toBeLessThan(120_000);
    expect(out).toContain('truncated');
  });

  test('★ 失败的调用照记, 且带 ERROR 级 —— 只记成功的观测面看不见 429/超时', () => {
    recordGeneration(rec({ error: 'HTTP 429 too many requests', output: '' }), ENV);
    const gen = _peekLangfuseQueue()[1]!.body;
    expect(gen.level).toBe('ERROR');
    expect(gen.statusMessage).toContain('429');
  });
});

describe('③ 观测不许拖挂主路径', () => {
  test('flush 撞网络错 → 不抛 (fail-open), 且队列已清空不会无限积压', async () => {
    recordGeneration(rec(), ENV);
    expect(_peekLangfuseQueue().length).toBeGreaterThan(0);
    // 注入一个必然抛的 fetch —— 判据是"这一句不抛"。
    // ⚠ 第一版拿真地址 127.0.0.1:1 验, 结果用例被网络挂满 5s 拖超时; 那次超时**同时暴露了
    //   导出器自己没设请求超时**(已补 REQUEST_TIMEOUT_MS)。用例改注入是为了让它验的是
    //   fail-open 这条性质本身, 而不是 OS 的连接行为。
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await flushLangfuse(ENV, boom);
    expect(_peekLangfuseQueue()).toHaveLength(0);
  });

  test('服务端 500 → 同样不抛 (吼一次然后继续)', async () => {
    recordGeneration(rec(), ENV);
    const five = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await flushLangfuse(ENV, five);
    expect(_peekLangfuseQueue()).toHaveLength(0);
  });

  test('批体走的是 ingestion 端点 + Basic auth', async () => {
    recordGeneration(rec(), ENV);
    let seenUrl = '';
    let seenAuth = '';
    const spy = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init.headers as Record<string, string>).authorization);
      return new Response('{}', { status: 207 });
    }) as unknown as typeof fetch;
    await flushLangfuse(ENV, spy);
    expect(seenUrl).toBe('http://nas:3000/api/public/ingestion');
    expect(seenAuth).toBe(`Basic ${Buffer.from('pk-x:sk-y').toString('base64')}`);
  });

  test('未配置时 flush 直接返回, 不发任何网络', async () => {
    await flushLangfuse({});
    expect(_peekLangfuseQueue()).toHaveLength(0);
  });
});

describe('④ 观测名要认得出是哪个节点 (第一条真 trace 暴露的)', () => {
  test('★ conductor 与 leaf 不能同名 —— 否则审 prompt 时分不出谁是谁', () => {
    // 第一条真 trace 上两条 generation 都叫 `omd-leaf`: 一条是 conductor (sol 座, in=5799),
    // 一条是干活 leaf (flash 座, in=573)。名字一样 = Langfuse 上看不出谁是谁、更看不出是哪个节点,
    // 而"每个节点的 prompt 可审查"正是接观测的全部目的。
    recordGeneration(rec({ traceId: 'r', name: 'conductor:execute' }), ENV);
    recordGeneration(rec({ traceId: 'r', name: 'leaf:write-a' }), ENV);
    const names = _peekLangfuseQueue().filter((e) => e.type === 'generation-create').map((e) => e.body.name);
    expect(names).toEqual(['conductor:execute', 'leaf:write-a']);
  });

  test('没给名字时回落通用名 (零回归) —— 观测名只进观测, 不进 prompt', () => {
    recordGeneration(rec({ name: 'omd-leaf' }), ENV);
    expect(_peekLangfuseQueue()[1]!.body.name).toBe('omd-leaf');
  });
});

describe('⑤ trace 名 = 这一跑在干什么 (不是常量)', () => {
  test('第一条 generation 的 traceLabel 定 trace 名', () => {
    recordGeneration(rec({ traceId: 't1', traceLabel: '把两份摘要写出来' }), ENV);
    expect(_peekLangfuseQueue()[0]!.body.name).toBe('把两份摘要写出来');
  });

  test('★ 之后的调用改不了它 —— trace 头只发一次, 否则同一跑会有两个名字', () => {
    recordGeneration(rec({ traceId: 't2', traceLabel: '第一次说的' }), ENV);
    recordGeneration(rec({ traceId: 't2', traceLabel: '后来改口' }), ENV);
    const heads = _peekLangfuseQueue().filter((e) => e.type === 'trace-create');
    expect(heads).toHaveLength(1);
    expect(heads[0]!.body.name).toBe('第一次说的');
  });

  test('没给 → 回落 omd-run (零回归)', () => {
    recordGeneration(rec({ traceId: 't3' }), ENV);
    expect(_peekLangfuseQueue()[0]!.body.name).toBe('omd-run');
  });

  test('超长目标截断 —— 列表页放不下, 而整批被拒比截断坏', () => {
    recordGeneration(rec({ traceId: 't4', traceLabel: 'x'.repeat(500) }), ENV);
    expect((_peekLangfuseQueue()[0]!.body.name as string).length).toBe(120);
  });
});
