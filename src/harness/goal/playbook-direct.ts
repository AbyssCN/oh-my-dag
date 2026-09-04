/**
 * src/harness/goal/playbook-direct —— `loadPlaybookForGoal`: 在 `cwd` 找一份 playbook 决定 root/source。
 *
 * ## 与 tests 文件的关系
 *
 * 同 compile.ts —— `compile.test.ts` 的内联 impl 占位是同源副本, 本文件落生产侧后两者必须逐字同构。
 *
 * ## 项目层 vs 内置 (A-2 同源)
 *
 * 叠加顺序 (load.ts 的 `loadPlaybooks`): 内置先灌、项目层后灌, 同名项目层覆盖内置层。
 * 本函数拿到合并后的 Map 后, 还要判定**读哪个目录下的 md 文档** —— 那才是 compilePlaybook 的
 * `playbookRoot` 入参。
 *
 * 规则:
 *   - 项目层目录 (`<cwd>/.omd/playbooks/<name>/`) 真存在 → source: 'project', root: 项目层目录。
 *   - 否则 → source: 'builtin', root: BUILTIN_PLAYBOOK_DIR/<name>/。
 *
 * `existsSync` 真检查与 load.ts 的 A-2 闸一致 —— 不靠名字猜。
 *
 * ## 失败形态
 *
 * `name` 不在合并 Map 里 → 抛错, 错误文案列**已知名** (与 load.ts 同形态; tests (b) 的反向自检点)。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PLAYBOOK_DIR, PROJECT_PLAYBOOK_DIR, loadPlaybooks } from '../playbook/load';
import type { Playbook } from '../playbook/types';

export interface LoadedPlaybook {
  readonly pb: Playbook;
  readonly root: string;
  readonly source: 'builtin' | 'project';
}

export function loadPlaybookForGoal(cwd: string, name: string): LoadedPlaybook {
  const map = loadPlaybooks(cwd);
  const pb = map.get(name);
  if (!pb) {
    const known = [...map.keys()].join(', ');
    throw new Error(`playbook '${name}' 不存在 (已知: ${known})`);
  }
  // 项目层优先(同名覆盖内置),与 loadPlaybooks 同源:项目层目录存在就当项目层。
  const projectDir = join(cwd, PROJECT_PLAYBOOK_DIR, name);
  // 与 load.ts A-2 一致:existsSync 真检查
  if (existsSync(projectDir)) {
    return { pb, root: projectDir, source: 'project' };
  }
  return { pb, root: join(BUILTIN_PLAYBOOK_DIR, name), source: 'builtin' };
}
