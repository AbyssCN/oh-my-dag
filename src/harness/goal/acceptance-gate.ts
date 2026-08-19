/**
 * goal/acceptance-gate —— **判据自证**:一条验收命令自己得先过闸(2026-08-07 从 `acceptance.ts` 拆出)。
 *
 * ## 为什么与"分型"分家
 *
 * 原来的 `acceptance.ts` 里塞着两件事:**这个目标该用哪种验收**(分型)与**这条判据本身立不立得住**
 * (自证)。`acceptance` 这个词因此什么都指不准 —— 它同时是"验收标准""验收分型""判据的自证"。
 * 拆开之后依赖是**单向的**:分型 → 本文件;本文件不认识分型。
 *
 * ## 它拦的两类
 *
 * D-I 把判卷标准冻在环外, 防的是**执行体移动球门**。本文件防的是另一半 —— **球门生下来就是虚的**:
 *
 * 1. **空世界自检**({@link acceptanceVacuityReason})—— 活还没干之前跑一遍,**这时候就过 = 它跟这次要做的事无关**。
 * 2. **判别力探针**({@link acceptanceDiscriminationReason})—— 拿分类器给的一份**明显错**的产物跑一遍,
 *    **照样通过 = 对的答案和错的答案都满足它**。
 *
 * 两道都是 **fail-open**:跑不起来就不拦。它们是加固,不是前置条件。
 *
 * ⚠ 诚实边界:确定性检查够不到"断言的词是不是执行体自己能选的"那一类,那一半走 prompt(在 `classify-acceptance.ts`)。
 * **两层各管一半,谁也别声称管全了。**
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULT_COMMAND_ALLOWLIST, commandBlockReason, createCommandLeafRunner } from '../command-leaf';
import { logger } from '../logger';
import { ensureNodeModulesLink } from '../run-worktree';

/**
 * 分类器给的**反面样本**:一份**明显错**的产物长什么样(G4, 2026-07-31)。
 *
 * 只在开跑前的判别力探针({@link acceptanceDiscriminationReason})里用,**不进冻结文本** ——
 * 它是拿来验判据的,不是拿给执行体看的(给了就等于告诉它"照这个的反面写"就能过闸)。
 */
export interface NegativeSample {
  /** 相对路径(探针在临时目录里按它写文件;绝对路径 / `..` 一律拒)。 */
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
 *   `why` (#204): **零判别力的判据段**清单 —— 整条分得出, 但其中某几段在反面世界里照样过。
 *   收下不代表每一段都在证事; 缺席 = 没有弱段 (或没跑逐段判)。
 * - `vacuity-only` —— 执行型经 fail-open 路径收下 (没给 runner / 探针跑不起来 / 没样本):
 *   只过了空世界一道闸 (或一道都没真跑)。判别探针的原话进 `why`; 没有就省略。
 * - `demoted`      —— 执行型被闸拒 / 探针判虚 → 降级探索型, 原话进 `why`。
 * - `skipped`      —— 分类调用/解析失败 → 全保守档 (complex + 探索型), 失败原文进 `why`。
 * - `exploratory`  —— 模型自己选的探索型 (无探针、无降级)。
 */
export type AcceptanceProbe =
  | { kind: 'passed-both'; why?: string }
  | { kind: 'vacuity-only'; why?: string }
  | { kind: 'demoted'; why: string }
  | { kind: 'skipped'; why: string }
  | { kind: 'exploratory' };

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
/**
 * 上面那句原本**同时**盖住两件事:命令被闸拒(负码)与探针自己炸了(catch)。
 * 两者的下一步完全不同(前者去看白名单,后者是运行时缺陷该重跑),压成一个标签就再也分不开
 * —— 本仓坑①(`NULL` ≠ 0 ≠ 不适用)的同一形状。2026-08-14 晚拆开。
 *
 * ⚠ **catch 那条把错误原文带进 `why`**,不是只留在 logger 的字段里:那次真实事故
 * (26 次全量里 1 次,`v4-5.log`)现场就只剩一句光秃秃的 msg —— 日志格式把 binding 全丢了,
 * 只能靠"绿的日志各 1 条、红的那份 2 条"这种计数才认出来。
 * **留了证据不等于证据看得见**(本仓 §3 的第二层)。
 */
const DISCRIM_BLOCKED = '[omd/goal] 判别力探针的命令被闸拒 → 不拦 (fail-open, 那件事由命令闸管)';
export const NO_NEGATIVE_SAMPLE = '[omd/goal] 分类器没给反面样本 → 判别力探针跳过 (这条判据只过了空世界自检)';

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
  runCommand: (input: { command: string }) => Promise<{ exitCode: number | null }>,
  expectExit = 0,
): Promise<string | null> {
  const v = await probeVacuity(command, runCommand, expectExit);
  return v.status === 'ring' ? v.why : null;
}

/**
 * 空世界自检的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 */
export type ProbeVacuityVerdict =
  | { status: 'ok' }
  | { status: 'ring'; why: string }
  | { status: 'fail_open' };

export async function probeVacuity(
  command: string,
  runCommand: (input: { command: string }) => Promise<{ exitCode: number | null }>,
  expectExit = 0,
): Promise<ProbeVacuityVerdict> {
  let exitCode: number | null;
  try {
    ({ exitCode } = await runCommand({ command }));
  } catch (err) {
    logger.warn({ command, err: String(err) }, VACUITY_CANT_RUN);
    return { status: 'fail_open' };
  }
  // 负退出码 = command-leaf 的闸拒返回值, 不是被执行命令的退出码 —— 那说明命令根本没跑,
  // 自检对它无话可说 (而"跑不起来"这件事已经由 acceptanceCommandBlockReason 管了)。
  // null = 死于信号: 跑了但没跑完, 没有判词 ⇒ 与闸拒同样无话可说, 不许读成「空世界里是红的」。
  if (exitCode === null || exitCode < 0) return { status: 'fail_open' };
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
 * 分类器除了命令还给一份**明显错**的产物(路径 + 两三行内容)。探针建一个临时目录、把它写进去、
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
  deps: {
    runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>;
    repoRoot?: string;
  } = {},
): Promise<string | null> {
  const d = await probeDiscrimination(command, sample, expectExit, deps);
  return d.status === 'ring' ? d.why : null;
}

/**
 * 反面样本探针的**裁决** (给 vet 记 acceptanceProbe 用)。判定与 fail-open 语义与 `string | null`
 * 版逐字相同 —— 只是把"为什么"一起带出来, 不加不减任何决策。
 */
export type ProbeDiscriminationVerdict =
  | { status: 'ok'; weak?: string[]; why?: string }
  | { status: 'ring'; why: string; weak?: string[] }
  | { status: 'skipped'; why: string }
  | { status: 'fail_open'; why: string };

/**
 * **零判别力的判据段** (#204, 承 #199 D2)。判据是 `A && B && C` 时, 只要有一段强 (`bun test`),
 * 整条就"分得出" —— 弱段被强段背书。#165 的 `grep -q "反向自检" <本次要产出的测试文件>` 正是
 * 这样溜过去的: 整条里的 `bun test` 在错答案上红了, 于是探针给整条放行, 而那条 grep 段
 * **在任何代码下都退 0**。
 *
 * 逐段跑之后, 在反面世界里**仍然通过**的段就是零判别力的段, 原样点名。
 *
 * ⚠ **逐段结果只加信息, 永不翻裁决**: 切分是按裸 `&&` 做的朴素切分 (引号里的 `&&` 会切错),
 * 所以它不许决定收不收 —— 切错了最多多报一段, 不会误拒一条好判据。裁决仍只看整条。
 */
export function splitCriterionSegments(command: string): string[] {
  return command
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function probeDiscrimination(
  command: string,
  sample: NegativeSample | undefined,
  expectExit = 0,
  deps: {
    runIn?: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>;
    /** #204: 真仓根 —— 给了才建 HEAD 真副本当反面世界; 省略 = 今天的空目录形态 (fail-open)。 */
    repoRoot?: string;
  } = {},
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
    // ── #204 (承 #199 D1): 反面世界要是**真仓副本**, 不是空目录 ──────────────────
    //
    // 读数是这么逼出来的: 账本 348 跑里真跑过探针的 69 跑, 这道闸**红过 0 次** (3 次 demoted
    // 全是空世界自检打的)。66/66 零方差 —— 而本仓自己的话是「一个在任何干预下都不动的数,
    // 通常量的是尺子, 不是被测物」。
    //
    // 尺子错在哪: 原来的世界是 `mkdtemp` 一个**空目录** + 只写进去那一个样本文件。任何仓内判据
    // (`bun test` / `bunx tsc` / 相对路径 grep) 在空目录里**必然失败**, 于是探针恒判「分得出」——
    // 它量的其实是「这条命令在仓外会不会挂」, 而答案恒为「会」。
    //
    // 用 `git archive` 而不是 `git worktree add`: 探针每条执行型判据都要跑一次, 不该往真仓的
    // worktree 登记表里留状态 —— archive 零仓内副作用, 清理就是 rm -rf。node_modules 走
    // `ensureNodeModulesLink` 软链 (没有它 `bun test` 在副本里必然缺依赖而挂, 那就又回到
    // 「恒失败 = 恒判分得出」的老毛病)。
    const world = buildNegativeWorld(dir, deps.repoRoot);
    const file = join(world.cwd, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sample.content.endsWith('\n') ? sample.content : `${sample.content}\n`, 'utf-8');
    const run = deps.runIn ?? defaultProbeRunner;
    const { exitCode } = await run({ command, cwd: world.cwd });
    // null = 死于信号(跑了但没跑完, 没有判词)→ 与闸拒同样"探针无话可说", 但成因不同, 判词分开写。
    if (exitCode === null) return { status: 'fail_open', why: '判据自证: 探针命令死于信号(没拿到判词)—— 本次自检无效, 不据此降级' };
    // 负码 = 闸拒(命令没跑)→ 探针无话可说, 那件事由 acceptanceCommandBlockReason 管。
    if (exitCode < 0) return { status: 'fail_open', why: DISCRIM_BLOCKED };
    // #204 (D2): 逐段跑一遍 —— 整条的裁决不受它影响, 它只回答「哪几段其实什么都没证明」。
    const weak = await weakSegments(command, world.cwd, expectExit, run);
    if (exitCode !== expectExit) {
      // 错答案上整条命令失败 —— 通过探针。
      //
      // 但「通过」值多少钱取决于**在哪个世界里通过的**: 退回空目录时任何仓内判据都必然失败,
      // 那次通过什么都没证明 (#199 量到的正是这个: 69 跑 0 红)。所以世界的原话进这里, 而**不进
      // ring 那条判词** —— ring 无论在哪个世界都成立 (空目录里都能过, 那更 damning), 且那句是
      // 冻结文本, 不许为附注改它一个字。
      const notes = [world.why, weak.length > 0 ? `零判别力的段 (${weak.length}): ${weak.map((w) => `\`${w}\``).join(' · ')}` : undefined].filter(
        (x): x is string => Boolean(x),
      );
      return {
        status: 'ok',
        ...(weak.length > 0 ? { weak } : {}),
        ...(notes.length > 0 ? { why: notes.join('; ') } : {}),
      };
    }
    return {
      status: 'ring',
      why:
        `[undiscriminating] 这条验收命令在一份**明显错**的产物上**照样通过**(退出码 ${exitCode} = 期望值) —— ` +
        `对的答案和错的答案都满足它, 因此它判不了成败。反面样本: \`${rel}\` = ${JSON.stringify(sample.content.slice(0, 120))}`,
      ...(weak.length > 0 ? { weak } : {}),
    };
  } catch (err) {
    const why = `${DISCRIM_CANT_RUN}: ${String(err).slice(0, 200)}`;
    logger.warn({ command, err: String(err) }, why);
    return { status: 'fail_open', why };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 造反面世界 (#204, 承 #199 D1)。给了 `repoRoot` 且它是 git 仓 → **HEAD 的真副本**;
 * 否则退回今天的空目录形态。
 *
 * **fail-open 且留证据**: 任何一步没成都退回空目录并把原因带进 `why` —— NULL≠0,
 * 「没建成真副本」与「建了真副本」是两件事, 事后要分得开 (不然又出现一个"恒过"的探针
 * 而没人知道它其实一直在空目录里跑)。
 */
function buildNegativeWorld(dir: string, repoRoot?: string): { cwd: string; why?: string } {
  // 没接线 ≠ 降级: `why` 只记**真降级**(给了 repoRoot 却没建成真副本), 那是读数; 「压根没给」
  // 是接线问题, 走日志。两者混在一格里, `passed-both.why` 就会常驻一句废话, 而常驻的附注等于没有附注。
  // ⚠ 空旋钮风险: 生产的那根线在 `run-goal.ts` 的 `repoRoot: config.cwd` —— 拆了它这里不会红,
  //   只会安静地退回空目录。真要拆先看 #204 的裁决。
  if (!repoRoot) {
    logger.info({ dir }, '[omd/goal] 判别力探针: 没给 repoRoot → 反面世界=空目录 (仓内判据在那里必然失败, 这次探针几乎必然放行)');
    return { cwd: dir };
  }
  if (!existsSync(join(repoRoot, '.git'))) return { cwd: dir, why: `反面世界=空目录 (${repoRoot} 不是 git 仓)` };
  const wt = join(dir, 'repo');
  try {
    mkdirSync(wt, { recursive: true });
    const tar = join(dir, 'head.tar');
    // 两步 spawn 而不是管道: 管道的退出码要另判, 而这里每一步失败都必须**看得见**。
    const ar = Bun.spawnSync(['git', 'archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    if (ar.exitCode !== 0) throw new Error(`git archive 退 ${ar.exitCode}: ${new TextDecoder().decode(ar.stderr).trim().slice(0, 160)}`);
    const ex = Bun.spawnSync(['tar', '-xf', tar, '-C', wt], { stdout: 'pipe', stderr: 'pipe' });
    if (ex.exitCode !== 0) throw new Error(`tar -xf 退 ${ex.exitCode}: ${new TextDecoder().decode(ex.stderr).trim().slice(0, 160)}`);
    // 没有 node_modules, `bun test` 在副本里必然缺依赖而挂 —— 那就又回到「恒失败 = 恒判分得出」。
    const link = ensureNodeModulesLink(repoRoot, wt);
    return { cwd: wt, why: link === 'linked' || link === 'already-present' ? undefined : `反面世界=真仓副本, 但 node_modules ${link}` };
  } catch (err) {
    return { cwd: dir, why: `反面世界退回空目录 (真副本没建起来: ${String(err).slice(0, 160)})` };
  }
}

/**
 * 逐段判判别力 (#204, 承 #199 D2): 在反面世界里把 `A && B && C` 逐段跑, 收集**仍然通过**的段。
 *
 * 只在有两段以上时跑 —— 单段判据的逐段结果就是整条结果, 再跑一遍是白花一次命令的钱。
 * 任何一段跑不起来 (信号 / 闸拒 / 抛) 一律**不算弱段**: 这道逐段判只加信息不翻裁决,
 * 把"没跑成"读成"没判别力"就是拿猜当事实。
 */
async function weakSegments(
  command: string,
  cwd: string,
  expectExit: number,
  run: (input: { command: string; cwd: string }) => Promise<{ exitCode: number | null }>,
): Promise<string[]> {
  const segs = splitCriterionSegments(command);
  if (segs.length < 2) return [];
  const weak: string[] = [];
  for (const seg of segs) {
    try {
      const { exitCode } = await run({ command: seg, cwd });
      if (exitCode === expectExit) weak.push(seg);
    } catch {
      // 跑不起来 ≠ 没判别力 —— 跳过, 不记 (fail-open 可以吞异常, 但这里没有证据可留: 段原文已在判词里)。
    }
  }
  return weak;
}

/**
 * 探针默认 runner:同一份白名单、**根在临时目录**。
 *
 * 刻意**不复用**调用方注入的那个 runner:那一个的 cwd 在装配期就烤进去了(= 真工作树),
 * 而探针的全部意义就是换一个世界跑。也刻意不为此给 `CommandLeafInput` 加一个 `cwd` 口 ——
 * 那是给节点执行面开一个由模型填的根路径,为一道自检开这种口子不划算。
 */
const defaultProbeRunner = async ({ command, cwd }: { command: string; cwd: string }): Promise<{ exitCode: number | null }> =>
  createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], cwd, timeoutMs: 30_000 })({ command });
