/**
 * omd-bench —— **用本仓自己的真 bug 当考题**(2026-08-05,owner 定向)。
 *
 * ## 为什么不追公开榜
 *
 * 2026 上半年公开 agent 评测集体塌方,证据不是一条而是一串:
 *
 * - **OpenAI 2026-02 停止上报 SWE-bench Verified 分数**,自承它不能衡量前沿编程能力;
 * - **UC Berkeley(Dawn Song 组)2026-04**:一个自动化攻击把当时 8 个最权威的 agent 评测
 *   (SWE-bench Verified / Pro、WebArena、Terminal-Bench)几乎全刷到满分,**一道题都没真解** ——
 *   靠的不是猜答案,是**评测器与被测 agent 同容器**,agent 往仓库根丢 `conftest.py`
 *   用 pytest hook 把判分改成全过;
 * - **ICSE 2026**:SWE-bench 判「通过」的补丁里 **7–8%** 拿完整开发者测试套件跑其实是功能错误
 *   (它只跑被改动过的那几个测试文件);
 * - SWE-bench Pro 上被标 CHEATED 的任务 **>12%**(利用 git history);
 * - METR:很多能过 SWE-bench 的 PR,放到真人 code review 下过不了。
 *
 * → **我们要的不是排名,是「这个编排在我们这个仓、这个具体缺陷上,是真修好了还是装作修好了」。**
 * 而本仓自己的 commit **天然在任何模型训练 cutoff 之后**,是干净、未泄露的考题。
 *
 * ## 一道题从哪来:**一个 fix commit 本身就是一道合格考题**
 *
 * 本仓的惯例是「实装与测试同一次改动一起提交」。于是对任一同时改了实现与测试的 commit `C`
 * (父提交 `P`),天然存在:
 *
 * ```
 *   世界 RED  = P 的实现  +  C 的测试   → 命令必须**失败**
 *   世界 GREEN= C 的实现  +  C 的测试   → 命令必须**成功**
 * ```
 *
 * 实测本仓近 600 个 commit:264 个同时改了实现与测试,79 个 subject 是修复,
 * 58 个是「1 实现 + 1 测试」的干净形状。**素材是先验证过才设计的**,不是设计完再找料。
 *
 * ## validation contract —— 三条同时成立才算一道合格考题
 *
 * 承 IssueBenchKit(MIT,`he-yufeng/IssueBenchKit`)提的那份「诚实合约」,它堵的正是
 * SWE-bench 那 7–8% 虚高的根子:
 *
 * 1. **打补丁前 FAIL** —— 证明这个测试**真的盯着这个 bug**,不是一个永远绿的摆设;
 * 2. **打补丁后 PASS** —— 证明补丁真的让它过了;
 * 3. **前后是同一条命令** —— 证明没有偷偷换一条更宽松的命令把它放过去。
 *
 * 三条任一不成立 → **这题不合格,当场拒,不进 suite**。
 *
 * 这与本仓早就有的两条做法是同一件事,只是这次落到 bench 上:
 * `src/harness/goal/acceptance.ts` 要求分类器给完验收命令**还得自己举一个已知错的样本**;
 * `src/eval/**.test.ts` 的反向自检惯例要求每条闸都证明「它真的会红」。
 *
 * ## 纯件纪律
 *
 * 本模块**零 IO、零 git、零子进程** —— 只有类型、判据与判定逻辑,
 * 好让「什么算合格考题」这件事本身可被单元测试逐条证伪(见 `task.test.ts`)。
 * 跑 git / 起 worktree / 执行命令在 `scripts/omd-bench.ts`。
 */

/** 一次命令执行的观测(谁跑的、跑出什么)。 */
export interface RunObservation {
  /** 逐字的命令串。**RED/GREEN 两次必须字节相同**,否则合约第 3 条不成立。 */
  command: string;
  exitCode: number;
  durationMs: number;
  /** stdout/stderr 尾部(留证:失败时要看得见判词,不是只看退出码)。 */
  tail: string;
}

/** 一道题(manifest)。可序列化,好归档、好 diff、好挂进 PR 当证据。 */
export interface BenchTask {
  id: string;
  /** 来源 commit(修复)与其父(有缺陷的世界)。 */
  fixSha: string;
  baseSha: string;
  /** commit subject —— 它就是这道题的「issue 描述」。 */
  title: string;
  /** 交给被测方看的题面(不含答案)。 */
  statement: string;
  /** 实现文件:被测方**可以改**的路径。 */
  implPaths: string[];
  /** 测试文件:**受保护路径,被测方不许动**。判分前核对字节未变。 */
  testPaths: string[];
  /** 判分命令(RED/GREEN 同一条)。 */
  command: string;
}

/** 建题时跑出来的两个世界的读数。 */
export interface ContractEvidence {
  red: RunObservation;
  green: RunObservation;
}

export type ContractFailure =
  | 'red-not-failing'
  | 'red-did-not-execute'
  | 'green-not-passing'
  | 'command-mismatch';

/**
 * 从 bun test 的输出尾部解析「几个过、几个败、几个 error」。
 *
 * ⚠ **`error` 与 `fail` 是两件事,而这道题的成败全在这个区分上**:
 * `error` = 测试文件**根本没加载起来**(模块不存在 / 符号没导出 / 语法错);
 * `fail`  = 测试跑起来了、断言真的没过。
 *
 * 实测:拿一个「新增功能」的 commit 建题,父提交上的 RED 是
 * `SyntaxError: Export named 'X' not found`(`0 pass / 1 fail / 1 error`)——
 * 退出码确实非 0,**但它只证明了"那时候还没这个符号",完全没证明"这测试抓得住这个缺陷"**。
 * 拿它当合格考题,就是在复制 SWE-bench 那 7–8% 虚高的机制。
 */
export interface TestSummary {
  pass: number;
  fail: number;
  errors: number;
  /** 解析不出来(输出被截断/换了 runner)→ 全 null。**不许默认成 0**(NULL ≠ 0)。 */
  parsed: boolean;
}

export function parseBunTestSummary(tail: string): TestSummary {
  const num = (re: RegExp): number | null => {
    const m = tail.match(re);
    return m ? Number(m[1]) : null;
  };
  const pass = num(/^\s*(\d+)\s+pass\b/m);
  const fail = num(/^\s*(\d+)\s+fail\b/m);
  if (pass === null && fail === null) return { pass: 0, fail: 0, errors: 0, parsed: false };
  const errors = num(/^\s*(\d+)\s+error\b/m) ?? (/Unhandled error|SyntaxError|Cannot find module|error: /.test(tail) ? 1 : 0);
  return { pass: pass ?? 0, fail: fail ?? 0, errors, parsed: true };
}

/**
 * RED 是不是一次**真的执行了并且断言失败**(而不是"加载失败")。
 * 解析不出来时返回 `null` = **不知道**,由调用方决定怎么处置(别默默当成 true)。
 */
export function redDidExecute(tail: string): boolean | null {
  const s = parseBunTestSummary(tail);
  if (!s.parsed) return null;
  return s.errors === 0 && s.fail >= 1;
}

export interface ContractVerdict {
  ok: boolean;
  failures: ContractFailure[];
  /** 人话判词 —— 拒一道题时必须说清楚拒在哪条上。 */
  reason: string;
}

const EXPLAIN: Record<ContractFailure, string> = {
  'red-not-failing':
    '打补丁前测试**没有失败** → 这个测试根本没盯着这个 bug(可能是个永远绿的摆设)。' +
    '这正是 SWE-bench 那 7–8% 虚高的根子。',
  'red-did-not-execute':
    '打补丁前测试**没跑起来就报错了**(模块不存在 / 符号未导出 / 语法错), 不是断言失败。' +
    '退出码确实非 0, 但它只证明「那时候还没这个符号」, **没证明这测试抓得住这个缺陷** —— ' +
    '典型来源是拿「新增功能」的 commit 当题。要的是**真 bug**:实现当时就在, 只是行为错。',
  'green-not-passing':
    '打补丁后测试**没有通过** → 要么任务提取错了(改动不止这些文件), 要么环境不干净。',
  'command-mismatch':
    'RED 与 GREEN 跑的**不是同一条命令** → 无法排除「换了条更宽松的命令把它放过去」。',
};

/**
 * 判一道题合不合格。**三条全过才算合格**,任一不过当场拒。
 *
 * ⚠ 判据刻意写成纯函数:它是这套 bench 的地基,而一条永远判「合格」的合约
 * 比没有合约更坏 —— 它让整条链看起来已被验证。三格反向自检见 `task.test.ts`。
 */
export function judgeContract(ev: ContractEvidence): ContractVerdict {
  const failures: ContractFailure[] = [];
  if (ev.red.exitCode === 0) failures.push('red-not-failing');
  else if (redDidExecute(ev.red.tail) !== true) {
    // 只在"确实红了"之后才追问"红得对不对"。解析不出来(null)也算不过 ——
    // **fail-closed**:证不出它是真断言失败,就不收这道题(题库宁缺毋滥)。
    failures.push('red-did-not-execute');
  }
  if (ev.green.exitCode !== 0) failures.push('green-not-passing');
  if (ev.red.command !== ev.green.command) failures.push('command-mismatch');
  const s = parseBunTestSummary(ev.red.tail);
  return {
    ok: failures.length === 0,
    failures,
    reason: failures.length === 0
      ? `合格:RED ${s.pass} pass / ${s.fail} fail / 0 error(**断言真的失败**)→ GREEN exit 0,同一条命令 \`${ev.red.command}\``
      : failures.map((f) => `${f}: ${EXPLAIN[f]}`).join('\n'),
  };
}

// ── 判分(一次候选提交的评分)────────────────────────────────────────────────

/** 一次候选(人改的 / 某个臂改的)在一道题上的判分输入。 */
export interface ScoreInput {
  task: BenchTask;
  /** 候选跑出来的观测。 */
  run: RunObservation;
  /**
   * **受保护测试路径是否被改动**(逐路径)。true = 被改了。
   * 这是防 reward-hacking 的那道闸 —— Berkeley 那个攻击的本质就是「去改判分的东西」。
   */
  protectedPathsTouched: string[];
  /**
   * 全量回归是否仍绿。`null` = **没跑**(不是「跑了且绿」)。
   * NULL ≠ true ≠ false:没跑就该显示没跑,别让缺席读成通过(仓规第一条)。
   */
  regressionGreen: boolean | null;
}

export type ScoreVerdict = 'pass' | 'fail' | 'invalid';

export interface ScoreResult {
  verdict: ScoreVerdict;
  reason: string;
}

/**
 * 判一次候选。
 *
 * **顺序有意义**:先判作弊(改了受保护测试),再判对错。
 * 一个把测试改绿的候选不是「通过」也不是「失败」,是 **invalid** ——
 * 把它记成 fail 会让人以为它只是能力不够,而它其实是在攻击judge。
 */
export function scoreCandidate(input: ScoreInput): ScoreResult {
  if (input.protectedPathsTouched.length > 0) {
    return {
      verdict: 'invalid',
      reason:
        `候选改动了受保护的测试路径: ${input.protectedPathsTouched.join(', ')} —— ` +
        '判分对象被改了, 这一跑作废(不是 fail, 是 invalid)。',
    };
  }
  if (input.run.command !== input.task.command) {
    return {
      verdict: 'invalid',
      reason: `候选跑的命令与题目不符:\n  题目 \`${input.task.command}\`\n  实跑 \`${input.run.command}\``,
    };
  }
  if (input.run.exitCode !== 0) {
    return { verdict: 'fail', reason: `任务命令 exit ${input.run.exitCode}` };
  }
  if (input.regressionGreen === false) {
    return { verdict: 'fail', reason: '任务命令过了, 但**全量回归红了** —— 修 A 坏 B 不算修好。' };
  }
  return {
    verdict: 'pass',
    reason: input.regressionGreen === null
      ? '任务命令通过。⚠ 全量回归**未跑** —— 这一跑只证明了局部, 没证明没坏别处。'
      : '任务命令通过, 且全量回归仍绿。',
  };
}

// ── 汇总指标 ────────────────────────────────────────────────────────────────

/**
 * `pass@k` 与 `pass^k`。
 *
 * 两个都要报,而且**它们的 gap 才是最值钱的读数**:
 * gap 大 = 靠运气(有时能做对但路径不稳定);gap 小 = 决策路径稳定收敛。
 * 承 Anthropic《Demystifying evals for AI agents》与 Claw-Eval 的 `Pass-all-k`;
 * 本仓交接 23 也独立撞到同一件事(同题重复三次,一半会换结论)。
 *
 * ⚠ `invalid` **不计入分母**,单独报 —— 把作弊跑记成失败会让作弊率消失在通过率里。
 */
export interface TrialTally {
  pass: number;
  fail: number;
  invalid: number;
}

export function tallyTrials(results: readonly ScoreResult[]): TrialTally {
  return {
    pass: results.filter((r) => r.verdict === 'pass').length,
    fail: results.filter((r) => r.verdict === 'fail').length,
    invalid: results.filter((r) => r.verdict === 'invalid').length,
  };
}

/** k 次尝试至少一次成功。分母 = 有效试次(pass+fail)。 */
export function passAtK(t: TrialTally): number {
  const n = t.pass + t.fail;
  return n === 0 ? Number.NaN : t.pass > 0 ? 1 : 0;
}

/** k 次尝试**全部**成功。面向用户的可靠性看这个。 */
export function passHatK(t: TrialTally): number {
  const n = t.pass + t.fail;
  return n === 0 ? Number.NaN : t.pass === n ? 1 : 0;
}
