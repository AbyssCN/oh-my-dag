/**
 * src/harness/goal/delta-compare —— D-1 mode 感知基线 delta 比对
 * (蒸馏自 Cairness cc-delta-check 的分类矩阵, SDD
 *  docs/plan/2026-08-10-cairness-distill-comparison.md)。
 *
 * 为什么: CLAUDE.md「老 N 段 + 新增段分开写」此前只是记法纪律 —— 回归只数总数时,
 * 新引入失败混在老失败里没人分得开 (silent-failures S-28)。这个闸把前后两份验收报告
 * 逐 step 比对, 只把「**新引入**失败」判红, 零 LLM 成本 (INV-1)。
 *
 * 契约 (G-1 / G-2):
 *   - 两份 full 报告, 一步 pass→fail → 判 new-failure, 闸红 (退出码非零)。
 *   - before 为 changed-only 且某步缺席 → 判 skipped, 不判 new-failure (基线没跑那步,
 *     不能说是本次引入的失败)。
 *   - after 新出现的步 → 判 newly-run, 不判 fixed (基线里没有它, 谈不上"修好")。
 *   - 两份完全相同的 full 报告 → 零 new-failure, 不红 (退出码 0)。
 *
 * mode 语义 (`full | changed-only`): 只有两侧都 full 时「before 有而 after 缺席」才算
 * 覆盖回退 —— before=pass → new-failure (fail-closed: 没被证明过就不算成); before=fail →
 * skipped (老失败消失了, 无法区分"修好"与"没跑", 不冒充 fixed)。任何一侧 changed-only 时
 * 缺席一律 skipped —— 那份报告本来就没枚举全部 step。
 *
 * 六档分类: new-failure (红) / fixed / unchanged-failure / new-warning / newly-run / skipped。
 * pass→pass = 零 delta, 不进 steps 但计入 total (报告里仍有这一步, 只是没变化)。
 * 老失败 (unchanged-failure) 单列不红 —— INV-4: 老段/新增段分开, 不与引擎回归混算。
 */
export type VerifyStepStatus = 'pass' | 'fail' | 'warning';

/** 报告模式: full = 枚举了全部 step; changed-only = 只列有变化的 step。 */
export type VerifyReportMode = 'full' | 'changed-only';

export interface VerifyStep {
  id: string;
  status: VerifyStepStatus;
}

export interface VerifyReport {
  mode: VerifyReportMode;
  steps: VerifyStep[];
}

export type DeltaStepKind =
  | 'new-failure'
  | 'fixed'
  | 'unchanged-failure'
  | 'new-warning'
  | 'newly-run'
  | 'skipped';

export interface DeltaStep {
  id: string;
  kind: DeltaStepKind;
  /** 该步在基线里的状态 (缺席 = undefined)。 */
  before?: VerifyStepStatus;
  /** 该步在跑后实判里的状态 (缺席 = undefined)。 */
  after?: VerifyStepStatus;
}

export interface DeltaReport {
  /**
   * 闸红 = 本次跑批**新引入**了失败 (非零退出码语义, INV-1)。老失败 / 新步 / skipped
   * 都不红 —— 红的语义是"这批跑得比基线差", 不是"这批有失败"。
   */
  red: boolean;
  /** 新引入失败的 step id (红的原因, 可定位证据)。 */
  newFailures: string[];
  /** 有实际变化的 step (pass→pass 不进; skipped 也进 —— 缺席也要看得见)。 */
  steps: DeltaStep[];
  /** 比对的 step 总数 (两侧并集; 含零 delta 的步)。 */
  total: number;
}

/** 逐步分类: id 并集, 先按 before 顺序、再按 after 新增顺序。 */
function classifySteps(before: VerifyReport, after: VerifyReport): { steps: DeltaStep[]; newFailures: string[] } {
  const afterById = new Map(after.steps.map((s) => [s.id, s]));
  const steps: DeltaStep[] = [];
  const newFailures: string[] = [];
  const seen = new Set<string>();
  const emit = (id: string, kind: DeltaStepKind, b?: VerifyStepStatus, a?: VerifyStepStatus): void => {
    steps.push({ id, kind, ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) });
    if (kind === 'new-failure') newFailures.push(id);
  };
  // 两侧都有 → 状态转移矩阵; 一侧缺席 → 按 mode 语义裁。
  for (const step of before.steps) {
    seen.add(step.id);
    const a = afterById.get(step.id);
    if (a) {
      if (a.status === step.status) {
        if (a.status === 'fail') emit(step.id, 'unchanged-failure', step.status, a.status); // 老失败单列不红 (INV-4)
        continue; // pass→pass / warning→warning = 零 delta, 不进 steps 但计入 total
      }
      if (a.status === 'fail') emit(step.id, 'new-failure', step.status, a.status); // pass→fail / warning→fail
      else if (step.status === 'fail') emit(step.id, 'fixed', step.status, a.status); // fail→pass / fail→warning
      else emit(step.id, 'new-warning', step.status, a.status); // pass→warning (warning→pass 是改善, 六档外)
    } else if (before.mode === 'full' && after.mode === 'full') {
      // 覆盖回退: full 基线里有的步, 跑后没跑。fail-closed —— pass 没了 = 新失败; 老失败消失不可证 fixed。
      if (step.status === 'pass') emit(step.id, 'new-failure', step.status);
      else emit(step.id, 'skipped', step.status);
    } else {
      emit(step.id, 'skipped', step.status); // changed-only 侧缺席无法比对, 不冒充结论
    }
  }
  for (const step of after.steps) {
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    // after 新出现的步: before full 时它基线里真不存在 → newly-run (不判 fixed, 基线没它);
    // before changed-only 时基线可能漏了它 → skipped (G-1 第二子句: 不判 new-failure)。
    emit(step.id, before.mode === 'full' ? 'newly-run' : 'skipped', undefined, step.status);
  }
  return { steps, newFailures };
}

/**
 * 前后两份验收报告 → delta 报告。纯函数, 无副作用, 判据全在输入里。
 * 调用方负责产基线 (批前同 runner 跑一次) 与 after 侧 (实判); 本函数不碰 runner / 文件。
 */
export function compareVerifyReports(before: VerifyReport, after: VerifyReport): DeltaReport {
  const { steps, newFailures } = classifySteps(before, after);
  return { red: newFailures.length > 0, newFailures, steps, total: new Set([...before.steps, ...after.steps].map((s) => s.id)).size };
}

/** 一行人可读摘要 (进 run-goal 的 execute stage summary; 红 = 点名新失败, 零 delta = 无变化)。 */
export function summarizeDelta(r: DeltaReport): string {
  if (r.newFailures.length > 0) return `新增失败 ${r.newFailures.length} [${r.newFailures.join(', ')}]`;
  if (r.steps.length === 0) return '无变化';
  return `未新增失败 · ${r.steps.length} 步变更`;
}
