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

/**
 * 结构化那一位渲染成一行。**这里原先是 `''`** —— 即 `logger.info({node,path,why}, msg)` 的
 * 三个字段被薄壳直接扔掉,只留下一句光秃秃的话。
 *
 * 2026-08-21 的现场(run `58df6b9e`):毒集回滚打了 9 行「这条**没撤**」,而 `path`/`node`/`why`
 * 一个都没印出来 —— 于是「没撤」与「没这条路径」事后长得**一模一样**,正是
 * `poison-rollback.ts` 的模块注释明写要避免的那件事。查下去才发现不是那个模块的问题:
 * **生产路径从来没有人调过 `setCoreLogger`**(全仓调用点只在测试里),所以 `src/harness/**`
 * 那 53 个模块的留证,在每一次真跑里都走这只薄壳、都被扔掉。
 *
 * 这是本仓「fail-open 可以吞异常,不许吞证据」那条的一个实例,而且吞的位置在**灯自己身上**。
 */
const fmtFields = (obj: unknown): string => {
  if (obj === undefined || obj === null) return '';
  if (typeof obj === 'string') return obj;
  try {
    return JSON.stringify(obj);
  } catch {
    // 循环引用 / BigInt 之类 —— 退到 String() 也比印空串强(印空串就是又吞一次)。
    return String(obj);
  }
};

const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (obj, msg) => console.log(msg ?? '', fmtFields(obj)),
  warn: (obj, msg) => console.warn(msg ?? '', fmtFields(obj)),
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
