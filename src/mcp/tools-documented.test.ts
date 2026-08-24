/**
 * **源码级闸: 注册了的 MCP 工具必须在 `docs/guide/mcp-tools.md` 里出现** (2026-08-01)。
 *
 * ## 起因
 * 改 `dag_rule` / `dag_triage` 时顺手一查, 发现对外工具表里**整个 owner 收件箱都没有** ——
 * `dag_triage`(看)· `dag_rule`(裁)· `dag_goal`(自主目标环)· `dag_cancel` 四条全缺。
 * 其中 `dag_goal` 是这台引擎最重的一个入口。
 *
 * 工具表是**对外接口的清单**: 缺了的那条不是"文档不全", 是**调用方根本不知道它存在**。
 * 而这个缺口没有任何红灯 —— 工具照常注册、照常能调, 只是没人知道。
 *
 * ## 判据是"名字在文档里出现过", 不是"有自己的一行"
 * 这份文档把同族工具写在合并行上(`` `omd_set_key` · `omd_set_model` · `omd_set_role` ``),
 * 那是**刻意的排版**(一屏能读完), 不该为了过闸拆开。所以只查名字出现过没有。
 * (第一版按行首匹配, 于是把 9 个写在合并行上的工具误判成缺失 —— 差点补出 9 行重复。)
 *
 * ## 2026-08-02 补第二条: 连 README 徽章上的数字一起守
 *
 * 上面那条只管"每个工具都被提到", **不管数**。于是两份 README 顶部的徽章长期写着
 * `MCP server: 33 tools`, 而真实注册面已经是 **39** —— 文档表是全的, 闸是绿的,
 * 只有读者在正门看到一个错数字, 六个工具凭空消失。
 *
 * 徽章是**读者见到的第一个数**, 却是全仓最没人维护的那个: 加工具时要改 `assemble.ts` +
 * `docs/guide/mcp-tools.md` + 两份 README × 每份两处(alt 文字 + URL)。**人记不住五处, 让测试记。**
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_RENAMES } from './tool-renames';

const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * 真实注册面 = 源码字面量经 TOOL_RENAMES 映射(新名)∪ 表内旧名(deprecated alias 仍注册)。
 * 与 assemble 出口的 applyToolRenames 用**同一张表**做同一变换 —— 闸和装配不可能各说各话。
 * (2026-08-04 t7: 装配层改名后, 只数字面量的闸会对新名 solve/run/map_* 视而不见。)
 */
function registeredNames(sourceNames: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const n of sourceNames) {
    const renamed = TOOL_RENAMES[n];
    out.add(renamed ?? n);
    if (renamed) out.add(n); // 旧名以 alias 身份仍在注册面上
  }
  return out;
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('MCP 工具表完整性', () => {
  test('每个注册的工具名都在 docs/guide/mcp-tools.md 里出现', () => {
    const names = new Set<string>();
    for (const f of tsFiles(join(ROOT, 'src', 'mcp'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/name:\s*'((?:dag|omd|path|map|memory|dream|conductor)_[a-z_]+)'/g)) {
        names.add(m[1]!);
      }
    }
    expect(names.size).toBeGreaterThan(30); // 抓不到名字说明正则漂了, 而不是"工具变少了"
    const registered = registeredNames(names);

    const doc = readFileSync(join(ROOT, 'docs', 'guide', 'mcp-tools.md'), 'utf8');
    const missing = [...registered].filter((n) => !doc.includes(`\`${n}\``)).sort();
    expect(
      missing.length === 0
        ? ''
        : `以下工具已注册但不在 docs/guide/mcp-tools.md 里 —— 调用方无从知道它存在:\n  ${missing.join('\n  ')}`,
    ).toBe('');
  });

  // ── 徽章数闸已退役 (2026-08-24, owner 裁) ───────────────────────────────────
  // 它守的是两份 README 顶部 `MCP server: N tools` 徽章里的数字。`7deb88c4` 把 README
  // 按 opencode / pi 的写法重写之后, **那个徽章不存在了** —— 闸于是每趟都报
  // 「找不到工具数徽章」, 而它要盯的东西已经没了。
  //
  // 退役而不是修复的理由: 那个数字是**读者见到的第一个数, 也是最容易过期的一个**,
  // 而新 README 是给人读的定位文档, 不是接口清单。真要盯注册面, 上面那条
  // 「每个注册的工具名都在 docs/guide/mcp-tools.md 里出现」还在守, 且
  // `src/mcp/capability-matrix.test.ts` 直接拿 TS AST 对账真实 inputSchema ——
  // 比数一个手写数字强。**这一条被删掉之后没有覆盖缺口。**
});
