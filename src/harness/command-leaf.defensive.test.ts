/**
 * command-leaf 三条防御契约 (H5)。每条用例上方一行「证伪」写死今日实盘读到的错值 ——
 * 在实装改动之前, 这三条必须当场红; 实装只许改 src/harness/command-leaf.ts 侧, 本文件不得为迎合实装而变弱。
 *
 * 实盘形状核验 (2026-08-19, bun 1.3.14, 写测试前当场探过, 与契约文本不符处按实盘走并在此说明):
 *  ① 今日 (bun 1.3.14) `createCommandLeafRunner({ allowlist:['tail'], timeoutMs:150 })` 跑 `tail -f /dev/null`
 *     **返回 res, 但 res 上只有 { text, usage, exitCode }**: `createCommandLeafRunner` 末行把 `defaultSpawn`
 *     已算好的五字段里的 timedOut/signal 丢在返回路径上 —— 实测 `r.timedOut === undefined` (期望 true, 红)、
 *     `r.signal === undefined`。契约文本说的「必读到 exitCode:124」读不到 (外层 124 哨兵 5150ms, 内层界先赢)。
 *  ② bun 1.3.14 的 `Bun.spawn` **不传 env = 子进程 env 为空** (不是继承父进程); `proc.exited` 对
 *     SIGTERM 杀掉的进程折成 `143` 返回, `proc.signalCode === 'SIGTERM'`、`proc.exitCode === null`。
 *  ③ Bun.Subprocess **没有** `once`/`removeAllListeners`/`listenerCount` (实测均 undefined) ——
 *     契约里的 `once('exit')` 形状是 Node 的; H5-2 用自建 handle 包裹真实子进程、以钩子记录顺序,
 *     断言强度不变 (摘监听器必须先于 dispose 返回、且必须发生在真实退出之后)。
 *  ④ 本文件只用 `bun:test` + 真实子进程 + 仓内已有 helper (`./proc/await-exit` 的 `processGone`,
 *     零新依赖); `disposeCommandLeafChild`/`scrubCredentialEnv` 今日不存在 → 走 namespace import,
 *     让每条用例各自红在**自己的断言**上, 而不是整文件 load 期爆掉 (命名 import 缺导出时 bun 会
 *     在加载期抛, 三条证伪全看不见)。
 */
import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner } from './command-leaf';
import * as commandLeaf from './command-leaf';
import { processGone } from './proc/await-exit';
import type { CommandLeafResult } from './leaf-runners';

/** 契约形状 (实装到位后与真签名兼容; 今日为 undefined, 恰是 H5-2/H5-3 要当场读到的错值)。 */
type DisposeFn = (child: unknown, reason: 'timeout' | 'cancel' | 'error', opts?: unknown) => Promise<void>;
type ScrubFn = (env: Record<string, string | undefined>) => Record<string, string | undefined>;

const dispose = (commandLeaf as unknown as { disposeCommandLeafChild?: DisposeFn }).disposeCommandLeafChild;
const scrub = (commandLeaf as unknown as { scrubCredentialEnv?: ScrubFn }).scrubCredentialEnv;

/** 永不 EOF 的管道 —— 让 readAllBounded 撞它的界, 与真 `tail -f` 同效但零泄漏。每次调用现造 (Response 会锁流)。 */
function neverEnding(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

describe('command-leaf 防御契约 (H5)', () => {
  // 证伪: 今日 (bun 1.3.14) runner 返回结果上 timedOut/signal 两字段实测 undefined —— createCommandLeafRunner 末行只返 { text, usage, exitCode }, defaultSpawn 已算出的五字段被丢在返回路径; 腿① 实测 r1.timedOut === undefined (expect true → 红)、r1.signal === undefined (expect string → 红); 腿② 契约硬例 { timedOut:true, exitCode:0, signal:null } 实测读 { timedOut: undefined, exitCode: 0, signal: undefined } → 必红 (H5 当场证伪)
  test('H5-1 timedOut/signal/exitCode 三字段正交独立: 超时杀不推断退出码, 优雅退 0 不掩盖 timedOut', async () => {
    // ── 腿① 真进程: 超时被杀, 退出码只许来自内核观测 (bun 实测 exited 折 143 / signalCode SIGTERM), 不许折 128+n、不许兑 124。
    const real = createCommandLeafRunner({ allowlist: ['tail'], timeoutMs: 150 });
    let res1: CommandLeafResult | null = null;
    let thrown1: unknown;
    try {
      res1 = await real({ command: 'tail -f /dev/null' });
    } catch (e) {
      thrown1 = e; // 今日: 不走此路 (res 正常返回, 坏的是 runner 丢掉的字段)
    }
    expect(thrown1).toBeUndefined();
    const r1 = (res1 ?? {}) as unknown as Record<string, unknown>;
    expect(r1.timedOut).toBe(true); // 今日: undefined
    expect(typeof r1.signal).toBe('string'); // 今日: undefined
    expect(r1.exitCode).toBeNull(); // 今日: undefined; bun 实折 143, 实装必须还 null (互不推断: 不许折 128+n)
    expect(r1.exitCode).not.toBe(124); // 哨兵值不是真相, 禁止冒充

    // ── 腿② 优雅退 0: 替身子进程收到 kill 后以退出码 0 结束 (trap 'exit 0' TERM 的注入等价形)。
    // 契约硬例: 合法结果 { timedOut:true, exitCode:0, signal:null } 必须可分辨 —— timedOut 不许由 exitCode!==0 推断, signal 不许拿「发了什么信号」冒充「怎么死的」。
    const sent: string[] = [];
    const exitDeferred = (() => {
      let resolve: (n: number) => void = () => {};
      const proc = {
        stdout: neverEnding(),
        stderr: neverEnding(),
        exited: new Promise<number>((res) => {
          resolve = res;
        }),
        pid: 0x7fff_fffe,
        kill: (sig?: number | NodeJS.Signals) => {
          sent.push(String(sig));
          resolve(0); // 优雅退 0
        },
      };
      return proc;
    })();
    const graceful = createCommandLeafRunner({ allowlist: ['tail'], timeoutMs: 150, spawnRaw: () => exitDeferred });
    let res2: CommandLeafResult | null = null;
    let thrown2: unknown;
    try {
      res2 = await graceful({ command: 'tail -f /dev/null' });
    } catch (e) {
      thrown2 = e; // 今日: 同样的「管道被运行时丢了」reject
    }
    expect(thrown2).toBeUndefined();
    expect(sent.length).toBeGreaterThan(0); // 实装必须先 kill 再读退出事实, 不能靠哨兵编数
    const r2 = (res2 ?? {}) as unknown as Record<string, unknown>;
    // 今天必然读错的组合: 被超时杀掉、但进程自己优雅退 0 —— 两字段同时为真/为零, 互不推断。
    expect({ timedOut: r2.timedOut, exitCode: r2.exitCode }).toEqual({ timedOut: true, exitCode: 0 });
    expect(r2.signal).toBeNull(); // 死于 exit(0), 不是死于信号; 拿「发了 SIGTERM」冒充 signal 也红
  });

  // 证伪: 今日 src/harness/command-leaf.ts 不导出 disposeCommandLeafChild, namespace import 读到 undefined → 本条第一断言 toBeTypeOf("function") 当场红 (实读 undefined); 若有人补了 dispose 却先摘监听器再等 exit、或不等真实退出就返回, 顺序断言 ["exit","removeAllListeners","after-dispose"] 与 dispose 返回瞬间 processGone(pid)===true 仍红。API 形状按实盘: bun 1.3.14 的 Bun.Subprocess 没有 once/removeAllListeners, 顺序由自建 handle 钩子记录, 强度不降 (H5 当场证伪)
  test('H5-2 dispose 完全停稳: 发信号 → 等真实退出 → 摘监听器 → 才返回, 属主回来时进程必已死', async () => {
    expect(dispose).toBeTypeOf('function'); // 今日: undefined → 红
    const p = Bun.spawn(['tail', '-f', '/dev/null'], { stdout: 'pipe', stderr: 'pipe' });
    const order: string[] = [];
    // 自建 handle: exited 落定时记 'exit', removeAllListeners 被摘时记一笔 —— 顺序即协议。
    const handle = {
      exited: p.exited.then((code) => {
        order.push('exit');
        return code;
      }),
      pid: p.pid,
      kill: (sig?: number | NodeJS.Signals) => p.kill(sig),
      removeAllListeners: () => {
        order.push('removeAllListeners');
      },
    };
    try {
      // 先验活着: 真实 pid 探测 + exited race —— 两条都独立于「要验证的 dispose」。
      expect(processGone(p.pid)).toBe(false);
      const alive = await Promise.race([p.exited.then(() => false), Bun.sleep(50).then(() => true)]);
      expect(alive).toBe(true);

      await dispose!(handle, 'cancel');
      order.push('after-dispose');

      // dispose 返回那一刻, pid 已死 (真实存活探测, 不借 exited 记账 —— 记账正是这台运行时要防的坏)。
      expect(processGone(p.pid)).toBe(true);
      const dead = await Promise.race([handle.exited.then(() => true), Bun.sleep(50).then(() => false)]);
      expect(dead).toBe(true);
      // 顺序闸: 真实退出 → 摘监听器 → dispose 返回。先摘监听器再等 exit / 不等 exit 就返回 / 摘了又没等, 全红。
      // 外部可观测的中间态「属主已回来 (dispose resolved) 却仍标 running」被上面两条 + 这条顺序联合钉死。
      expect(order).toEqual(['exit', 'removeAllListeners', 'after-dispose']);
    } finally {
      if (!processGone(p.pid)) p.kill('SIGKILL');
    }
  });

  // 证伪: 今日 defaultSpawn 的 Bun.spawn 不传 env, 而 bun 1.3.14 实测「不传 env = 子进程 env 为空」—— 无关变量 KEEP 也被打成 MISSING (实测 res.text = "MISSING\nMISSING\nMISSING\nMISSING\nMISSING", 凭证值一个不漏但 KEEP 也不在) → 「无关变量仍在」这条必红; scrubCredentialEnv 今日不存在 → toBeTypeOf("function") 读 undefined 亦红。剥离必须是选择性 scrub (env: scrubCredentialEnv(process.env)), 不是把 env 整清空, 也不是全局挂钩 spawn (H5 当场证伪)
  test('H5-3 凭据剥离只作用于用户命令 spawn: 四个凭据变量摘掉、无关变量保留、engine 自身 env 原样', async () => {
    const saved: Record<string, string | undefined> = {
      MY_API_KEY: process.env.MY_API_KEY,
      X_SECRET: process.env.X_SECRET,
      GH_TOKEN: process.env.GH_TOKEN,
      DB_PASSWORD: process.env.DB_PASSWORD,
      KEEP: process.env.KEEP,
    };
    process.env.MY_API_KEY = 'MY_KEY_VAL';
    process.env.X_SECRET = 'X_SECRET_VAL';
    process.env.GH_TOKEN = 'GH_TOKEN_VAL';
    process.env.DB_PASSWORD = 'DB_PASSWORD_VAL';
    process.env.KEEP = 'PLAIN_VAL';
    try {
      const run = createCommandLeafRunner({ allowlist: ['node'] });
      const cmd = [
        'node -p "process.env.MY_API_KEY ?? \'MISSING\'"',
        'node -p "process.env.X_SECRET ?? \'MISSING\'"',
        'node -p "process.env.GH_TOKEN ?? \'MISSING\'"',
        'node -p "process.env.DB_PASSWORD ?? \'MISSING\'"',
        'node -p "process.env.KEEP ?? \'MISSING\'"',
      ].join(' && ');
      const res = await run({ command: cmd });

      // 四个凭据变量都不在子进程 env: 打出来的是 MISSING 而不是值。
      expect(res.text).toContain('MISSING');
      expect(res.text).not.toContain('MY_KEY_VAL');
      expect(res.text).not.toContain('X_SECRET_VAL');
      expect(res.text).not.toContain('GH_TOKEN_VAL');
      expect(res.text).not.toContain('DB_PASSWORD_VAL');
      // 无关变量仍在 —— 剥离是选择性 scrub, 不是把子进程 env 整个清空 (今日实读: KEEP 也 MISSING → 红)。
      expect(res.text).toContain('PLAIN_VAL');

      // 剥离只作用于用户命令这一路: 父进程 (engine 自己) 的 env 原样未动 —— scrub 必须返副本, 不许原地删。
      expect(process.env.MY_API_KEY).toBe('MY_KEY_VAL');
      expect(process.env.KEEP).toBe('PLAIN_VAL');
      // engine 自身 spawn 那一路 (直接 Bun.spawn, 显式 env: process.env) 不被 scrub 挂钩: 全局偷改 Bun.spawn 的实现会在这里红。
      const direct = Bun.spawn(['sh', '-c', 'echo ENGINE_MY_API_KEY=${MY_API_KEY}'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env,
      });
      const directText = await new Response(direct.stdout).text();
      expect(directText.trim()).toBe('ENGINE_MY_API_KEY=MY_KEY_VAL');

      // 单元形状: 命中 /(KEY|SECRET|TOKEN|PASSWORD)/i 的键摘掉 (大小写不敏感), 其余原样。
      expect(scrub).toBeTypeOf('function'); // 今日: undefined → 红
      expect(
        scrub!({ KEEP: '1', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', DATABASE_PASSWORD: 'z', lowercase_key: 'w' }),
      ).toEqual({ KEEP: '1' });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
