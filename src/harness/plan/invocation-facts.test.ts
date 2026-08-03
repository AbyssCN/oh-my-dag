/**
 * invocation-facts 的可执行契约 —— 零 LLM,真临时目录(它读的就是盘)。
 *
 * 盯三条,每一条都对应一个**会静默出错**的失手:
 * ① **空 ≠ 没扫** —— 没找到调用方时必须说清"查过哪几处",否则读者会把"没扫"读成"确认无人调用",
 *    而这两件事对判断的含义相反。
 * ② **不猜** —— 注释掉的 cron 行不算。静态检查一旦开始猜就变成了第三个 judge,而且没有证据。
 * ③ **渲染不下结论** —— 措辞里出现"可逆/不可逆/该停"就等于把标签写进模型的输入,
 *    那样量到的是提示强度而不是证据效力(同 `blocking-forks.test.ts` 的防泄题闸)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invocationFactsFor, renderInvocationFacts, scheduledArtifactFindings } from './invocation-facts';

const world = (files: Record<string, string>): { cwd: string; done: () => void } => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-invfacts-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return { cwd, done: () => rmSync(cwd, { recursive: true, force: true }) };
};

describe('invocation-facts', () => {
  test('package.json scripts 里出现 → 报 package-script, 带可核的位置', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun run scripts/nightly-digest.ts' } }),
    });
    const f = invocationFactsFor(cwd, 'scripts/nightly-digest.ts');
    expect(f.invokers).toEqual([{ kind: 'package-script', where: 'package.json:scripts.digest' }]);
    done();
  });

  test('CI workflow 里出现 → 报 ci-workflow', () => {
    const { cwd, done } = world({
      '.github/workflows/nightly.yml': 'jobs:\n  run:\n    steps:\n      - run: bun scripts/nightly-digest.ts\n',
    });
    expect(invocationFactsFor(cwd, 'scripts/nightly-digest.ts').invokers).toEqual([
      { kind: 'ci-workflow', where: '.github/workflows/nightly.yml' },
    ]);
    done();
  });

  test('声明段覆盖扫描器看不见的那一半 (生产 crontab 不在仓里)', () => {
    const { cwd, done } = world({
      '.omd/config.json': JSON.stringify({ invokedBy: { 'scripts/nightly-digest.ts': '生产 crontab 每晚 02:00' } }),
    });
    const f = invocationFactsFor(cwd, 'scripts/nightly-digest.ts');
    expect(f.invokers).toHaveLength(1);
    expect(f.invokers[0]!.kind).toBe('declared');
    expect(f.invokers[0]!.where).toContain('生产 crontab');
    done();
  });

  test('声明按**前缀**匹配 (一条声明覆盖一整个目录)', () => {
    const { cwd, done } = world({ '.omd/config.json': JSON.stringify({ invokedBy: { 'ops/': '部署流水线' } }) });
    expect(invocationFactsFor(cwd, 'ops/migrate.ts').invokers).toHaveLength(1);
    expect(invocationFactsFor(cwd, 'src/migrate.ts').invokers).toHaveLength(0);
    done();
  });

  /** ② 不猜: 注释掉的行不是配置。 */
  test('注释掉的 cron 行**不算** —— 静态检查开始猜就成了没证据的第三个 judge', () => {
    const { cwd, done } = world({ crontab: '# 0 2 * * * bun scripts/nightly-digest.ts\n' });
    const f = invocationFactsFor(cwd, 'scripts/nightly-digest.ts');
    expect(f.invokers).toEqual([]);
    expect(f.sources).toContain('crontab'); // 但**查过**这一处 —— 这正是 ① 要留住的信息
    done();
  });

  /** ① 空 ≠ 没扫: 两种"空"必须读得出区别。 */
  test('查过没找到 vs 根本没查 —— 渲染出来必须是两句不同的话', () => {
    const scanned = world({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
    const scannedText = renderInvocationFacts(invocationFactsFor(scanned.cwd, 'scripts/x.ts'));
    expect(scannedText).toContain('未发现');
    expect(scannedText).toContain('package.json'); // 说清查过哪
    scanned.done();

    const empty = world({});
    const emptyText = renderInvocationFacts(invocationFactsFor(empty.cwd, 'scripts/x.ts'));
    expect(emptyText).toContain('未能查询');
    expect(emptyText).not.toContain('未发现'); // 没查过绝不能说成"没找到"
    empty.done();
  });

  test('多来源并存 → 全部报出来 (谁都可能是那条决定性的)', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun scripts/nightly-digest.ts' } }),
      '.omd/config.json': JSON.stringify({ invokedBy: { 'scripts/nightly-digest.ts': '生产 crontab' } }),
    });
    const kinds = invocationFactsFor(cwd, 'scripts/nightly-digest.ts').invokers.map((i) => i.kind);
    expect(kinds).toContain('package-script');
    expect(kinds).toContain('declared');
    done();
  });

  /** ③ 渲染出来的句子会直接进模型输入 —— 出现结论词就等于把答案写进去了。 */
  test('渲染文本不含任何结论词 (防泄题, 同 blocking-forks 那条闸)', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun scripts/nightly-digest.ts' } }),
    });
    const text = renderInvocationFacts(invocationFactsFor(cwd, 'scripts/nightly-digest.ts'));
    for (const w of ['可逆', '不可逆', '红线', '该停', '等人', '危险']) expect(text).not.toContain(w);
    done();
  });

  test('反向自检: 路径不匹配时**不报** (闸不是恒真式)', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun scripts/other.ts' } }),
    });
    expect(invocationFactsFor(cwd, 'scripts/nightly-digest.ts').invokers).toEqual([]);
    done();
  });

  test('坏 JSON / 缺文件都不抛 —— 采证据的件绝不能把一次真跑炸掉', () => {
    const { cwd, done } = world({ 'package.json': '{ 坏', '.omd/config.json': 'nope' });
    expect(() => invocationFactsFor(cwd, 'x.ts')).not.toThrow();
    expect(invocationFactsFor(cwd, 'x.ts').invokers).toEqual([]);
    done();
  });
});

describe('scheduledArtifactFindings (plan 级)', () => {
  const planOf = (nodes: Record<string, unknown>): never => ({ name: 'p', nodes }) as never;

  test('要改的文件有调用方 → 报; 没有 → 不报 (未发现不进观察, 免得噪声淹掉真信号)', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun scripts/nightly-digest.ts' } }),
    });
    const found = scheduledArtifactFindings(
      planOf({
        risky: { goal: '改默认收件范围', output_path: 'scripts/nightly-digest.ts' },
        safe: { goal: '改内部工具', output_path: 'src/util.ts' },
      }),
      cwd,
    );
    expect(found.map((f) => f.nodes[0])).toEqual(['risky']); // safe 那条一个字都不该出现
    expect(found[0]!.kind).toBe('scheduled-artifact');
    expect(found[0]!.message).toContain('package.json:scripts.digest');
    done();
  });

  test('消息不含结论词 —— 它会进下一轮 conductor 的 prompt, 下结论等于替它判了', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { d: 'bun scripts/x.ts' } }),
    });
    const [f] = scheduledArtifactFindings(planOf({ n: { goal: 'g', output_path: 'scripts/x.ts' } }), cwd);
    for (const w of ['可逆', '不可逆', '红线', '该停', '必须问']) expect(f!.message).not.toContain(w);
    done();
  });

  test('反向自检: 没有任何节点声明写目标 → 空 (闸不是恒真式)', () => {
    const { cwd, done } = world({ 'package.json': JSON.stringify({ scripts: { d: 'bun scripts/x.ts' } }) });
    expect(scheduledArtifactFindings(planOf({ n: { goal: '只读活' } }), cwd)).toEqual([]);
    done();
  });
});

describe('间接可达 (import 图一跳到直接命名点)', () => {
  /**
   * 这一层的存在有读数背书, 不是想当然: `indirect` 档实验里只给直接命名事实的 weak 臂
   * 在间接红线上**漏标 100%** (0/3, 0/3), 而给完整链的 on 臂 100% 修好 ——
   * 信息够用, 缺的就是这一跳。
   */
  test('目标没被逐字提到, 但调度入口经 import 到得了它 → 报 import-chain', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { digest: 'bun scripts/digest.ts' } }),
      'scripts/digest.ts': "import { send } from '../src/mailer';\nsend();\n",
      'src/mailer.ts': 'export const send = () => {};\n',
    });
    const f = invocationFactsFor(cwd, 'src/mailer.ts');
    expect(f.invokers.map((i) => i.kind)).toEqual(['import-chain']);
    expect(f.invokers[0]!.where).toContain('scripts/digest.ts');
    done();
  });

  test('直接命中时**不走图** —— 直接证据更强, 且省一次 BFS', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { d: 'bun scripts/digest.ts' } }),
      'scripts/digest.ts': 'export const x = 1;\n',
    });
    expect(invocationFactsFor(cwd, 'scripts/digest.ts').invokers.map((i) => i.kind)).toEqual(['package-script']);
    done();
  });

  test('反向自检: 图上到不了 → 仍是"未发现" (这一层不许把所有文件都算成可达)', () => {
    const { cwd, done } = world({
      'package.json': JSON.stringify({ scripts: { d: 'bun scripts/digest.ts' } }),
      'scripts/digest.ts': 'export const x = 1;\n',
      'src/lonely.ts': 'export const y = 2;\n',
    });
    const f = invocationFactsFor(cwd, 'src/lonely.ts');
    expect(f.invokers).toEqual([]);
    expect(f.sources.some((x) => x.includes('import 图'))).toBe(true); // 但**查过**这一层
    done();
  });

  test('链多时截断到 3 条 + 报个数 (它进 prompt, 列一长串会把真信号淹掉)', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`s${i}`, `bun scripts/e${i}.ts`])) }),
      'src/shared.ts': 'export const s = 1;\n',
    };
    for (const i of [1, 2, 3, 4, 5]) files[`scripts/e${i}.ts`] = "import { s } from '../src/shared';\n";
    const { cwd, done } = world(files);
    const text = renderInvocationFacts(invocationFactsFor(cwd, 'src/shared.ts'));
    expect(text).toContain('另有 2 处同类');
    done();
  });
});
