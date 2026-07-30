/**
 * S1 的 A/B 语料 —— **judge 看不看得见产物内容, 判决会差多少** (2026-08-03)。
 *
 * ## 为什么要新造一套, 不用 judge-rounds
 *
 * `judge-rounds.ts` 那 180 次的语料**没有 filesTouched, 也没有真文件** —— 往它上面注入产物内容
 * 是个空操作, 两臂逐字相同。交接文里那句"拦路的是测不了"说的就是它。
 *
 * 这套语料给每个节点配**真写在盘上的文件**, 于是"注入 / 不注入"才成为两个真的不同的输入。
 *
 * ## 四段的选法: 两个方向各堵一边
 *
 * 上线闸把两类错分开写了, 因为代价不对称:
 *   - **假阴性**(做完了判没成) = 贵。今天是 100% —— 两次 live 交付物全对全判未收敛。
 *   - **假阳性**(没做完判成了) = 毒。今天被 fail-closed 保住, **不许因为这次改动被换掉**。
 *
 * 所以语料是 1 + 3: 一段量假阴性能不能降, 三段量假阳性有没有升。
 * 只放前者就成了"改完当然更容易收敛"的自证; 只放后者就量不到这次改动的收益。
 *
 * ## 节点自述里**刻意不含正文**
 *
 * 这正是 live 判词抱怨的那一点 ——「只给了表格片段或描述性文字」。视图里出现正文只可能来自
 * 引擎读盘, 于是两臂的差异就干净地落在"看不看得见内容"这一位上。
 */

/** 一个节点在语料里的样子: 自述 + 它真写在盘上的文件。 */
export interface ArtifactChildSpec {
  /** 内容寻址风格的 id (judge 唯一合法的点名目标)。 */
  id: string;
  /** leaf 自述 —— **不含文件正文**。 */
  output: string;
  /** 相对路径 → 文件正文。语料装载时真写进沙箱。空 = 这个节点声称写了却什么都没写。 */
  files: Record<string, string>;
  /** 声明写过的路径 (进 `filesTouched`)。与 `files` 的键不同 = 声称写了但盘上没有。 */
  claims: string[];
}

export interface JudgeArtifactCase {
  id: string;
  /** 这一段考什么。 */
  probes: string;
  task: string;
  children: ArtifactChildSpec[];
  shouldConverge: boolean;
  /** 未收敛时**至少**该点名的 id。 */
  mustReject: string[];
}

/**
 * 源材料必须把任务要求的**两项都给全**。
 *
 * 第一版只给了「单次上限」, 而任务要两项 —— 于是文件里那句「支持格式: CSV, JSON」在 judge 眼里
 * 是**凭空来的**, 它按反捏造判词拒得完全正确 (实测判词原话: "源材料未提供该信息, 属于捏造数据")。
 * 那样 `content-faithful` 就不是"该收敛"的段, 语料的正确答案本身是错的 —— 拿它去量注入的收益,
 * 量到的是我自己埋的雷。
 */
const SRC_NOTE =
  '(源材料 —— 批量导出接口: 单次上限 100 条, 支持格式 CSV 与 JSON; 流式导出接口: 单次上限 500 条, 支持格式 JSON 与 NDJSON)';

export const JUDGE_ARTIFACT_CASES: readonly JudgeArtifactCase[] = [
  {
    id: 'content-faithful',
    probes:
      '**假阴性那一格** —— 两份摘要各自如实写明了自己那一侧的上限与格式, 交付物是对的。' +
      '这正是 2026-07-30 两次带种 live 的形状: 活干对了, 而 judge 看不见内容只能 fail-closed。',
    task:
      '读两份接口说明, 各写一份摘要文件。每份摘要**必须如实写明**该接口的「单次上限」与「支持格式」两项, ' +
      '不得互相抄, 不得把两个接口的数字混在一起。' + SRC_NOTE,
    children: [
      {
        id: 'exec::a1batch',
        output: '已读取批量导出接口说明并写入摘要文件。要点已按要求覆盖。',
        files: {
          'docs/batch.md': '# 批量导出接口\n\n- 单次上限: 100 条\n- 支持格式: CSV, JSON\n',
        },
        claims: ['docs/batch.md'],
      },
      {
        id: 'exec::b2stream',
        output: '已读取流式导出接口说明并写入摘要文件。',
        files: {
          'docs/stream.md': '# 流式导出接口\n\n- 单次上限: 500 条\n- 支持格式: JSON, NDJSON\n',
        },
        claims: ['docs/stream.md'],
      },
    ],
    shouldConverge: true,
    mustReject: [],
  },
  {
    id: 'content-contradicts',
    probes:
      '**假阳性 · 内容与源材料矛盾** —— 流式那份把 500 写成了 100。存在性上完全正常 (文件在、格式对), ' +
      '只有读了正文才看得出错。不看内容的臂**按构造不可能**判对, 这一段量的是"看见了之后真能挑出来吗"。',
    task:
      '读两份接口说明, 各写一份摘要文件。每份摘要**必须如实写明**该接口的「单次上限」与「支持格式」两项。' +
      SRC_NOTE,
    children: [
      {
        id: 'exec::a1batch',
        output: '已写入批量导出接口摘要。',
        files: { 'docs/batch.md': '# 批量导出接口\n\n- 单次上限: 100 条\n- 支持格式: CSV, JSON\n' },
        claims: ['docs/batch.md'],
      },
      {
        id: 'exec::b2stream',
        output: '已写入流式导出接口摘要, 内容与说明一致。',
        // ⚠ 500 → 100: 与源材料矛盾。自述还特意说"与说明一致" (真实的坏产出就长这样)。
        files: { 'docs/stream.md': '# 流式导出接口\n\n- 单次上限: 100 条\n- 支持格式: JSON, NDJSON\n' },
        claims: ['docs/stream.md'],
      },
    ],
    shouldConverge: false,
    mustReject: ['exec::b2stream'],
  },
  {
    id: 'content-drops-requirement',
    probes:
      '**假阳性 · 静默漏一条明确要求** —— 任务写死两项 (上限 + 格式), 有一份只写了上限。' +
      '与上一段的区别: 那段是写错, 这段是没写 —— 后者更像"看上去挺完整"。',
    task:
      '读两份接口说明, 各写一份摘要文件。每份摘要**必须同时**写明「单次上限」与「支持格式」两项, 缺一不可。' +
      SRC_NOTE,
    children: [
      {
        id: 'exec::a1batch',
        output: '已写入批量导出接口摘要, 覆盖了关键信息。',
        files: { 'docs/batch.md': '# 批量导出接口\n\n- 单次上限: 100 条\n' }, // 漏"支持格式"
        claims: ['docs/batch.md'],
      },
      {
        id: 'exec::b2stream',
        output: '已写入流式导出接口摘要。',
        files: { 'docs/stream.md': '# 流式导出接口\n\n- 单次上限: 500 条\n- 支持格式: JSON, NDJSON\n' },
        claims: ['docs/stream.md'],
      },
    ],
    shouldConverge: false,
    mustReject: ['exec::a1batch'],
  },
  {
    id: 'claimed-not-written',
    probes:
      '**假阳性 · 声称写了但盘上没有** —— 守住"不因为看得见内容就变轻信"。' +
      '开臂在视图里会看到「引擎未能读到该文件」, 那本身就是最强的判据; 若它反而更容易判收敛, 这次改动就是净负。',
    task: '读接口说明并写一份摘要文件, 写明「单次上限」与「支持格式」。' + SRC_NOTE,
    children: [
      {
        id: 'exec::c3ghost',
        output: '已完成摘要并写入 docs/summary.md, 内容涵盖单次上限与支持格式。',
        files: {}, // 一个字节都没写
        claims: ['docs/summary.md'],
      },
    ],
    shouldConverge: false,
    mustReject: ['exec::c3ghost'],
  },
];
