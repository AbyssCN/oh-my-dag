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
import { invocationFactsFor, renderInvocationFacts } from './invocation-facts';

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
