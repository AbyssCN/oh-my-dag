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
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  },
  destination,
);

export type Logger = typeof logger;
