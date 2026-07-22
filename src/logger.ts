import { writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { loadEnv } from './env';

const env = loadEnv();

// 可变 fd 汇: 默认 stdout; MCP 等 stdout 协议入口调 setLoggerDestination(2) 改道 stderr, 保 stdout 纯协议帧。
let logFd = 1;

export function setLoggerDestination(fd: number): void {
  logFd = fd;
}

const destination = new Writable({
  write(chunk, _encoding, callback) {
    writeSync(logFd, chunk);
    callback();
  },
});

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            // destination: 2 (stderr) 钉死: transport 在 worker 线程写自己的 fd, 完全绕开下方可变
            // destination 流 → setLoggerDestination 对它无效。stdout 必须留给协议帧 (MCP) / 答案
            // (dag-* 脚本, 2026-07-22 演习实测 WARN 混进 issue 评论)。
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', destination: 2 },
          },
        }
      : {}),
  },
  destination,
);

export type Logger = typeof logger;
