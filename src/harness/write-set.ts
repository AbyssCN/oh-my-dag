// D-2 (SDD cairness-distill 2026-08-10): ex-ante 写集声明 + 跑后 diff 对账 (孤儿检测)。
// 纯函数判定器, 零 LLM / 零 IO —— 输入面 (diff 收集、声明构造) 由装配层 (run-goal.ts 的
// writeSet 注入面) 或测试注入。判定器只答一件事: 每个 diff 文件归属谁。
//
// 归属阶梯 (照 cc-deps 四段式, deps.py:405-410 语义):
//   ① + ③ 在跑节点的声明命中 —— 命中 1 个 = node-owned (① 自身治理产物与 ③ 他节点声明
//            同一种归属, declaredBy 列出命中者); 命中 >1 = ambiguous (G-3 第三子句, 告警不红)
//   ② 全局豁免清单 (globalExempt) —— 装配层静态给的仓级豁免
//   ④ 显式 intentional 例外表 —— 装配层静态给的本次例外
//   ⑤ 都不中 = orphan 红 (INV-3: 「声明了 A 却改了 B」与「无任何归属」是仅有的两种红)
//
// G-4 (已完成节点不再授权后续改动) 由构造保证: 只有 activeNodeIds 里的节点声明参与 ①+③,
// 历史 run 的声明根本不进输入 —— 判定器不猜"谁还在跑", 谁不在 active 谁就不授权。
// 三面对账的第三面 (touch ledger 过程事件) 由有 ledger 句柄的装配层经同一 attributeWriteSet
// 的声明面承接 —— 本模块不持句柄, 不发明平行账本。
//   确定序 (不回溯): ①③ 声明命中 → ② 全局豁免 → ④ intentional → ⑤ orphan。
//   豁免/例外只兜无主文件 —— 声明了 A 却改 A 永远不算越界 (阶梯序测试钉死这条)。
//
// ── 声明写集面 (S-2) ──────────────────────────────────────────────
// 本模块同时承载本 SDD run 自己的声明写集 (SDD_DECLARED_WRITE_SET, 见尾部):
// 允许 src/harness/** · docs/silent-failures.md · 本 run 报告文件 (精确文件名,
// 不开放 docs/plan/** 通配 —— R-3 报告文件名显式互异, 通配即与并发 run 报告面相撞);
// 显式禁写 src/model/** · src/eval/** (并发 run C/A 的写集面)。判定序确定且
// fail-closed: forbidden → allowed → outside。run 级写面与节点级归属阶梯正交:
// 节点声明裁「谁写的」, 声明写集裁「该不该写」。
export type WriteSetKind = 'node-owned' | 'ambiguous' | 'global-exempt' | 'intentional' | 'orphan';

export interface WriteSetDeclaration {
  nodeId: string;
  /** 节点预期写入的相对路径清单 (plan 节点可选 `write_set` 字段, conductor-plan.ts)。 */
  files: string[];
  /** 节点收尾状态 —— 只作报告信息; 授权与否只看 activeNodeIds (G-4)。 */
  status: 'done' | 'failed' | 'skipped';
}

export interface WriteSetFileAttribution {
  file: string;
  kind: WriteSetKind;
  /** node-owned / ambiguous 时的命中节点 (命中 >1 = ambiguous)。 */
  declaredBy?: string[];
}

export interface WriteSetReport {
  /** undeclared = 整 run 无节点声明写集 (INV-3: 声明缺席 ≠ 违规, NULL≠0 —— O-1 读数)。 */
  verdict: 'undeclared' | 'reconciled';
  /** 红 = 存在 orphan —— 非零退出码语义, 与引擎回归分开报 (INV-4)。ambiguous 不红 (有归属)。 */
  red: boolean;
  /** 走完阶梯无归属的文件 (INV-1 可定位证据: 逐文件点名)。 */
  orphans: string[];
  /** 命中 >1 个在跑节点声明的文件 (记 ambiguous 并告警, G-3 第三子句)。 */
  ambiguous: string[];
  /** 每个 diff 文件的归属裁决 (declaredBy 带节点名, INV-1 证据面)。 */
  files: WriteSetFileAttribution[];
  /** 参与对账的声明节点数 (O-1 声明覆盖率读数; 0 = undeclared)。 */
  declaredNodes: number;
}

export function attributeWriteSet(opts: {
  /** 跑后 git 工作树改动 (相对路径, 含未跟踪)。 */
  diffFiles: string[];
  /** 本 run 所有节点的写集声明 (含没跑的 —— 授权与否由 activeNodeIds 裁)。 */
  declarations: WriteSetDeclaration[];
  /** 在跑节点 id 集合: 不在其中的节点声明不授权任何 diff (G-4, deps.py:405-410 语义)。 */
  activeNodeIds: string[];
  /** 阶梯 ②: 仓级全局豁免 (装配层静态清单)。 */
  globalExempt?: string[];
  /** 阶梯 ④: 显式 intentional 例外表 (装配层静态清单)。 */
  intentional?: string[];
}): WriteSetReport {
  const { diffFiles, declarations, activeNodeIds } = opts;
  const globalExempt = opts.globalExempt ?? [];
  const intentional = opts.intentional ?? [];
  const active = new Set(activeNodeIds);
  // G-4: 声明只在节点在跑时授权。历史 run / 本轮没跑的节点声明一律不参与阶梯 ——
  // 「已完成节点不再授权后续改动」是构造保证, 不是运行时豁免判断 (豁免判断会被绕过)。
  const activeDecls = declarations.filter((d) => active.has(d.nodeId));
  if (activeDecls.length === 0) {
    // INV-3: 没进对账契约就不判违规 —— undeclared 是读数 (O-1), 不是红。
    return { verdict: 'undeclared', red: false, orphans: [], ambiguous: [], files: [], declaredNodes: 0 };
  }
  const declaredBy = new Map<string, string[]>();
  for (const d of activeDecls) {
    for (const f of d.files) {
      const hitters = declaredBy.get(f) ?? [];
      hitters.push(d.nodeId);
      declaredBy.set(f, hitters);
    }
  }
  const orphans: string[] = [];
  const ambiguous: string[] = [];
  const files: WriteSetFileAttribution[] = diffFiles.map((file) => {
    const hitters = declaredBy.get(file);
    if (hitters && hitters.length === 1) {
      return { file, kind: 'node-owned', declaredBy: hitters };
    }
    if (hitters && hitters.length > 1) {
      ambiguous.push(file);
      return { file, kind: 'ambiguous', declaredBy: hitters };
    }
    if (globalExempt.includes(file)) return { file, kind: 'global-exempt' };
    if (intentional.includes(file)) return { file, kind: 'intentional' };
    orphans.push(file);
    return { file, kind: 'orphan' };
  });
  return {
    verdict: 'reconciled',
    red: orphans.length > 0,
    orphans,
    ambiguous,
    files,
    declaredNodes: activeDecls.length,
  };
}

/** 一行人可读摘要 (挂 goal 引擎 summary 行; 红时点名越界文件, INV-1 不吞证据)。 */
export function describeWriteSet(r: WriteSetReport): string {
  if (r.verdict === 'undeclared') return '未声明';
  if (r.red) return `写集越界 ${r.orphans.length} [${r.orphans.join(', ')}]`;
  if (r.ambiguous.length > 0) return `归属歧义 ${r.ambiguous.length} [${r.ambiguous.join(', ')}]`;
  return '无越界';
}

export interface DeclaredWriteSet {
  /** 允许写的相对路径: 精确路径或 glob (`**` 跨目录, `*` 不跨 `/`)。 */
  allowed: string[];
  /** 显式禁写的相对路径/glob —— 命中即越界, 不因同时命中 allowed 而放行。 */
  forbidden: string[];
}

/** 本 SDD run 的报告文件 (R-3: 报告文件名显式互异 —— S-2 不相交判据的精确锚)。 */
export const SDD_REPORT_FILE = 'docs/plan/2026-08-10-cairness-distill-report.md';

/**
 * 本 SDD run 的完整声明写集 (docs/plan/2026-08-10-concurrent-sdd-execute-test.md
 * 「预期写集(声明)」run B): src/harness/** + docs/silent-failures.md + 本 run 报告。
 * forbidden = 并发 run 的写集面 (A: src/eval/**, C: src/model/**) —— 最小权限,
 * 禁写面与允许面设计上不相交; 撞禁写面 = 并发越界样本 (S-2 喂 D-2 orphan 语料)。
 */
export const SDD_DECLARED_WRITE_SET: DeclaredWriteSet = {
  allowed: ['src/harness/**', 'docs/silent-failures.md', SDD_REPORT_FILE],
  forbidden: ['src/model/**', 'src/eval/**'],
};

export type WriteScopeKind = 'allowed' | 'forbidden' | 'outside';

/** 简易 glob → RegExp (`*` 不跨 `/`, `**` 跨, `?` 单字符; `**` 后跟 `/` 匹配零层目录)。同 agent-tools.ts:178 语义。 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` 也匹配零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

/**
 * 声明写集判定 (S-2 判据面): 逐文件裁 allowed / forbidden / outside。
 * 确定序 (fail-closed, 最小权限): forbidden 先查 → allowed → outside, 命中即裁不回溯。
 * outside = 既不在允许面也不在禁写面 (如 docs/plan/ 下并发 run 的报告) ——
 * 非本 run 声明面, 消费方按 INV-3 记读数 (声明缺席 ≠ 违规), 不冒充「零越界」。
 */
export function classifyWriteScope(file: string, ws: DeclaredWriteSet = SDD_DECLARED_WRITE_SET): WriteScopeKind {
  if (ws.forbidden.some((g) => globToRegExp(g).test(file))) return 'forbidden';
  if (ws.allowed.some((g) => globToRegExp(g).test(file))) return 'allowed';
  return 'outside';
}
