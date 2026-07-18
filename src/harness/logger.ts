/**
 * 包内 logger 接缝(INV-X3:包不自带 pino/自读宿主 env;宿主经 setCoreLogger 注入)。
 * 默认 = console 薄壳(debug 静默),与上游宿主 pino logger 的调用面(child/level 方法)兼容子集。
 */
export interface CoreLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (obj, msg) => console.log(msg ?? '', typeof obj === 'string' ? obj : ''),
  warn: (obj, msg) => console.warn(msg ?? '', typeof obj === 'string' ? obj : ''),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

let current: CoreLogger = consoleLogger;

/** 宿主注入真 logger(如 pino 或宿主自家 logger)。 */
export function setCoreLogger(l: CoreLogger): void {
  current = l;
}

/** 兼容上游宿主 `import { logger } from '../logger'` 的调用面。 */
export const logger: CoreLogger = {
  debug: (o, m) => current.debug(o, m),
  info: (o, m) => current.info(o, m),
  warn: (o, m) => current.warn(o, m),
  error: (o, m) => current.error(o, m),
};
