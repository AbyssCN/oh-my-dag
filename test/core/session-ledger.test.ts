/**
 * W2→W1 ledger 写者测试切片 (SDD 契约 S1 · `src/harness/session/ledger.ts`)。
 *
 * 契约面:
 * - serializer(I-5): `tokenBucket` → 行字段 `ctxTokens` 的映射**只发生在本模块**;
 *   tokenBucket null 原样透传(不伪造数),W1 侧 `typeof j.ctxTokens === 'number'` 判定行自会跳过。
 * - ledger.jsonl append 写者五项契约: append(只增不覆写) / offset(跨调用去重) /
 *   lock(独占锁文件) / owner(每行写者标识) / path(与 writer.ts:351,367 尾读逐字对齐)。
 * - 全程 fail-open: 状态未知(坏行/锁超时/entries 回退)一律 { ok:false, error }, 不抛、不追加。
 * - 消费契约: 尾读语义 = writer.ts:277-289 `latestCtxTokens`(末行起逆扫, 只认 number)。
 *
 * 路径隔离: OMD_DATA_HOME 指向临时 base(先例: hud-integration / map-runtime 等 save/restore 模式),
 * cwd 用临时非 git 目录 → resolveProject 退 cwd basename slug, 不碰仓内 .omd/;
 * 每测试独立 sessionId(同 hook 测试 txSeq 模式)—— ledger 按 session 分区, 共享 id 会串状态。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseStopLedger, type StopLedger } from '../../src/harness/session/stop-ledger';
import { appendLedger, serializeLedger, LEDGER_OWNER_W2 } from '../../src/harness/session/ledger';
import { resolveProject, slugifyProject } from '../../src/harness/project-scope';

const tmpRoot = mkdtempSync(join(tmpdir(), 'omd-ledger-slice-'));
const dataHome = join(tmpRoot, 'data-home');
const projectDir = join(tmpRoot, 'proj-a');

const savedHome = process.env.OMD_DATA_HOME;
beforeEach(() => {
  process.env.OMD_DATA_HOME = dataHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.OMD_DATA_HOME;
  else process.env.OMD_DATA_HOME = savedHome;
});

let sessionSeq = 0;
/** 每测试独立 session 分区(同 hook 测试 txSeq 模式, 防跨测试串状态)。 */
function nextSession(): string {
  sessionSeq += 1;
  return `sess-${sessionSeq}`;
}

/** 冻结 usage 四键形状(E-P1): tokenBucket = input + cache_read + cache_creation, output 不计。 */
function usageTokens(sum: number): Record<string, number> {
  return { input_tokens: 1, cache_read_input_tokens: sum - 4, cache_creation_input_tokens: 3, output_tokens: 7 };
}

function assistantLine(text: string, usage?: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage });
}

/** 合成 W3 产物(与 W3/W2 切片同源)。 */
function ledgerOf(...lines: string[]): StopLedger {
  const res = parseStopLedger(lines.join('\n'));
  if (!res.ok) throw new Error(`synthetic ledger 解析失败 (line ${res.error.line}): ${res.error.message}`);
  return res.ledger;
}

/** W1 消费判定(逐字复制 writer.ts:278-289 语义, 证明 serializer 产出被认读)。 */
function latestCtxTokens(tail: string): number | null {
  const lines = tail.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as { ctxTokens?: unknown };
      if (typeof j?.ctxTokens === 'number') return j.ctxTokens;
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

const FIXED_NOW = () => 1_752_000_000_000;
const FIXED_TS = new Date(FIXED_NOW()).toISOString();

/**
 * 与 writer.ts:351,367 对齐的期望落盘路径。
 * 注意 resolve 语义(writer.ts:351 同款): dataPath 已是绝对路径, resolve 下后者胜出。
 */
function expectedLedgerPath(sessionId: string): string {
  const scope = resolveProject(projectDir);
  return resolve(scope.rootPath, scope.dataPath(join('session', sessionId, 'ledger.jsonl')));
}

describe('serializer(I-5): tokenBucket → ctxTokens 映射只发生在这里', () => {
  test('number tokenBucket → 行字段 ctxTokens 为 number;一行一条 entry', () => {
    const ledger = ledgerOf(
      assistantLine('轮1', usageTokens(226451)),
      assistantLine('轮2', usageTokens(190189)),
    );
    const lines = serializeLedger(ledger, { now: FIXED_NOW });
    expect(lines).toHaveLength(2);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row.ordinal).toBe(1);
    expect(row.ctxTokens).toBe(226451);
    expect(typeof row.ctxTokens).toBe('number'); // writer.ts:282-283 判定字面
    expect(row.owner).toBe(LEDGER_OWNER_W2);
    expect(row.ts).toBe(FIXED_TS);
    expect(JSON.parse(lines[1]!) as Record<string, unknown>).toMatchObject({ ordinal: 2, ctxTokens: 190189 });
  });

  test('tokenBucket null → ctxTokens null 原样透传(不伪造数), 判定行跳过', () => {
    const ledger = ledgerOf(assistantLine('无 usage 轮'));
    const lines = serializeLedger(ledger, { now: FIXED_NOW });
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row.ctxTokens).toBeNull();
    expect(typeof row.ctxTokens).not.toBe('number');
  });

  test('owner/时钟可注入(测试确定性)', () => {
    const ledger = ledgerOf(assistantLine('轮1', usageTokens(100)));
    const [line] = serializeLedger(ledger, { owner: 'test-owner', now: FIXED_NOW });
    const row = JSON.parse(line!) as Record<string, unknown>;
    expect(row.owner).toBe('test-owner');
    expect(row.ts).toBe(FIXED_TS);
  });
});

describe('appendLedger: append / offset / lock / owner / path 五项契约', () => {
  test('首次写: 落盘路径与 writer.ts:351,367 尾读逐字对齐, 内容 = serializer 行', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(
      assistantLine('轮1', usageTokens(226451)),
      assistantLine('轮2', usageTokens(190189)),
    );
    const res = appendLedger({ ledger, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(res.ok).toBe(true);
    expect(res.appended).toBe(2);
    expect(res.offset).toBe(0);

    const path = expectedLedgerPath(sessionId);
    expect(res.ledgerPath).toBe(path);
    expect(existsSync(path)).toBe(true);
    // slug 派生与 resolveProject 一致(MP-INV-1: 非 git cwd → basename slug)。
    expect(path).toContain(join('projects', slugifyProject(basename(projectDir)), 'session', sessionId, 'ledger.jsonl'));

    const onDisk = readFileSync(path, 'utf-8').trim().split('\n');
    expect(onDisk).toEqual(serializeLedger(ledger, { now: FIXED_NOW }));
  });

  test('offset 去重: 同 ledger 再 append → appended 0, 文件逐字节不变', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(assistantLine('轮1', usageTokens(226451)));
    const first = appendLedger({ ledger, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(first.ok).toBe(true);
    const before = readFileSync(first.ledgerPath!, 'utf-8');

    const again = appendLedger({ ledger, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(again.ok).toBe(true);
    expect(again.appended).toBe(0);
    expect(again.offset).toBe(1);
    expect(readFileSync(first.ledgerPath!, 'utf-8')).toBe(before);
  });

  test('增量追加: transcript 长了 → 只追加新 entry 行', () => {
    const sessionId = nextSession();
    const two = ledgerOf(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(150000)));
    appendLedger({ ledger: two, sessionId, cwd: projectDir, now: FIXED_NOW });

    const three = ledgerOf(
      assistantLine('轮1', usageTokens(100000)),
      assistantLine('轮2', usageTokens(150000)),
      assistantLine('轮3', usageTokens(210000)),
    );
    const res = appendLedger({ ledger: three, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(res.ok).toBe(true);
    expect(res.appended).toBe(1);
    expect(res.offset).toBe(2);

    const onDisk = readFileSync(res.ledgerPath!, 'utf-8').trim().split('\n');
    expect(onDisk).toHaveLength(3);
    const last = JSON.parse(onDisk[2]!) as Record<string, unknown>;
    expect(last.ordinal).toBe(3);
    expect(last.ctxTokens).toBe(210000);
  });

  test('lock: 锁文件被占 → fail-open 不写不抛', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(assistantLine('轮1', usageTokens(226451)));
    const path = expectedLedgerPath(sessionId);
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true }); // 锁文件父目录(同 ledger 目录)先建
    writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}`);

    let res;
    try {
      res = appendLedger({ ledger, sessionId, cwd: projectDir, lockTimeoutMs: 50 });
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* 已清 */
      }
    }
    expect(res!.ok).toBe(false);
    expect(res!.error).toContain('锁');
    expect(existsSync(path)).toBe(false); // 零写入
  });

  test('坏行(状态未知) → fail-open 不追加', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(assistantLine('轮1', usageTokens(226451)));
    const path = expectedLedgerPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not-json-at-all\n');

    const res = appendLedger({ ledger, sessionId, cwd: projectDir });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不可解析');
    expect(readFileSync(path, 'utf-8')).toBe('not-json-at-all\n'); // 原样未动
  });

  test('entries 回退(transcript 替换/变短) → 状态未知, fail-open 不追加', () => {
    const sessionId = nextSession();
    const three = ledgerOf(
      assistantLine('轮1', usageTokens(100000)),
      assistantLine('轮2', usageTokens(150000)),
      assistantLine('轮3', usageTokens(210000)),
    );
    appendLedger({ ledger: three, sessionId, cwd: projectDir, now: FIXED_NOW });

    const two = ledgerOf(assistantLine('轮1', usageTokens(100000)), assistantLine('轮2', usageTokens(150000)));
    const res = appendLedger({ ledger: two, sessionId, cwd: projectDir });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('状态未知');
    expect(res.offset).toBe(3);
  });

  test('sessionId 缺失 → fail-open 不写(无法对齐 W1 分区路径)', () => {
    const ledger = ledgerOf(assistantLine('轮1', usageTokens(226451)));
    const res = appendLedger({ ledger, sessionId: '  ', cwd: projectDir });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sessionId');
  });
});

describe('消费契约: W1 latestCtxTokens 认读(writer.ts:277-289 判定行语义)', () => {
  test('逆扫取最新 number;null ctxTokens 行跳过;末行缺 token 穿透到更早真值', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(
      assistantLine('轮1'), // ctxTokens null
      assistantLine('轮2', usageTokens(111)),
      assistantLine('轮3'), // ctxTokens null
      assistantLine('轮4', usageTokens(222)),
    );
    const res = appendLedger({ ledger, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(res.ok).toBe(true);

    const tail = readFileSync(res.ledgerPath!, 'utf-8');
    expect(latestCtxTokens(tail)).toBe(222);
    expect(JSON.parse(tail.trim().split('\n')[3]!) as Record<string, unknown>).toMatchObject({
      ordinal: 4,
      ctxTokens: 222,
    });
  });

  test('全 null → 判定行读不到 number → null(fail-open, 不伪造)', () => {
    const sessionId = nextSession();
    const ledger = ledgerOf(assistantLine('轮1'), assistantLine('轮2'));
    const res = appendLedger({ ledger, sessionId, cwd: projectDir, now: FIXED_NOW });
    expect(res.ok).toBe(true);
    expect(latestCtxTokens(readFileSync(res.ledgerPath!, 'utf-8'))).toBeNull();
  });
});
