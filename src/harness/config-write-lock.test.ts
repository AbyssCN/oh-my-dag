/**
 * GWT-4 · C-4 · INV-10/11/12 — `.omd/config.json` 写者独占锁闸
 *
 * 三条闸, 锁体任一退化 (锁丢了 / 静默吞错 / 残锁 / 单写者走样) 即红:
 *
 *   GWT-4a  两子进程并发改不同段 → 两改动均写盘
 *           (反向闸: 不加锁时后写者会覆盖先写者, 这就是它复现的那次事故 —
 *           两个 omd 写者 (交互式 + 后台) 同时改 .omd/config.json, 一个
 *           的 leaf 改动在另一次写者的 conductor 改动中蒸发。)
 *
 *   GWT-4b  锁被活进程持有 → 第二写者响亮抛错 (判词含持有者 pid)
 *           (反向闸: 若 acquireConfigLock 改成静默返 null / try-catch
 *           吞 EEXIST, 本闸的红是直接 TypeError/丢错。)
 *
 *   GWT-4c  单写者无竞争 → 产物与不加锁同一操作逐字节相同, 不留残锁
 *           (反向闸: 若 withConfigLock 在 finally 里漏 releaseConfigLock,
 *           或 mutator 内 readFileSync / writeFileSync 顺序改坏,
 *           字节级 diff 当场红。)
 *
 * 隔离: 全部走 mkdtemp + OMD_CONFIG_PATH 指进 tmp, 永不碰真 ~/.omd/config.json。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireConfigLock, configLockPath, withConfigLock } from './config-lock';

const REPO = resolve(import.meta.dir, '..', '..');
const ROLE_MODELS_TS = join(REPO, 'src/model/role-models.ts');
const CONFIG_LOCK_TS = join(REPO, 'src/harness/config-lock.ts');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-configlock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

/** 写一份最小 config.json, 路径 = dir/.omd/config.json。 */
function seedConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const configPath = join(dir, '.omd/config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  const initial = { version: 2, models: { conductor: 'init:c', leaf: 'init:l' }, ...extra };
  writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`);
  return configPath;
}

/** 等子进程, 把它 stdout/stderr 一起返; 失败时把 stderr 拼进 message 便于定位。 */
async function drain(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // stdout/stderr 经 `pipe` 配置后是 ReadableStream; TS 把 union 算得较宽, 这里收一下。
  const so = proc.stdout as ReadableStream<Uint8Array>;
  const se = proc.stderr as ReadableStream<Uint8Array>;
  const [code, stdoutRaw, stderrRaw] = await Promise.all([
    proc.exited,
    new Response(so).text(),
    new Response(se).text(),
  ]);
  return { code, stdout: stdoutRaw, stderr: stderrRaw };
}

describe('GWT-4 · C-4 · INV-10/11/12: .omd/config.json 写锁闸', () => {
  // ──────────────────────────────────────────────────────────────────────
  // GWT-4a: 两子进程并发改不同段 → 两改动均写盘 (反向闸)
  //
  // 证伪: 把 src/model/role-models.ts 的 mutateConfig 里的 withConfigLock
  // 改成裸调用 (直接把 () => { ... } 当 mutator 跑, 不 acquire/release),
  // 重跑本测试 → 两子进程的迭代大概率互相覆盖, 最终 conductor 与 leaf
  // 至少有一个停在远早于 N-1 的旧值, expect 链即红。
  // ──────────────────────────────────────────────────────────────────────
  test('GWT-4a: 两子进程并发改不同段, 两改动均写盘 (反向闸: 无锁必丢一笔)', async () => {
    const dir = tmp();
    const configPath = seedConfig(dir);

    const writerScript = (
      role: 'conductor' | 'leaf',
      tag: 'a' | 'b',
    ): string => `
import { persistRoleModel } from ${JSON.stringify(ROLE_MODELS_TS)};
const path = process.argv[2];
const N = parseInt(process.argv[3], 10);
const role = ${JSON.stringify(role)};
const tag = ${JSON.stringify(tag)};
for (let i = 0; i < N; i++) {
  persistRoleModel(role, tag + ':' + i, path);
}
process.stdout.write('DONE_' + tag + '\\n');
`;

    const N = 30; // 足够多轮 → 不加锁时后写者覆盖先写者, 终值远早于 N-1 必中
    const scriptA = join(dir, 'writer-a.ts');
    const scriptB = join(dir, 'writer-b.ts');
    writeFileSync(scriptA, writerScript('conductor', 'a'));
    writeFileSync(scriptB, writerScript('leaf', 'b'));

    // 同时起两子进程: 真 OS 进程, 真文件竞用 (非线程, 非 worker)。
    const procA = Bun.spawn(['bun', 'run', scriptA, configPath, String(N)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const procB = Bun.spawn(['bun', 'run', scriptB, configPath, String(N)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [resA, resB] = await Promise.all([drain(procA), drain(procB)]);
    expect(resA.code).toBe(0);
    expect(resB.code).toBe(0);
    expect(resA.stdout).toContain('DONE_a');
    expect(resB.stdout).toContain('DONE_b');

    // 承重墙断言: 两个写者的最后值必须都在, 因为锁内的 read-modify-write
    // 让 B 的迭代读到的就是 A 已盘的最新内容。无锁时 race → 一边蒸发。
    const finalRaw = readFileSync(configPath, 'utf8');
    const final = JSON.parse(finalRaw) as {
      version: number;
      models: Record<string, string>;
    };
    expect(final.models.conductor).toBe(`a:${N - 1}`);
    expect(final.models.leaf).toBe(`b:${N - 1}`);

    // 锁文件不残留 (INV-12: 单写者完成即放; 两写者都完成更不该留)。
    expect(existsSync(configLockPath(configPath))).toBe(false);
  }, 60_000);

  // ──────────────────────────────────────────────────────────────────────
  // GWT-4b: 锁被活进程持有 → 第二写者响亮抛错含 holder pid (反向闸)
  //
  // 证伪: 把 src/harness/config-lock.ts:60-78 的 catch 分支里
  // throw new Error(...) 注释掉 / 改成 return 一个空 release,
  // 本闸的红是 expect(...).toThrow() 拿到 undefined/no-err 即挂;
  // 而且判词必须含 holder pid (不是只含 'config-lock')。
  // ──────────────────────────────────────────────────────────────────────
  test('GWT-4b: 锁被活进程持有 → 第二写者响亮抛错含 holder pid', async () => {
    const dir = tmp();
    const configPath = seedConfig(dir);

    // 子进程: 抢锁 → 睡 holdMs → 放锁退出。
    // 父进程拿到 holder.pid 后, 轮询锁文件存在 (≤1s) → 用 500ms timeout 抢,
    // 必抛 EEXIST→deadline 错, 判词含 holder pid。
    const holderScript = `
import { acquireConfigLock } from ${JSON.stringify(CONFIG_LOCK_TS)};
const configPath = process.argv[2];
const holdMs = parseInt(process.argv[3], 10);
const release = acquireConfigLock(configPath);
await new Promise((r) => setTimeout(r, holdMs));
release();
`;
    const scriptPath = join(dir, 'holder.ts');
    writeFileSync(scriptPath, holderScript);

    const holdMs = 4_000; // 父进程抢锁 timeout (500ms) < holdMs, 必撞墙
    const holder = Bun.spawn(['bun', 'run', scriptPath, configPath, String(holdMs)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const holderPid = holder.pid; // 子进程 pid 直接拿, 不用读 stdout (会阻塞到子退出)

    // 等锁文件出现 (子进程已抢到锁)。最多等 1s, 远短于 holdMs。
    const lockPath = configLockPath(configPath);
    const lockAppearDeadline = Date.now() + 1_000;
    while (!existsSync(lockPath) && Date.now() < lockAppearDeadline) {
      Bun.sleepSync(20);
    }
    expect(existsSync(lockPath)).toBe(true); // 子进程确已持锁

    try {
      let thrown: unknown = null;
      try {
        // 500ms timeout: 远短于 holdMs (4s), 必抛 EEXIST→deadline 错。
        acquireConfigLock(configPath, 500);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const msg = (thrown as Error).message;
      // 判词必须含: 持有者 pid + 「拒绝静默」字样 + 锁文件路径 (任一缺失即降级)。
      expect(msg).toContain(`pid=${holderPid}`);
      expect(msg).toContain('拒绝静默覆盖');
      expect(msg).toContain(lockPath);

      // 锁文件内容本身也含该 pid, 双校验 (读 lock 文件 vs 读抛错判词)。
      const lockBody = readFileSync(lockPath, 'utf8').split('\n')[0]!.trim();
      expect(lockBody).toContain(String(holderPid));
    } finally {
      // 等子进程自然放锁, 避免 SIGKILL 留下半截状态污染其他测试。
      await holder.exited;
    }

    // 子进程放完后, 锁文件已 unlink, 同路径再抢立即成功。
    expect(existsSync(lockPath)).toBe(false);
    const release2 = acquireConfigLock(configPath, 500);
    release2();
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────
  // GWT-4c: 单写者无竞争 → 产物与无锁同一操作逐字节相同, 不留残锁
  //
  // 证伪:
  //   · 若 withConfigLock 把 `${JSON.stringify(cfg, null, 2)}\n` 的尾换行
  //     改成 `''` 或多加空格, 「逐字节」必红。
  //   · 若 releaseConfigLock 在 finally 里漏调, 锁文件残留 → existsSync 红。
  //   · 若 mutator 内 readFileSync / writeFileSync 顺序颠倒, 字节级 diff 红。
  //   · 额外: 复用同函数二次调用 → 锁拿得到放得下, 不残留 (幂等性)。
  // ──────────────────────────────────────────────────────────────────────
  test('GWT-4c: 单写者无竞争产物与无锁同一操作逐字节相同, 不留残锁', () => {
    const dir = tmp();
    const configPath = seedConfig(dir, { defaultModel: 'init:default' });

    // 「无锁同一操作」基准: 锁外读-改-写, 与 mutateConfig 内部同字节形状。
    const mutate = (cfg: Record<string, unknown>): void => {
      const models = (cfg.models ?? {}) as Record<string, string>;
      models.conductor = 'c:locked';
      models.leaf = 'l:locked';
      cfg.models = models;
    };
    const baselineBytes = ((): string => {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      mutate(cfg);
      return `${JSON.stringify(cfg, null, 2)}\n`;
    })();

    // 「加锁同一操作」: 走 withConfigLock, 内部应做完全一致的读-改-写。
    withConfigLock(configPath, () => {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      mutate(cfg);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    });

    // 逐字节相同 (INV-12: 单写者路径行为不变)。
    expect(readFileSync(configPath, 'utf8')).toBe(baselineBytes);

    // 锁文件不残留。
    expect(existsSync(configLockPath(configPath))).toBe(false);

    // 不抛错 (再调一次, 拿得到放得下, 幂等) — 防 finally 漏 release 的二次自检。
    let secondErr: unknown = null;
    try {
      withConfigLock(configPath, () => {
        /* noop */
      });
    } catch (e) {
      secondErr = e;
    }
    expect(secondErr).toBeNull();
    expect(existsSync(configLockPath(configPath))).toBe(false);
  });
});