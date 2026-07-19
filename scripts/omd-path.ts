#!/usr/bin/env bun
/**
 * scripts/omd-path —— pathfinder 地图 CLI (组件 10, D-1 `omd path`)。
 *
 * 无参:            列本 repo 的开放地图 (docs/plan/pathfinder/*.md), 每张显示目的地 + open/frontier 计数。
 * <destination>:   建或续 (resume) 一张地图 (slug 已存在则 resume)。
 * --help / -h:     打印用法, exit 0。**无需任何 env / API key** (纯 map-store 文件操作, 不碰模型层)。
 *
 * 逻辑蒸到纯函数 runOmdPath(argv, {cwd, out}) 便于无盘单测 (注入 tmp cwd + 收集 out)。
 * 顶层仅在 import.meta.main 时用 process.cwd() 驱动它。
 */
import { computeFrontier } from '../src/harness/pathfinder/frontier';
import { createOrResumeMap, summarizeOpenMaps } from '../src/harness/pathfinder-extension';
import { m } from '../src/harness/i18n';

export const OMD_PATH_USAGE = m({
  en: 'usage: bun run scripts/omd-path.ts [<destination>]\n  (no arg)       list this repo\'s open pathfinder maps\n  <destination>  create or resume a map at docs/plan/pathfinder/<slug>.md\n  --help, -h     print this usage',
  zh: '用法: bun run scripts/omd-path.ts [<目的地>]\n  (无参)         列本 repo 的开放 pathfinder 地图\n  <目的地>       在 docs/plan/pathfinder/<slug>.md 建或续一张地图\n  --help, -h     打印用法',
});

export interface OmdPathOpts {
  /** repo 根 (地图扫描/落盘基准)。测试注入临时 cwd。 */
  cwd: string;
  /** 输出汇 (默认 console.log)。测试注入收集器。 */
  out?: (line: string) => void;
}

/** CLI 核心 (纯逻辑, 返回 exit code)。 */
export function runOmdPath(argv: string[], opts: OmdPathOpts): number {
  const out = opts.out ?? ((s: string) => console.log(s));
  if (argv.includes('--help') || argv.includes('-h')) {
    out(OMD_PATH_USAGE);
    return 0;
  }
  const destination = argv.filter((a) => !a.startsWith('-')).join(' ').trim();

  // 无参 → 列开放地图。
  if (!destination) {
    const maps = summarizeOpenMaps(opts.cwd);
    if (maps.length === 0) {
      out(m({ en: 'No open maps. Create one: omd path <destination>', zh: '无开放地图。新建一张: omd path <目的地>' }));
      return 0;
    }
    out(m({ en: `Open maps (${maps.length}):`, zh: `开放地图 (${maps.length}):` }));
    for (const mm of maps) {
      out(`  • ${mm.slug}: ${mm.destination} (${mm.openCount} open, ${mm.frontierCount} frontier)`);
    }
    return 0;
  }

  // 有参 → 建/续。
  const { map, created } = createOrResumeMap(opts.cwd, destination);
  const frontier = computeFrontier(map).length;
  out(
    created
      ? m({ en: `Created map "${map.slug}" → ${map.destination}`, zh: `已新建地图 "${map.slug}" → ${map.destination}` })
      : m({ en: `Resumed map "${map.slug}" → ${map.destination} (${frontier} frontier)`, zh: `已续上地图 "${map.slug}" → ${map.destination} (${frontier} 前沿)` }),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(runOmdPath(process.argv.slice(2), { cwd: process.cwd() }));
}
