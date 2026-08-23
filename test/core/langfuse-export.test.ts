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
import { join, sep } from 'node:path';
import {
  _peekLangfuseQueue,
  _resetLangfuseForTest,
  flushLangfuse,
  langfuseConfigFromEnv,
  langfuseStatus,
  omdSecretsPath,
  promptVersionOf,
  recordGeneration,
  recordSpan,
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

/**
 * 造一个**没有凭证**的世界。
 *
 * 从 chdir 换成注入 `XDG_CONFIG_HOME` 是跟着落点搬家走的:密钥搬出仓树后,"这台机器配没配"
 * 不再由 cwd 决定而由 config home 决定 —— 而真机上 `~/.config/omd/secrets.json` **是存在的**,
 * 传 `{}` 会读到它,于是"不配 = 什么都不做"这条用例在开发机上必红、在 CI 上必绿。
 * (本轮实测:搬家后这三条当场变红,正是这个原因。)
 */
const noCreds = (): Record<string, string> => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'omd-nolf-')) });

/** 造一个只含 `omd/secrets.json` 的假 config home。 */
const withRawSecrets = (raw: string): Record<string, string> => {
  const root = mkdtempSync(join(tmpdir(), 'omd-lf-'));
  mkdirSync(join(root, 'omd'), { recursive: true });
  writeFileSync(join(root, 'omd', 'secrets.json'), raw);
  return { XDG_CONFIG_HOME: root };
};
const withCreds = (langfuse: Record<string, string>): Record<string, string> =>
  withRawSecrets(JSON.stringify({ langfuse }));

beforeEach(() => _resetLangfuseForTest());

describe('① 不配 = 真的什么都不做, 且说得出原因', () => {
  test('三个 env 缺任何一个 → 不启用, 且状态里点名缺的是哪个', () => {
    // 用纯 env 解析: 带文件兜底的那个会读到真机上的凭证文件 (见函数注释)。
    // langfuseStatus 同理会读文件, 所以"点名缺哪个"要在一个空的 config home 里验 —— 见下一条。
    expect(langfuseConfigFromEnv({})).toBeNull();
    const { LANGFUSE_SECRET_KEY: _drop, ...partial } = ENV;
    expect(langfuseConfigFromEnv(partial)).toBeNull();
  });

  test('★ 都没配时状态**点名缺的是哪个** —— "未启用"三个字不够, 那正是让人配了半天才发现没生效的写法', () => {
    const { LANGFUSE_SECRET_KEY: _drop, ...partial } = ENV;
    expect(langfuseStatus(noCreds())).toContain('LANGFUSE_HOST');
    expect(langfuseStatus({ ...noCreds(), ...partial })).toContain('LANGFUSE_SECRET_KEY');
    expect(langfuseStatus({ ...noCreds(), ...partial })).not.toContain('LANGFUSE_PUBLIC_KEY');
  });

  test('齐了 → 启用并回显 host (末尾斜杠归一, 免得拼出 //api/…)', () => {
    expect(resolveLangfuseConfig(ENV)?.host).toBe('http://nas:3000');
    expect(langfuseStatus(ENV)).toContain('http://nas:3000');
  });

  test('未配置时 recordGeneration 一个事件都不入队 (主路径零成本)', () => {
    recordGeneration(rec(), noCreds());
    expect(_peekLangfuseQueue()).toHaveLength(0);
  });

  test('env 没给但凭证文件给了 → 也算配上 (daemon 由客户端拉起, 加 env 要动客户端配置)', () => {
    const env = withCreds({ host: 'http://nas:3000', publicKey: 'pk-f', secretKey: 'sk-f' });
    expect(resolveLangfuseConfig(env)?.publicKey).toBe('pk-f');
    expect(langfuseStatus(env)).toContain('secrets.json');
  });

  test('文件缺字段 / 不是 JSON → 当没配, 不抛 (观测层不许因配置面残缺而炸主路径)', () => {
    expect(resolveLangfuseConfig(withCreds({ host: 'http://nas:3000' }))).toBeNull();
    expect(resolveLangfuseConfig(withRawSecrets('}{ 不是 json'))).toBeNull();
  });
});

describe('①.5 凭证落点 —— 密钥不在仓树里 (2026-07-31 搬家)', () => {
  test('落点 = $XDG_CONFIG_HOME/omd/secrets.json, 缺省 ~/.config/omd/secrets.json', () => {
    expect(omdSecretsPath({ XDG_CONFIG_HOME: '/x/cfg' })).toBe('/x/cfg/omd/secrets.json');
    expect(omdSecretsPath({ HOME: '/home/someone' })).toBe('/home/someone/.config/omd/secrets.json');
  });

  test('★ 落点不在工作树内 —— 这是搬家的**全部**理由: command leaf 收了 cat/grep/jq, 仓树里的密钥它够得着', () => {
    const p = omdSecretsPath({ HOME: '/home/someone' });
    expect(p.startsWith(process.cwd())).toBe(false);
    expect(p).not.toContain(`${sep}.omd${sep}`);
  });

  test('env 恒压过文件 (两级不是两个真源)', () => {
    const env = { ...withCreds({ host: 'http://from-file:3000', publicKey: 'pk-f', secretKey: 'sk-f' }), ...ENV };
    expect(resolveLangfuseConfig(env)?.publicKey).toBe('pk-x');
  });

  test('env 只给一半 ≠ 半开 —— 三件套不齐就整体落文件', () => {
    const env = { ...withCreds({ host: 'http://nas:3000', publicKey: 'pk-f', secretKey: 'sk-f' }), LANGFUSE_HOST: 'http://half:3000' };
    expect(resolveLangfuseConfig(env)?.host).toBe('http://nas:3000');
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

describe('⑥ 观测面不许有匿名调用 (结构性守卫)', () => {
  test('★ 每一处 generate 调用都报了名 —— 匿名那发一定是最难解释的那发', async () => {
    // 这条是**源码级**守卫, 不是行为断言。理由: 重启后第一跑里两条最贵的调用叫 `omd-leaf`,
    // 查下去发现既不是 leaf 也不是 conductor, 是 fan-in 摘要 —— 而按名字看它会被误读成
    // "某个 leaf 很贵"。观测面上一个匿名的格, 就是一条以后一定会被读错的账。
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
      });
    const offenders: string[] = [];
    for (const file of walk('src/harness')) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((ln, i) => {
        if (!/generate\(\{/.test(ln)) return;
        // 调用块往后 15 行里必须出现 traceName
        if (!lines.slice(i, i + 15).some((x) => x.includes('traceName'))) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('⑦ 父子结构 + prompt 版本身份', () => {
  test('★ 节点 span 与它的 generation 用**同一个确定性 id** 对上 —— parent id 不用传, 但"属于哪个节点"要传', () => {
    recordSpan({ traceId: 'r', nodeId: 'execute', kind: 'conductor', status: 'done', startTime: new Date(0), endTime: new Date(1) }, ENV);
    recordGeneration(rec({ traceId: 'r', name: 'conductor:execute', nodeId: 'execute' }), ENV);
    const q = _peekLangfuseQueue();
    const span = q.find((e) => e.type === 'span-create')!.body;
    const gen = q.find((e) => e.type === 'generation-create')!.body;
    // 子调用挂在本节点的 span 上。两边各算一遍 hash(traceId+nodeId), 必然相等 ——
    // 这就是不用把 parentObservationId 穿过五六层函数签名的理由。传的只是 nodeId 本身。
    expect(gen.parentObservationId).toBe(span.id);
  });

  test('★ run 级调用挂 trace 根 —— 不给 nodeId 就不许凭空造一个父 (2026-07-31 live 抓到的孤儿)', () => {
    // 此前 parent 是从**名字**里切出来的: `<相位>:<后缀>` 一律把后缀当节点 id。
    // 于是 `conductor:plan` 被凑了个叫 `plan` 的父 —— 而 `plan` 不是节点, 那个 span 从未发出过,
    // live trace 上就是一条父指向虚空的孤儿。而 `conductor:<nodeId>` (子图展开) 与它**字符串同形**,
    // 区分二者的信息只存在于调用点 —— 所以现在由调用点给 nodeId, 不给就是 run 级。
    recordGeneration(rec({ traceId: 'r', name: 'conductor:plan' }), ENV);
    recordGeneration(rec({ traceId: 'r', name: 'classify:acceptance' }), ENV);
    recordGeneration(rec({ traceId: 'r', name: 'halt-judge' }), ENV);
    for (const e of _peekLangfuseQueue().filter((x) => x.type === 'generation-create')) {
      expect(e.body.parentObservationId).toBeUndefined();
    }
  });

  test('子节点 id 里的 `父::子` 就是父子关系 —— 不需要另外记账 (D-B 内容寻址)', () => {
    recordSpan({ traceId: 'r', nodeId: 'P::write-a', kind: 'inproc', status: 'done', startTime: new Date(0), endTime: new Date(1) }, ENV);
    recordSpan({ traceId: 'r', nodeId: 'P', kind: 'conductor', status: 'done', startTime: new Date(0), endTime: new Date(2) }, ENV);
    const spans = _peekLangfuseQueue().filter((e) => e.type === 'span-create').map((e) => e.body);
    const child = spans.find((b) => (b.name as string).endsWith('P::write-a'))!;
    const parent = spans.find((b) => b.name === 'conductor:P')!;
    expect(child.parentObservationId).toBe(parent.id);
    expect(parent.parentObservationId).toBeUndefined(); // 顶层节点挂 trace 根
  });

  test('command 节点也发 span —— 它不打模型, 此前在观测面上完全不存在', () => {
    recordSpan({ traceId: 'r', nodeId: 'accept', kind: 'command', status: 'failed', startTime: new Date(0), endTime: new Date(1), failureKind: 'assert-failed' }, ENV);
    const b = _peekLangfuseQueue().find((e) => e.type === 'span-create')!.body;
    expect(b.name).toBe('command:accept');
    expect(b.level).toBe('WARNING');
    expect(b.statusMessage).toBe('assert-failed');
  });

  test('★ prompt 版本身份进 metadata, 而 prompt 的真源仍在 git', () => {
    const v1 = promptVersionOf([{ role: 'system', content: '冻结前缀 A' }, { role: 'user', content: '这次的目标' }]);
    const v2 = promptVersionOf([{ role: 'system', content: '冻结前缀 A' }, { role: 'user', content: '换一个目标' }]);
    const v3 = promptVersionOf([{ role: 'system', content: '冻结前缀 B' }, { role: 'user', content: '这次的目标' }]);
    // 只认 system 段: 每次任务不同的 user 段不该让版本号变 —— 否则"同一版跑了 200 次"永远凑不齐
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
  });

  test('版本身份与 engineCommit 一起进 metadata (两者一起才定得住是哪一版跑的)', () => {
    recordGeneration(rec({ promptVersion: 'abc123' }), ENV);
    const md = _peekLangfuseQueue()[1]!.body.metadata as Record<string, string>;
    expect(md.promptVersion).toBe('abc123');
    expect(typeof md.engineCommit).toBe('string');
  });
});

/**
 * **观测层永不带走执行层** (2026-08-01, 一次 574KB diff 审查当场触发)。
 *
 * `clipDeep` 老写法是 `JSON.parse(clip(JSON.stringify(v)))` —— 先序列化、**截断**、再 parse
 * 那截断过的串。截断过的 JSON 几乎必然非法, 于是它对任何超过 MAX_FIELD_CHARS 的输入
 * **按构造必崩** (`SyntaxError: Unterminated string`), 只是此前输入都小, 一直没撞上。
 *
 * 更坏的是崩的位置: `gateway.send` 的 **catch 块**里也记一发 (失败的调用比成功的更值得看),
 * 于是这个异常**顶掉了原始错误** —— 看到的是观测层的 JSON 报错, 真正的失败原因一个字都没露面。
 * 这也是为什么闸立在 `recordGeneration`/`recordSpan` 自己身上而不是四个调用点上:
 * 其中一个调用点在 catch 里, 那儿抛出去的代价与别处不同, 而"每个调用点都记得包"正是会漏的那种约定。
 */
describe('⑦ 观测记录不许抛 (fail-open)', () => {
  const huge = 'x'.repeat(600_000);

  test('超大输入不抛 —— truncate-then-parse 的回归', () => {
    expect(() =>
      recordGeneration(rec({ input: [{ role: 'user', content: huge }], output: huge }), ENV),
    ).not.toThrow();
  });

  test('超大**结构化**输入(非字符串)同样不抛 —— 崩点原本就在这条路上', () => {
    const bigStruct = { messages: Array.from({ length: 400 }, (_, i) => ({ role: 'user', content: `${i}:${'y'.repeat(2000)}` })) };
    expect(() => recordGeneration(rec({ input: bigStruct }), ENV)).not.toThrow();
  });

  test('序列化不了的输入(循环引用)不抛', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => recordGeneration(rec({ input: cyc }), ENV)).not.toThrow();
  });

  test('没超限的结构原样保留 (裁剪不该顺手把小输入也拍平成字符串)', () => {
    // 经 batch 出口观察: 小输入的 input 仍是数组, 不是被 JSON 串替换掉的字符串。
    recordGeneration(rec(), ENV);
    const gen = _peekLangfuseQueue()[1]!.body as { input?: unknown };
    expect(Array.isArray(gen.input)).toBe(true);
  });

  test('recordSpan 同样不抛 —— 它的调用点在 settle 里, 抛了会整张图 reject', () => {
    expect(() =>
      recordSpan({ traceId: 'run-1', nodeId: 'n1', kind: 'command', status: 'done', startTime: new Date(), endTime: new Date() }, ENV),
    ).not.toThrow();
  });
});
