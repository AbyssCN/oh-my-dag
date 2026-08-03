/**
 * goal/acceptance —— **D-I 验收分型** (2026-07-29, owner 拍板)。
 *
 * classify 这一站的问题换了: 从「要不要 research」改成「**这个目标的验收方式是哪一种**」。
 *
 * 为什么这是最该先问的一句: 自主环最重要的死法不是"做不出来", 是**作弊达标** —— 执行体把
 * 判据本身改到自己够得着的地方 (放宽断言 / skip 掉红的 / mock 掉被测逻辑 / 干脆删测试),
 * 然后诚实地报告"绿了"。防它的唯一办法是**在动手之前就把判卷标准冻结下来**, 且冻结的东西
 * 必须是执行体改不动的: 一条**别人来跑**的命令。
 *
 * 于是分两型, 两条完全不同的路:
 *
 * - **执行型 (executable)** —— 成败机器可判。**必须**产出一条可跑的验收命令 (`command`)。
 *   这条命令进 spec 的判卷标准段、进 execute 的任务文本, 最终落成图里一个 `executor:'command'`
 *   节点。它必须**当场就判定跑得起来** (过 command-leaf 的 fail-closed 闸) —— 规划期说能跑、
 *   执行期被闸拒 = 「假红」: 一个合法验证步被拦下, 看起来却像测试失败。
 *
 * - **探索型 (exploratory)** —— 成败机器判不了 (选型 / 摸清一个领域 / 找出有哪些坑)。
 *   既然判不了成败, 就**不许假装能判**。换成两样东西: **学习目标** (学到什么才算没白跑) +
 *   **可承受损失** (愿意为它花掉多少)。后者是探索型唯一的硬边界 —— 判不了对错时, 能定的
 *   只有亏损上限。
 *
 * ⚠ 分型 ≠ 轻重路由。`GoalTier` (simple/complex) 问的是"要不要先查外部事实/先定契约", 是**成本**轴;
 * 验收分型问的是"怎么判成没成", 是**判据**轴。两条轴此前混在一句 prompt 里 (旧分类器的 simple
 * 描述同时含"做法已确定"与"验收可机器判") —— 一个做法未定但验收可机器判的目标, 在旧口径下无处安放。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULT_COMMAND_ALLOWLIST, commandBlockReason, createCommandLeafRunner } from '../command-leaf';
import { logger } from '../logger';
import type { GenerateFn } from '../executor-dag-types';

/** D-5 轻重路由 (成本轴): simple = 直接 Execute→Verify; complex = 全 research→spec→execute。 */
export type GoalTier = 'simple' | 'complex';

/**
 * D-I 验收分型 (判据轴)。判别联合而非"一堆可选字段" —— 可选字段版会长成又一个空旋钮:
 * 声明面写着 command?, 谁也不保证它在。
 */
export type AcceptanceSpec =
  | {
      kind: 'executable';
      /** 别人来跑的验收命令。已过 {@link isRunnableAcceptanceCommand}。 */
      command: string;
      /** 期望退出码 (D-K)。verify-green 是 0; 冻结判据时一并记, 免得后面被改。 */
      expectExit: number;
    }
  | {
      kind: 'exploratory';
      /** 学到什么才算这次没白跑 (判不了成败, 至少判得了"有没有学到")。 */
      learningGoal: string;
      /** 愿意为它花掉多少 (轮数 / 时间 / token)。探索型唯一的硬边界。 */
      affordableLoss: string;
    };

/**
 * 分类器给的**反面样本**:一份**明显错**的产物长什么样(G4, 2026-07-31)。
 *
 * 只在开跑前的判别力探针({@link acceptanceDiscriminationReason})里用,**不进冻结文本** ——
 * 它是拿来验判据的,不是拿给执行体看的(给了就等于告诉它"照这个的反面写"就能过闸)。
 */
export interface NegativeSample {
  /** 相对路径(探针在临时目录里按它落盘;绝对路径 / `..` 一律拒)。 */
  path: string;
  /** 两三行就够 —— 探针只问"这条命令会不会被它满足"。 */
  content: string;
}

/**
 * 探针裁决 —— 判执行型时两道探针 (空世界自检 / 反面样本) 的结果, 原样落进这一格。
 * 缺席 = 没探 / 没记录; `'unknown'` 永不写入。`why` 一律**原样带走**, 不再措辞。
 *
 * 五终局 (冻结契约):
 * - `passed-both`  —— 空世界自检与判别力探针都真跑且都过, 执行型原样收下。
 * - `vacuity-only` —— 执行型经 fail-open 路径收下 (没给 runner / 探针跑不起来 / 没样本):
 *   只过了空世界一道闸 (或一道都没真跑)。判别探针的原话进 `why`; 没有就省略。
 * - `demoted`      —— 执行型被闸拒 / 探针判虚 → 降级探索型, 原话进 `why`。
 * - `skipped`      —— 分类调用/解析失败 → 全保守档 (complex + 探索型), 失败原文进 `why`。
 * - `exploratory`  —— 模型自己选的探索型 (无探针、无降级)。
 */
export type AcceptanceProbe =
  | { kind: 'passed-both' }
  | { kind: 'vacuity-only'; why?: string }
  | { kind: 'demoted'; why: string }
  | { kind: 'skipped'; why: string }
  | { kind: 'exploratory' };

export interface GoalClassification {
  tier: GoalTier;
  acceptance: AcceptanceSpec;
  /** 见 {@link NegativeSample}。缺席 = 分类器没给(探针跳过,fail-open)。 */
  negativeSample?: NegativeSample;
  /** 见 {@link AcceptanceProbe}。缺席 = 没探 / 没记录。 */
  acceptanceProbe?: AcceptanceProbe;
}

/**
 * 一条验收命令是否**真跑得起来** = 过 command-leaf 的 fail-closed 闸 (白名单 / 元字符 / git 只读 /
 * 危险命令)。判据借的是执行期那一份 (`commandBlockReason`), 不是这里另抄一份 —— 抄一份早晚先漂,
 * 而漂的后果恰是「假红」。
 *
 * @returns null = 可跑; 否则一行拒因。
 */
export function acceptanceCommandBlockReason(command: string): string | null {
  const c = command.trim();
  if (!c) return '[blocked empty: 验收命令为空]';
  return commandBlockReason(c, DEFAULT_COMMAND_ALLOWLIST);
}

/** 便捷谓词。 */
export const isRunnableAcceptanceCommand = (command: string): boolean =>
  acceptanceCommandBlockReason(command) === null;

/** 探针裁决的 why 原文 (与对应 logger 行逐字相同 —— 冻结文本, 不再措辞)。 */
const VACUITY_CANT_RUN = '[omd/goal] 空世界自检跑不起来 → 不拦 (fail-open)';
const SAMPLE_PATH_BAD = '[omd/goal] 反面样本路径不合法 → 跳过判别力探针 (fail-open)';
const DISCRIM_CANT_RUN = '[omd/goal] 判别力探针跑不起来 → 不拦 (fail-open)';
const NO_NEGATIVE_SAMPLE = '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)';

/**
 * **空世界自检** (2026-07-31, G4 反面用例的可实现版)。
 *
 * ## 它要杀的是什么
 *
 * D-I 把判卷标准冻在环外, 防的是**执行体移动球门**。2026-07-31 live 抓到它防不住的另一半:
 * **球门生下来就是虚的**。那次冻结的命令是 `grep -q "相同" docs/from-api.md` —— 而它匹配得上
 * 「不相同」, 对的答案和错的答案都满足。命令跑了、退出码 0、G4 那格看上去是绿的, 而它什么都没验。
 *
 * **虚判据比没判据坏**: 没判据时任务文本会明说"本目标没有机器判据, 别伪造一个", judge 因此
 * 会去看别的证据; 有个虚的则让整条链**看起来已被验证**。
 *
 * ## 判据: 活还没干之前, 它就该是红的
 *
 * 一条真在判事的验收命令, 必须能区分"做完了"与"还没做"。所以在**执行之前**跑一遍它:
 * **这时候就过 = 它跟这次要做的事无关。**
 *
 * 抓得到的真实一类:
 *   - `bun test` 而测试本来就是绿的 (D-I 的 verify-green 恰恰要求它一开始是红的)
 *   - `cat README.md` / `test -d docs` 这种"文件在不在"而文件本来就在
 *   - 断言的内容源材料里本来就有
 *
 * ## ⚠ 抓不到什么 (诚实边界, 别把它当万能)
 *
 * **抓不到上面那条 live 缺陷本身。** `grep -q "相同" docs/from-api.md` 在空世界里文件还不存在
 * → grep 失败 → 自检认为它"能区分" —— 而它事后仍被「不相同」满足。
 * 那一类需要的是**语义知识**(断言的词是不是执行体自己能选的), 确定性检查够不到。
 * 那一半走 prompt(见 `classifyPrompt` 里"断言要落在**输入里的值**上"那条), 是 inferential 侧。
 * 两层各管一半, 谁也别声称管全了。
 *
 * fail-open: 没有 runner / 跑不起来 → 返 null (不拦)。自检是加固不是前置条件。
 */
export async function acceptanceVacuityReason(
  command: string,
  runCommand: (input: { command: string }) => Promise<{ exitCode: number }>,
  expectExit = 0,
): Promise<string | null> {
  const v = await probeVacuity(command, runCommand, expectExit);
  return v.status === 'ring' ? v.why : null;
}

/**
 * 空世界自检的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 */
type ProbeVacuityVerdict =
  | { status: 'ok' }
  | { status: 'ring'; why: string }
  | { status: 'fail_open' };

async function probeVacuity(
  command: string,
  runCommand: (input: { command: string }) => Promise<{ exitCode: number }>,
  expectExit = 0,
): Promise<ProbeVacuityVerdict> {
  let exitCode: number;
  try {
    ({ exitCode } = await runCommand({ command }));
  } catch (err) {
    logger.warn({ command, err: String(err) }, VACUITY_CANT_RUN);
    return { status: 'fail_open' };
  }
  // 负退出码 = command-leaf 的闸拒返回值, 不是被执行命令的退出码 —— 那说明命令根本没跑,
  // 自检对它无话可说 (而"跑不起来"这件事已经由 acceptanceCommandBlockReason 管了)。
  if (exitCode < 0) return { status: 'fail_open' };
  if (exitCode !== expectExit) return { status: 'ok' }; // 空世界里是红的 —— 通过自检
  return {
    status: 'ring',
    why:
      `[vacuous] 这条验收命令在**活还没干之前**就已经满足 (退出码 ${exitCode} = 期望值) —— ` +
      `它区分不了"做完了"与"还没做", 因此它不是一条判据。`,
  };
}

/**
 * **反面样本探针** —— G4 那句「判据必须在**错的答案**上失败」的可执行版(2026-07-31)。
 *
 * ## 它补的正是上面那段「⚠ 抓不到什么」
 *
 * 空世界自检问的是「活还没干之前它红不红」,而 2026-07-31 live 那条缺陷从这道闸底下走过去了:
 * `grep -q "相同" docs/from-api.md` 在空世界里文件不存在 → 命令失败 → 自检放行;
 * 而它事后**照样被「两处不相同」满足**。两道闸问的是**两个不同的问题**:
 *
 * | 探针 | 问 | 抓的病 |
 * |---|---|---|
 * | 空世界自检 | 什么都没做时它绿不绿 | 判据**恒真**(`cat README.md` 而 README 本来就在) |
 * | 反面样本(本函数) | 一份**错的**产物能不能骗过它 | 判据**不判别**(对的答案和错的答案都满足) |
 *
 * 一条判据要有意义, 这两问都得答对。此前只答了第一问, 而 live 抓到的恰是第二问那一类。
 *
 * ## 做法:在一个临时世界里把错答案摆出来
 *
 * 分类器除了命令还给一份**明显错**的产物(路径 + 两三行内容)。探针建一个临时目录、把它落盘、
 * 在那里跑同一条命令 —— **过了就是虚判据**。临时目录是引擎自己建的, 命令仍走同一份白名单闸,
 * 所以这道探针比空世界自检**更安全**(那一道是在真 cwd 上跑的)。
 *
 * ## 诚实边界
 *
 * 反面样本是**模型给的**, 所以这道闸的强度上限是"模型能不能想出一个像样的错答案"。
 * 它给了个和正确答案八竿子打不着的样本 → 探针照样放行一条虚判据。**它不是证明, 是筛子** ——
 * 筛掉的是那类"连一个显然的错答案都拦不住"的判据, 而 live 抓到的那条正是这一类。
 *
 * fail-open: 没样本 / 路径不合法 / 跑不起来 → 返 null(不拦)。同空世界自检:探针是加固不是前置条件。
 *
 * @returns null = 判据在这份错答案上失败了(通过探针);否则一行拒因。
 */
export async function acceptanceDiscriminationReason(
  command: string,
  sample: NegativeSample | undefined,
  expectExit = 0,
  deps: { runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number }> } = {},
): Promise<string | null> {
  const d = await probeDiscrimination(command, sample, expectExit, deps);
  return d.status === 'ring' ? d.why : null;
}

/**
 * 反面样本探针的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 */
type ProbeDiscriminationVerdict =
  | { status: 'ok' }
  | { status: 'ring'; why: string }
  | { status: 'skipped'; why: string }
  | { status: 'fail_open'; why: string };

async function probeDiscrimination(
  command: string,
  sample: NegativeSample | undefined,
  expectExit = 0,
  deps: { runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number }> } = {},
): Promise<ProbeDiscriminationVerdict> {
  if (!sample?.path || !sample.content) return { status: 'skipped', why: NO_NEGATIVE_SAMPLE };
  // 相对路径且不许 `..` —— 探针要写盘, 而"分类器给的路径"是**模型产的字符串**, 按不可信处理。
  // (临时目录本身是隔离的, 这一层是防它把宿主别处的文件覆盖掉。)
  const rel = sample.path.trim();
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    logger.warn({ path: sample.path }, SAMPLE_PATH_BAD);
    return { status: 'fail_open', why: SAMPLE_PATH_BAD };
  }
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'omd-negative-'));
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sample.content.endsWith('\n') ? sample.content : `${sample.content}\n`, 'utf-8');
    const run = deps.runIn ?? defaultProbeRunner;
    const { exitCode } = await run({ command, cwd: dir });
    // 负码 = 闸拒(命令没跑)→ 探针无话可说, 那件事由 acceptanceCommandBlockReason 管。
    if (exitCode < 0) return { status: 'fail_open', why: DISCRIM_CANT_RUN };
    if (exitCode !== expectExit) return { status: 'ok' }; // 错答案上命令失败 —— 通过探针
    return {
      status: 'ring',
      why:
        `[undiscriminating] 这条验收命令在一份**明显错**的产物上**照样通过**(退出码 ${exitCode} = 期望值) —— ` +
        `对的答案和错的答案都满足它, 因此它判不了成败。反面样本: \`${rel}\` = ${JSON.stringify(sample.content.slice(0, 120))}`,
    };
  } catch (err) {
    logger.warn({ command, err: String(err) }, DISCRIM_CANT_RUN);
    return { status: 'fail_open', why: DISCRIM_CANT_RUN };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 探针默认 runner:同一份白名单、**根在临时目录**。
 *
 * 刻意**不复用**调用方注入的那个 runner:那一个的 cwd 在装配期就烤进去了(= 真工作树),
 * 而探针的全部意义就是换一个世界跑。也刻意不为此给 `CommandLeafInput` 加一个 `cwd` 口 ——
 * 那是给节点执行面开一个由模型填的根路径,为一道自检开这种口子不划算。
 */
const defaultProbeRunner = async ({ command, cwd }: { command: string; cwd: string }): Promise<{ exitCode: number }> =>
  createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd, timeoutMs: 30_000 })({ command });

/**
 * 探索型兜底 —— 分型失败 / 执行型拿不到可跑命令时用它, **并把原因原样写进学习目标**。
 *
 * 为什么兜到探索型而不是"执行型但命令留空": 执行型的全部意义就是那条命令, 留空的执行型
 * 是个说自己可判、实际无人判的目标 —— 正是本模块要杀的那种。降级到探索型至少诚实:
 * 它明说"这次没有机器判据", 于是 spec 卡会被要求补出一条, 补不出就按探索型的规矩走 (定亏损上限)。
 */
export function fallbackExploratory(why: string): AcceptanceSpec {
  return {
    kind: 'exploratory',
    learningGoal: `(验收分型未成立: ${why}) 先弄清这个目标的成败到底该怎么判 —— 能不能落成一条可跑的命令。`,
    affordableLoss: '一轮执行的开销; 仍判不出判据就停下来交人, 不要靠多跑几轮蒙过去。',
  };
}

/** 分类器的 JSON 形状 (弱模型也吃得下的扁平结构; 深校验在下方 normalize)。 */
interface RawClassification {
  tier?: unknown;
  acceptance_kind?: unknown;
  command?: unknown;
  learning_goal?: unknown;
  affordable_loss?: unknown;
  /** G4 反面样本(扁平两格 —— 弱模型对嵌套对象的成功率明显低于扁平字段)。 */
  negative_sample_path?: unknown;
  negative_sample_content?: unknown;
}

/**
 * 把模型吐的 JSON 归一成 {@link GoalClassification}。**弱模型不可信原则**: 每一格都自己兜,
 * 兜不住就往保守方向落 —— 但保守的方向在两条轴上**相反**:
 *
 * - tier 落 `complex`: 多做一遍接地, 代价是钱; 误判成 simple 的代价是一份没有证据的契约被执行。
 * - acceptance 落 `exploratory`: 假装机器可判而实际无人判, 比明说"这次判不了"坏得多。
 */
export function normalizeClassification(raw: RawClassification): GoalClassification {
  const tier: GoalTier = String(raw.tier ?? '').toLowerCase().includes('simple') ? 'simple' : 'complex';
  const kind = String(raw.acceptance_kind ?? '').toLowerCase();

  if (kind.includes('exec')) {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    const blocked = acceptanceCommandBlockReason(command);
    if (blocked) {
      logger.warn({ command, blocked }, '[omd/goal] 判执行型但验收命令跑不起来 → 降级探索型 (D-I)');
      return {
        tier,
        acceptance: fallbackExploratory(`执行型但命令不可跑 — ${blocked}`),
        acceptanceProbe: { kind: 'demoted', why: blocked },
      };
    }

    // expectExit 恒 0: 这里定的是**总验收** (绿), 不是 TDD 中途的证红步 (那一步的 expect_exit:1
    // 由 spec 写进图里, 见 spec-author 卡的 TDD 流程段)。
    const nPath = typeof raw.negative_sample_path === 'string' ? raw.negative_sample_path.trim() : '';
    const nBody = typeof raw.negative_sample_content === 'string' ? raw.negative_sample_content : '';
    // 样本缺席**不降级**: 判别力探针是加固不是前置条件 (同空世界自检的 fail-open)。
    // 但要留一行 —— 缺席意味着这条判据只过了一道闸而不是两道, 而那两道问的不是同一个问题。
    if (!nPath || !nBody.trim()) {
      logger.info({ command }, NO_NEGATIVE_SAMPLE);
    }

    return {
      tier,
      acceptance: { kind: 'executable', command, expectExit: 0 },
      ...(nPath && nBody.trim() ? { negativeSample: { path: nPath, content: nBody } } : {}),
    };
  }

  const learningGoal = typeof raw.learning_goal === 'string' ? raw.learning_goal.trim() : '';
  const affordableLoss = typeof raw.affordable_loss === 'string' ? raw.affordable_loss.trim() : '';
  if (!learningGoal || !affordableLoss) {
    // 探索型缺了这两样就退回一个空壳分型 —— 那等于既没有机器判据也没有人判据, 什么都没定。
    // 记 skipped (分类没成立), 原话进 why —— 与 classifyGoal 里分类抛错是同一终局, 只差原话来源。
    return {
      tier,
      acceptance: fallbackExploratory('探索型缺学习目标或可承受损失'),
      acceptanceProbe: { kind: 'skipped', why: '探索型缺学习目标或可承受损失' },
    };
  }
  return {
    tier,
    acceptance: { kind: 'exploratory', learningGoal, affordableLoss },
    acceptanceProbe: { kind: 'exploratory' },
  };

}

/** 分类 prompt。白名单**拼进 prompt** —— 承 conductor prompt 的同一条教训: 不给表就只能猜, 猜错即假红。 */
export function classifyPrompt(goal: string): string {
  return [
    '你在给一个自主执行环做**开跑前的两个判断**。只回一个 JSON 对象, 不要别的字。',
    '',
    '判断一 `tier` (成本轴 — 要不要先接地):',
    '  "simple"  = 做法已经确定, 直接动手就行;',
    '  "complex" = 需要先查外部事实或先定契约 (选型 / 新机制 / 跨模块设计)。',
    '',
    '判断二 `acceptance_kind` (判据轴 — **成没成怎么判**):',
    '  "executable"  = 成败机器可判。**必须**同时给 `command`: 一条别人来跑、退出码 0 即算达成的命令。',
    '  "exploratory" = 成败机器判不了 (摸清一个领域 / 选型 / 找出有哪些坑)。给 `learning_goal`',
    '                  (学到什么才算没白跑) 与 `affordable_loss` (愿意为它花掉多少)。',
    '',
    '⚠ 判据轴与成本轴**互相独立**: 一个做法未定的目标, 验收照样可能是机器可判的 (先查清楚怎么做,',
    '  但做完跑 `bun test` 就知道成没成)。别因为 tier=complex 就往 exploratory 上靠。',
    '⚠ 拿不准就选 "exploratory"。给一条**判不了真假**的命令比承认判不了坏得多 —— 它会让整个环',
    '  以为自己有验收, 而实际上没有。',
    '',
    `\`command\` 的首个词必须是这些之一, 否则命令会被安全闸拒绝执行 (看起来像测试失败, 实则没跑):`,
    `  ${DEFAULT_COMMAND_ALLOWLIST.join(' ')}`,
    '可以用 && 串联 (每环独立过闸); 其它 shell 运算符 **一律拒绝**: 管道 `|` · 重定向 `> <` ·',
    '`;` · `$(...)` · 反引号 · **圆括号 `( )`** · 花括号 `{ }` · 反斜杠 · 换行。**没有 shell**, 只有一串独立的命令。',
    // 2026-07-31 live 冒烟: 分类器写出 `grep -qx "支持格式: CSV, JSON, Excel (.xlsx)" docs/from-api.md`
    // —— 括号在**引号里面**, 它显然以为引号保护得了。闸是对整条命令串做正则扫描的, 引号不参与解析,
    // 所以那条命令被拒 → 降级探索型 → 又一次「本目标没有机器判据」。与 `$` 锚点那次是同一条链,
    // 只是换了个字符。规则讲一遍不够, 得把"引号不豁免"这句明说出来。
    '⚠ **引号保护不了这些字符**: 闸扫的是整条命令串, 不解析引号 —— 写在 `"…"` 里面的 `(` 一样被拒。',
    '  要断言的文本里本身带括号 → 换成不含括号的片段用 `grep -q`, 别硬要整行相等。',
    '',
    // 2026-07-30 live 冒烟: 连着三次判成执行型都因这条降级 (`mkdir` 不在名单 / 用了管道) ——
    // 模型知道规则却仍写出跑不了的命令, 给它两个**照抄就对**的形状比再讲一遍规则有效。
    '写得出来的验收长这样 (照这个形状改, 别自己发明):',
    '  · 文件内容对不对 → `grep -qx "期望的那整行" 路径/文件`  (`-x` = 整行匹配, 匹配不上退出码非 0)',
    '  · 只看包含某段  → `grep -q "期望的片段" 路径/文件`',
    '  · 文件在不在     → `cat 路径/文件`',
    '  · 代码还编不编得过 / 测试绿不绿 → `bun test` · `tsc --noEmit`',
    // 2026-07-30 第二次 live 冒烟: 模型照上面的形状写了 `grep -q '^hello omd$' notes/hello.md` ——
    // 形状没错, 锚点里的 `$` 撞了元字符闸。一条 `$` 的连锁是: 命令被拒 → 降级探索型 → 任务文本
    // 写上"没有机器判据·别伪造" → judge 把**真做完**的活读成捏造执行确认 → 整个 goal 报 failed。
    // 所以这一行必须明说, 而不是指望"别用元字符"那条通则被想起来。
    // 2026-07-31 live: 它写的是 `grep -q "相同" docs/from-api.md` —— 而「相同」是**它自己待会儿
    // 要写进文件的结论词**, 执行体两头都握着, 于是这条命令必然满足 (而且「不相同」也含「相同」)。
    // 判据要有意义, 断言的东西就必须是执行体**改不动**的: 源材料里的值、一条命令的退出码。
    '⚠ **断言要落在「输入里的值」上, 别断言你自己待会儿要写的结论词。**',
    '  反例: 让摘要写"两处相同"然后 `grep -q "相同" 摘要` —— 你两头都握着, 这条命令必然过, 什么也没验。',
    '  正例: 断言源材料里那个**具体的数**出现在产物里 (`grep -q "100" docs/from-api.md`)。',
    '⚠ 这条命令**在活还没干之前必须是红的** —— 它这时候就绿, 说明它跟这次要做的事无关 (会被自检拒)。',
    '⚠ **别在 grep 里用正则锚点 `^` `$`** —— `$` 会被安全闸拒 (整条命令因此跑不起来)。',
    '  要"整行严格相等"就用 `-x`, 它就是干这个的。同理别用 `*` 之外的花哨正则。',
    '写不出这种单条命令 (要 mkdir、要管道过滤、要人眼看输出) = 这个目标机器判不了 → 老实选 exploratory。',
    '',
    // G4 (2026-07-31): 上面那条"别断言你自己要写的结论词"是**讲道理**, 而讲道理拦不住 live 里
    // 真发生的事 (它照样写了 `grep -q "相同"`)。这里改成**让它自己举一个反例** —— 举得出来,
    // 引擎就能拿去跑一遍: 命令在这份错答案上照样通过 = 这条判据判不了成败, 当场降级。
    // 顺带的副作用正是想要的: 一条判据要举得出"什么样算错", 它多半本来就想清楚了。
    '',
    '判成 executable 时**再给一份反面样本** (`negative_sample_path` + `negative_sample_content`):',
    '  **一份明显错的产物长什么样** —— 相对路径 + 两三行内容。引擎会把它写进一个临时目录、',
    '  在那里跑一遍你给的 `command`: **命令必须在这份错答案上失败**。它要是照样通过, 说明这条',
    '  命令对的错的都满足、判不了成败 —— 那时整个目标会被降级成 exploratory。',
    '  例: 命令 `grep -q "100" docs/from-api.md` → 反面样本 path=`docs/from-api.md`,',
    '      content=`本文档汇总了接口支持的格式与限制。` (没有那个数 → 命令失败 → 这条判据是判别的)',
    '',
    '形状: {"tier":"simple"|"complex","acceptance_kind":"executable"|"exploratory",',
    '       "command"?:string,"negative_sample_path"?:string,"negative_sample_content"?:string,',
    '       "learning_goal"?:string,"affordable_loss"?:string}',
    '',
    `目标: ${goal}`,
  ].join('\n');
}

/**
 * 跑分类 (一次调用出两条轴)。无 generate/model, 或调用/解析失败 → 全保守档
 * (`complex` + 探索型兜底), **不抛** —— 分类是路由不是闸, 挂了该继续往下走。
 *
 * **命令被闸拒时带因重试一次** (2026-07-30 第二次 live 冒烟逼出来的): 降级探索型的代价远不止
 * "少一条命令" —— 探索型会把「本目标没有机器判据, 不要伪造一个」写进任务文本, 而内环 judge 读到
 * 它之后, 把执行体**真做完**的活 (文件写对了、cat 出来了) 判成了"捏造执行确认", 整个 goal 报
 * failed。一条 `$` 锚点的连锁能走这么远, 就值得为它多花一次分类调用。
 *
 * 重试**必须带上闸的原话**, 不是原样重问 —— 同 L0 重试与内环 prevReason 那条纪律: 原样重放对
 * 确定性失败是纯烧钱 (模型刚才就是照着规则写的, 它不知道自己踩的是哪一条)。只重试一次: 两次还
 * 写不出可跑命令, 那多半是这个目标真的机器判不了, 那时降级探索型是**对的答案**而不是失败。
 */
export async function classifyGoal(
  goal: string,
  deps: {
    generate?: GenerateFn;
    model?: string;
    /**
     * 给了则对判出的执行型命令做一次**空世界自检**(见 `acceptanceVacuityReason`):
     * 活还没干之前它就过 = 它不是判据 → 降级探索型并把原因写进学习目标。
     * 省略 = 不自检(fail-open;自检是加固不是前置条件)。
     */
    runCommand?: (input: { command: string }) => Promise<{ exitCode: number }>;
  },
): Promise<GoalClassification> {
  const { generate, model, runCommand } = deps;
  if (!generate || !model) {
    return {
      tier: 'complex',
      acceptance: fallbackExploratory('无分类器 (缺 generate/model)'),
      acceptanceProbe: { kind: 'skipped', why: '无分类器 (缺 generate/model)' },
    };
  }

  const ask = async (correction: string): Promise<GoalClassification> => {
    const { text } = await generate({
      model,
      // 判据轴是防作弊的地基, 它那一发尤其该看得见 (D-I / G4 两条闸都压在这个 prompt 上)。
      traceName: 'classify:acceptance',
      messages: [{ role: 'user', content: `${classifyPrompt(goal)}${correction}` }],
      // 400 会被推理族的 reasoning 吃光 → 正文截断 → JSON.parse 抛 → 全保守档 (complex + 探索型)。
      // 2026-07-31 S3 live 实测撞到: `deepseek-v4-pro 输出撞到上限 out=400 cap=400 — 正文被截断`,
      // 后果是**验收分型在这条路上基本判不出执行型**, D-I 又一次形同虚设 —— 与 `$` 锚点链是同一个
      // 后果、不同的成因。llm-judge.ts:89 早就为同一件事付过一次账 (700 → 空裁决), 这里没照做。
      //
      // 为什么是 32_768 而不是"干脆不给": **省略不等于不限**。三条传输路的兜底各不相同 ——
      // openai-兼容路 (`model/index.ts:243`) 省略 = `max_tokens` 字段根本不发 → 吃 provider 自己的
      // 默认 (DeepSeek 官方默认 4K 级); pi 路 (`pi-transport.ts:403`) 省略 = 吃 pi 的默认;
      // 只有 anthropic 路省略才落到该模型官方上限。给显式值反而更稳: 同一处 `Math.min(ceiling)`
      // 会按 `model-caps` 把它收敛到该座位的官方上限, 超发不会 400。
      // 32_768 是仓里"实际等于不设限、且在每个已登记座位上都安全"的那个数 (最小已登记上限是
      // qwen3.7 的 65_536), conductor / plan / synth 用的都是它。输出本身 ~200 字符, 按实发计费,
      // 抬 cap 不花钱。
      maxTokens: 32_768,
    });
    return normalizeClassification(JSON.parse(extractJsonObject(text)) as RawClassification);
  };
  /** 过了闸的执行型再过**两道**探针; 任一响 → 降级探索型(理由原样带走)。 */
  const vet = async (c: GoalClassification): Promise<GoalClassification> => {
    if (c.acceptance.kind !== 'executable') return c;
    // 先把 command 抽出来再进闭包: 闭包捕获 c 时 TS 不保留对 c.acceptance.kind 的收窄
    // (TS2339: command 在 exploratory 分支上不存在) —— 抽出 = 窄化, 不是断言。
    const command = c.acceptance.command;
    // 两道问的**不是同一个问题**, 所以是串联不是二选一:
    //   ① 空世界自检   —— 活还没干之前它就绿? → 判据**恒真**(需要注入的 runner, 在真 cwd 上跑)
    //   ② 反面样本探针 —— 一份错的产物骗得过它? → 判据**不判别**(自带 runner, 在临时世界里跑)
    // ① 抓不到 live 那条 `grep -q "相同"`(空世界里文件不存在 → 命令失败 → 放行), ② 才抓得到。
    const demoteG4 = (why: string): GoalClassification => {
      logger.warn({ command, why }, '[omd/goal] 验收命令没过判据探针 → 降级探索型 (G4)');
      return {
        tier: c.tier,
        acceptance: fallbackExploratory(`${why} 原命令: \`${command}\``),
        acceptanceProbe: { kind: 'demoted', why },
      };
    };
    const v: ProbeVacuityVerdict = runCommand
      ? await probeVacuity(command, runCommand, c.acceptance.expectExit)
      : { status: 'fail_open' }; // 没给 runner = 不自检 (fail-open, 不降级)
    if (v.status === 'ring') return demoteG4(v.why);
    const d = await probeDiscrimination(command, c.negativeSample, c.acceptance.expectExit);
    if (d.status === 'ring') return demoteG4(d.why);
    // 两道都没响 (没有 ring)。**剩下的组合别压成一个 kind** —— 「探针跑不起来」与「分类器没给
    // 反面样本」是两件不同的事, 而账本这一列存在的全部理由就是事后分得开:
    //   - 跑不起来 (`fail_open`) = 环境/实现问题, **该修**;
    //   - 没给样本 (`skipped`)   = 模型行为, **该量** (G4 收尾判据要的正是这个频率)。
    // ⚠ 第一版把两者都记成 `vacuity-only`, 而那个词的意思恰恰是"空世界那道跑了、判别那道没跑" ——
    // 于是 `v.status==='fail_open'` (空世界没跑成) 被贴上"空世界跑了"的标签, **标签是反的**。
    // 抓到它的是本仓的 verifier 而不是 tsc/test (那次跑 2159 pass 全绿), 记一笔: 这是
    // 「oracle 绿 ≠ 语义对」的又一个真样本, 也是 mustNotName / 两种 NULL 那族"别把两件事压成一件"。
    // fail-open 语义不变: 下面任何一支都**不降级**, 执行型照收。
    const failOpenWhy =
      v.status === 'fail_open'
        ? `空世界自检未能运行${d.status === 'fail_open' ? `; ${d.why}` : ''}`
        : d.status === 'fail_open'
          ? d.why
          : null;
    const probe: AcceptanceProbe = failOpenWhy
      ? { kind: 'skipped', why: failOpenWhy }
      : d.status === 'skipped'
        ? { kind: 'vacuity-only', why: d.why }
        : { kind: 'passed-both' };
    return { ...c, acceptanceProbe: probe };
  };


  try {
    const first = await ask('');
    // 只在"本来想判执行型、却因命令跑不起来被降级"这一种情况下重试 (fallbackExploratory 的
    // 原因串是那次降级的唯一凭据)。模型自己老实选的探索型不重试 —— 那是它的判断, 不是失误。
    const blockedReason = firstBlockedReason(first);
    if (!blockedReason) return vet(first);
    logger.info({ blockedReason }, '[omd/goal] 验收命令被闸拒 → 带上闸的原话重问一次 (D-I)');
    let second = await ask(
      `\n\n⚠ 你上一次给的验收命令**被安全闸拒了**, 原话是:\n  ${blockedReason}\n` +
        // 2026-07-31 live: 重试拿到的是同一条命令换了全角标点, 括号原样留着 —— 闸的原话里明明
        // 列了 `( )`。也就是说它读到了规则却仍然踩, 唯一说得通的解释是**它以为引号保护得了**。
        // 所以纠正文案必须点破那个假设, 而不是再念一遍名单。
        '⚠ 闸扫的是**整条命令串, 不解析引号** —— 写在 `"…"` 里面的 `( ) { } | ; $ < >` 一样被拒。\n' +
        '换一条能过闸的单条命令: 断言的文本里带括号就**别要整行相等**, 改成不含括号的片段 + `grep -q`。' +
        '(整行相等只在那一行本身干净时用 `grep -qx "整行" 文件`; 别用 `^ $` 锚点。)' +
        '实在写不出能过闸的命令, 就老实选 exploratory —— 别硬凑一条跑不起来的。',
    );
    const stillBlocked = firstBlockedReason(second);
    if (stillBlocked) {
      logger.warn({ stillBlocked }, '[omd/goal] 重试后仍写不出可跑命令 → 降级探索型 (这次多半是真判不了)');
      // 裁决原样带走: 这次降级的凭据是**重试那次**的闸因 (normalize 里那次记的可能是同一串, 这里以重试为准)。
      second = { ...second, acceptanceProbe: { kind: 'demoted', why: stillBlocked } };

    }
    return vet(second);

  } catch (err) {
    logger.warn({ err: String(err) }, '[omd/goal] 分类调用/解析失败 → 全保守档 (complex + 探索型)');
    return {
      tier: 'complex',
      acceptance: fallbackExploratory('分类调用或解析失败'),
      acceptanceProbe: { kind: 'skipped', why: String(err) },
    };
  }
}

/** 这次分类是不是"想判执行型却被闸拒"→ 返闸的原话; 其它情况 → null (不重试)。 */
function firstBlockedReason(c: GoalClassification): string | null {
  if (c.acceptance.kind !== 'exploratory') return null;
  const m = /执行型但命令不可跑 — (\[blocked[^\]]*\])/.exec(c.acceptance.learningGoal);
  return m?.[1] ?? null;
}

/** 从模型输出里抠出第一个 JSON 对象 (容忍 ```json 围栏与前后散文)。抠不到 → 原样返 (交给 JSON.parse 抛)。 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * **冻结的判卷标准** —— 同一份文本进 spec 起草 prompt、进 execute 的任务文本。
 *
 * 一份而不是两份是要点: 判卷标准分两处写, 两处就会漂, 而"判据漂了"正是作弊达标最舒服的入口。
 */
export function renderAcceptance(a: AcceptanceSpec): string {
  if (a.kind === 'executable') {
    return [
      '## 判卷标准 (冻结 — 执行型)',
      '本目标的达成判据是**这一条命令**, 由外部来跑, 退出码即结论:',
      '```',
      a.command,
      '```',
      `期望退出码: ${a.expectExit}。`,
      '',
      '这条命令与它所断言的东西在实施开始前即已冻结。实施过程中**不许**改动它, 也不许改动它所',
      '依赖的断言 —— 需要改判据说明判据错了, 那是要回来重新定的事, 不是实施途中顺手做的事。',
    ].join('\n');
  }
  return [
    '## 判卷标准 (冻结 — 探索型)',
    '本目标**没有机器判据** —— 不要伪造一个 (给一条判不了真假的命令比承认判不了坏得多)。',
    `- 学习目标: ${a.learningGoal}`,
    `- 可承受损失: ${a.affordableLoss}`,
    '',
    '判不了成败时能定的只有亏损上限。到了上限还没弄清楚, 就停下来把已知与未知交出去,',
    '不要靠多跑几轮蒙过去。',
  ].join('\n');
}
