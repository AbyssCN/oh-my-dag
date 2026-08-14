/**
 * src/harness/goal/experiment-flags —— 实验旗标读取 (`.omd/experiments.json`)。
 *
 * 锚点是 `omdRepoRoot()`(引擎自己装在哪), **不是** `config.cwd` —— branch 策略下 `config.cwd`
 * 是 worktree, `.omd/` 在那边是 gitignored 的空目录, 从那读永远拿不到旗标 (静默 off, 长得像
 * "旗标没生效"其实是"读错了地方")。
 *
 * fail-open 三档, 全部落回 off, 但**只有解析失败才留证据**(缺文件/缺键是正常态, 不是异常):
 *   - 文件不存在 → off, 静默 (还没人开过这个实验)
 *   - 键缺失 → off, 静默 (旗标文件在, 但没提这个键)
 *   - JSON 解析失败 → off, 但 `console.error` 一行(含完整路径与错误原文) —— 铁律: 可以吞异常,
 *     不许吞证据。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { omdRepoRoot } from '../repo-root';

export interface ExperimentFlags {
  contractFaninDistill: boolean;
}

const ALL_OFF: ExperimentFlags = { contractFaninDistill: false };

export function readExperimentFlags(): ExperimentFlags {
  const path = join(omdRepoRoot(), '.omd', 'experiments.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return ALL_OFF; // 文件不存在 = 没人开过实验, 不是异常
  }
  try {
    const parsed = JSON.parse(raw);
    return { contractFaninDistill: parsed?.contractFaninDistill === true };
  } catch (err) {
    console.error(`experiment-flags: JSON 解析失败, fail-open 视同全 off — ${path}: ${err}`);
    return ALL_OFF;
  }
}
