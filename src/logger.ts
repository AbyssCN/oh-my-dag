import { writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import pretty from 'pino-pretty';
import { loadEnv } from './env';

const env = loadEnv();

// 可变 fd 汇: MCP 等 stdout 协议入口调 setLoggerDestination(2) 改道 stderr, 保 stdout 纯协议帧;
// `omd tui` 改道到一个日志文件 (src/tui/logging.ts) —— TUI 独占终端, stdout/stderr 都会花屏。
//
// 默认值按 NODE_ENV 分是**保持原行为**, 不是新口味: 改造前 dev 走 pino-pretty transport 写死 fd 2,
// prod 走下方 Writable 默认 fd 1。两条默认原样搬过来, 只是现在都经过同一个可变汇。
let logFd = env.NODE_ENV === 'development' ? 2 : 1;

export function setLoggerDestination(fd: number): void {
  logFd = fd;
}

const destination = new Writable({
  write(chunk, _encoding, callback) {
    writeSync(logFd, chunk);
    callback();
  },
});

// dev 的美化**在进程内做**, 不再走 pino-pretty 的 worker transport (2026-08-07, TUI 切片 S3)。
//
// 换掉的理由是一条实测的死路: transport 跑在 worker 线程里、写它自己的 fd (原先钉死 2),
// 完全绕开下方这个可变 destination → `setLoggerDestination` 对 dev 模式**一个字节都改不动**。
// 而 NODE_ENV 默认就是 development, 于是 `omd tui` 在默认环境下无法把日志从终端挪走,
// 引擎一条 warn 就把 UI 打花。in-process 之后 dev / prod 两条路只经过这一个汇, 改道一处即全生效。
//
// 实测 (node 与 bun 两个宿主): ① 汇在两次 log 之间被改, 第二条即落新 fd;
// ② `logger.warn(...)` 紧接 `process.exit(0)` 不丢行 (同步写穿)。
const sink =
  env.NODE_ENV === 'development'
    // `SYS:` 前缀 = **按本机时区渲染**。没有它 pino-pretty 一律按 UTC 打, 而打出来的
    // `[02:25:50.681]` 不带任何时区标记 —— 与 `ls --time-style` / `git log --date=iso-local`
    // 的本地时间(赫尔辛基 UTC+3)差 3 小时, 而两边长得一模一样。2026-08-21 我照这行读
    // run 58df6b9e 的时间线, 两次把 UTC 当本地, 凭空多算 3 小时。**这是渲染缺陷不是看错**:
    // 时间串上没有能让人自查的位, 所以只能靠标记补, 不能靠纪律。
    ? pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname', destination })
    : destination;

export const logger = pino({ level: env.LOG_LEVEL }, sink);

export type Logger = typeof logger;
