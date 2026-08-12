/**
 * src/harness/playbook/load —— `loadPlaybooks(cwd)`: 内置 + 项目层叠加, 三道校验闸 (A-1/A-2/A-3)。
 *
 * 叠加形状照 `src/harness/agent-templates.ts` 的 `loadAgentTemplates` 抄 (内置先灌进 Map, 项目层
 * 同名覆盖)。**不同的地方**: agent-templates 是 TPL-1 fail-open (坏卡 warn+跳过, 永不阻断规划) ——
 * 那是因为卡片坏了只是少一张卡, 规划照常跑。playbook 不一样: 一份坏的 playbook 若被静默跳过,
 * `loadPlaybooks` 返回的 Map 里就**少了它却不说为什么**, 调用方以为"没这个 playbook"而不是"它被拒收"。
 * 所以这里**拒收即抛错, 整次加载失败**——项目层配置非法不回退内置项, 逼你当场看见并修。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../logger';
import type { Playbook } from './types';

/** 内置 playbook 根 (随包发布; 相对本模块位置解析, 与 cwd 无关 —— 同 pathfinder/init.ts 的 CALLER_TEMPLATE_ABS 范式)。 */
export const BUILTIN_PLAYBOOK_DIR = join(import.meta.dir, '..', '..', '..', 'templates', 'playbooks');
/** 项目层 playbook 目录 (cwd 相对; 与 `.omd/profiles`、`.omd/agents` 同规)。 */
export const PROJECT_PLAYBOOK_DIR = '.omd/playbooks';
/** `probeDiscrimination` 所在模块的绝对路径 —— A-3 探针桥要在**子进程里**动态 import 它 (见下)。 */
const ACCEPTANCE_GATE_ABS = join(import.meta.dir, '..', 'goal', 'acceptance-gate.ts');

/** `PlaybookStep` 的严格 schema —— 拒绝未知字段, 免得配置里的笔误静默通过。 */
const stepSchema = z.strictObject({
  doc: z.string(),
  reset: z.boolean().optional(),
});

/** `Playbook` 的严格 schema。`steps`/`loop.maxRounds` 的**取值**校验留给 A-1/A-2 (这里只管形状)。 */
const playbookSchema = z.strictObject({
  name: z.string(),
  steps: z.array(stepSchema),
  loop: z.strictObject({ maxRounds: z.number() }).optional(),
  acceptance: z.strictObject({
    command: z.string(),
    negativeSample: z.strictObject({ path: z.string(), content: z.string() }),
  }),
});

/**
 * 读 `<playbookDir>/playbook.json` 并 `JSON.parse`。**不在这里包错误文案** —— 调用方
 * (`loadPlaybookLayer`) 知道目录名, 这个函数只知道路径, 错误文案的 `<目录名>` 前缀由调用方补。
 */
function parsePlaybookJson(playbookDir: string): unknown {
  return JSON.parse(readFileSync(join(playbookDir, 'playbook.json'), 'utf-8'));
}

/**
 * 结构解析 → A-1 → A-2 → A-3 (固定顺序: 形状不对没资格谈取值, 取值不对没资格谈判据能不能跑)。
 * 抛错即拒收, 错误文案逐字用冻结格式。
 */
function validatePlaybook(raw: unknown, dirName: string, playbookDir: string): Playbook {
  const parsed = playbookSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`[playbook:${dirName}] playbook.json 不符合 Playbook 接口`);
  const pb = parsed.data;
  // 目录名与配置 name 必须一致 —— 否则叠加时"覆盖谁"就说不清 (项目层拿目录名找内置层却按 name 建索引)。
  // 复用同一句"不符合接口"文案: 这本质上也是配置形状与它所在位置不自洽, 没必要另造第七种冻结错误。
  if (pb.name !== dirName) throw new Error(`[playbook:${dirName}] playbook.json 不符合 Playbook 接口`);

  // A-1: 有界不是 prompt 的事, 是 schema 的事 —— 与 iterateTemplate 的 .max(10) 同顶。
  // 注意 `{ maxRounds: 0 }` 与"无 loop"是两件事: 只在 loop 存在时才检查上限, 不用 `loop?.maxRounds ?? 0` 抹平。
  if (pb.loop !== undefined && pb.loop.maxRounds > 10) {
    throw new Error(`[playbook:${pb.name}] loop.maxRounds 超过上限 10: ${pb.loop.maxRounds}`);
  }

  // A-2: steps 非空, 且每个 doc 在该 playbook 目录**内部**真实存在 (且是文件, 不是同名目录)。
  // "内部"不能靠字符串前缀判 —— `join(playbookDir, doc)` 对 `../x.md` 一样会算出一个合法路径,
  // 若那个路径恰好真存在 (比如指到仓库别处一份文件), 字符串前缀判 (或压根不判) 就会放行路径逃逸。
  // 用 `relative(resolvedDir, resolvedDoc)` 判: 结果以 `..` 开头 (或是绝对路径, Windows 跨盘符时会这样)
  // 就是"跑出了 playbook 目录", 不管那个目标是否真实存在, 一律按"步骤文档不存在"拒收 (调用方看不出
  // 差别也不需要看出差别 —— "指到目录外" 和 "压根没这个文件" 对 playbook 而言是同一类坏配置)。
  if (pb.steps.length === 0) throw new Error(`[playbook:${pb.name}] steps 不能为空`);
  const resolvedPlaybookDir = resolve(playbookDir);
  for (const step of pb.steps) {
    const resolvedDoc = resolve(playbookDir, step.doc);
    const rel = relative(resolvedPlaybookDir, resolvedDoc);
    const withinDir = !rel.startsWith('..') && !isAbsolute(rel);
    const exists = withinDir && existsSync(resolvedDoc) && statSync(resolvedDoc).isFile();
    if (!exists) throw new Error(`[playbook:${pb.name}] 步骤文档不存在: ${step.doc}`);
  }

  // A-3: 收敛判据必须可执行 —— command 在自带 negativeSample 上必须真的(且有意义地)非零退出,
  // 否则它是虚判据。判定逻辑本身不重写, 见 probeAcceptanceSync 顶注。
  if (!probeAcceptanceSync(pb.acceptance.command, pb.acceptance.negativeSample, pb.name)) {
    throw new Error(`[playbook:${pb.name}] acceptance.command 必须在 negativeSample 上以非零退出`);
  }

  return { name: pb.name, steps: pb.steps, ...(pb.loop ? { loop: pb.loop } : {}), acceptance: pb.acceptance };
}

/**
 * A-3 的判定逻辑复用 `src/harness/goal/acceptance-gate.ts` 的 `probeDiscrimination` ——
 * **不重写**这套"临时目录 + 反面样本 + 白名单 runner"的判定 (那正是本模块上一版被打回的地方:
 * 自己另起一套 `execFileSync` 直跑, 既绕开了 command-leaf 的白名单闸, 又把"命令跑不起来"
 * (基础设施错误) 和"命令真的非零退出"(判据合格) 用同一个 `catch { return true }` 折叠成一件事)。
 *
 * 问题是签名接不上: `probeDiscrimination` 是 **async**(命令走子进程 spawn), 而冻结接口
 * `loadPlaybooks(cwd): Map<string, Playbook>` 是**同步**函数 —— 校验闸不能在里头 await。
 * 这里写的是**最薄的同步桥**: 用 `spawnSync` 起一个子 bun 进程, 那个子进程只做一件事 ——
 * `import` 并调用真正的 `probeDiscrimination`, 把它的裁决 (`ProbeDiscriminationVerdict`) 原样
 * 序列化成 JSON 打到 stdout。父进程只解析这份 JSON, **不复制**临时目录/路径防逃逸/命令白名单
 * 里的任何一行判定逻辑 —— 那些全在 `acceptance-gate.ts` 里跑, 桥只负责把 async 摆渡成 sync。
 *
 * 分类 (`status` 字段是 `probeDiscrimination` 自己吐的, 桥不改写):
 * - `'ok'`      —— 命令真的运行了, 且在反面样本上给出**有意义的非零退出** (与期望值不同)。
 *                  只有这一种算 A-3 通过。
 * - `'ring'`    —— 命令运行了但**照样通过** (恒真判据) —— 拒。
 * - `'skipped'` —— 反面样本缺失/不合法 —— 拒 (playbook schema 要求 negativeSample 必填, 走到
 *                  这里说明桥给的东西有问题, 不能默认放行)。
 * - `'fail_open'` —— 命令**没能真的跑起来**: 不在白名单 / 路径不合法 / 子进程异常。这正是
 *                  验收人点名的"命令不存在、126/127、桥内异常"一类 —— 必须拒收, **不得**与
 *                  `'ok'` 折叠成同一个"通过"。
 * 桥进程自己起不来 / 超时 / stdout 不是合法 JSON —— 同样按拒收处理 (基础设施错误, 不是判据合格)。
 *
 * 每条失败路径都留一行 `logger.warn`(含 playbook 名 + 原始错误), 不许空 catch —— catch 可以吞
 * 异常本身, 不许吞"为什么拒"的证据。
 */
function probeAcceptanceSync(
  command: string,
  negativeSample: { path: string; content: string },
  playbookName: string,
): boolean {
  let bridgeDir: string | undefined;
  try {
    bridgeDir = mkdtempSync(join(tmpdir(), 'omd-playbook-a3-bridge-'));
    const bridgeFile = join(bridgeDir, 'probe.ts');
    // 桥脚本本身极薄: 只 import 真判据 + 转发 stdin/stdout。ACCEPTANCE_GATE_ABS 是绝对路径,
    // 与桥脚本自己的临时位置无关 (bun 按脚本自身路径解析 import, 桥文件在 tmpdir 里所以不能用相对路径)。
    // stdin 用 `readFileSync(0, ...)` 同步读, 不用 `Bun.stdin.text()` —— 后者在 spawnSync 的管道
    // 场景下不会在写完 EOF 后 resolve (实测挂起, 父进程只能靠 timeout 硬杀), 是桥本身的坑不是判据的坑。
    // 末尾显式 `process.exit(0)`: `probeDiscrimination` 内部经 command-leaf 起过子进程, 即使已
    // resolve, node/bun 的事件循环有时仍留着残余 handle 不退出 —— 不主动退出会让 spawnSync 一直等到
    // 它自己的 timeout, 把"探针早就跑完了"活活拖成"探针超时"。
    // 桥进程内部还会走 command-leaf 的白名单闸, 那道闸自己的 logger(pino, 也写 stdout)会在裁决前
    // 打一行 warn(如"命令不在白名单, 拒绝") —— 与我们要的 JSON 混在同一个 stdout 里。用一个不会
    // 出现在日志文本里的分隔符包住真正的裁决, 父进程只取分隔符**之后**的内容来解析, 不受前面
    // 任何日志行干扰(实测:不加分隔符, `this-binary-does-not-exist-xyz` 这类会触发白名单 warn 的
    // 用例, JSON.parse 会因为 stdout 里混了 warn 文本而失败 —— 那不是"探针跑不起来", 是解析没做对)。
    const MARKER = '\0OMD_PLAYBOOK_A3_RESULT\0';
    writeFileSync(
      bridgeFile,
      [
        `import { probeDiscrimination } from ${JSON.stringify(ACCEPTANCE_GATE_ABS)};`,
        "import { readFileSync } from 'node:fs';",
        "const payload = JSON.parse(readFileSync(0, 'utf-8'));",
        'let verdict;',
        'try {',
        '  verdict = await probeDiscrimination(payload.command, payload.sample, 0);',
        '} catch (err) {',
        "  verdict = { status: 'bridge_error', why: String(err) };",
        '}',
        `process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(verdict));`,
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = spawnSync(process.execPath, [bridgeFile], {
      input: JSON.stringify({ command, sample: negativeSample }),
      encoding: 'utf-8',
      timeout: 30_000,
    });

    if (result.error) {
      // 桥进程压根没能起来 (spawn 本身失败) —— 基础设施错误, 拒收而非放行。
      logger.warn({ playbook: playbookName, err: String(result.error) }, '[playbook] A-3 探针桥启动失败');
      return false;
    }
    if (result.signal) {
      // 被信号杀掉 (含 spawnSync 的 timeout → SIGTERM) —— 命令没能在有限时间内真的跑完, 拒收。
      logger.warn({ playbook: playbookName, signal: result.signal, stderr: result.stderr }, '[playbook] A-3 探针桥被信号终止 (含超时)');
      return false;
    }
    const markerIdx = result.stdout ? result.stdout.indexOf(MARKER) : -1;
    if (markerIdx === -1) {
      logger.warn({ playbook: playbookName, status: result.status, stdout: result.stdout, stderr: result.stderr }, '[playbook] A-3 探针桥无输出');
      return false;
    }

    let verdict: { status?: string; why?: string };
    try {
      verdict = JSON.parse(result.stdout.slice(markerIdx + MARKER.length));
    } catch (err) {
      logger.warn({ playbook: playbookName, stdout: result.stdout, err: String(err) }, '[playbook] A-3 探针桥输出不是合法 JSON');
      return false;
    }

    if (verdict.status === 'ok') return true;
    // ring(恒真) / skipped(样本缺失) / fail_open(命令跑不起来) / bridge_error(桥内异常) 一律拒收 ——
    // 这正是被打回的那条: "命令没跑成"不得与"判据合格"折叠, 只有 'ok' 才是真的验证过。
    logger.warn({ playbook: playbookName, probeStatus: verdict.status, why: verdict.why }, '[playbook] A-3 判别力探针未通过');
    return false;

    if (verdict.status === 'ok') return true;
    // ring(恒真) / skipped(样本缺失) / fail_open(命令跑不起来) / bridge_error(桥内异常) 一律拒收 ——
    // 这正是被打回的那条: "命令没跑成"不得与"判据合格"折叠, 只有 'ok' 才是真的验证过。
    logger.warn({ playbook: playbookName, probeStatus: verdict.status, why: verdict.why }, '[playbook] A-3 判别力探针未通过');
    return false;
  } catch (err) {
    // 建临时目录 / 写桥脚本本身失败 (磁盘满等) —— 同样拒收, 留证据。
    logger.warn({ playbook: playbookName, err: String(err) }, '[playbook] A-3 探针准备阶段异常');
    return false;
  } finally {
    if (bridgeDir) rmSync(bridgeDir, { recursive: true, force: true });
  }
}

/**
 * 读一层目录(内置或项目)里的每个子目录当一个 playbook, 校验后写进 `target`(同名覆盖 —— 调用顺序
 * 决定"谁覆盖谁": 内置层先灌、项目层后灌, 后灌者胜)。目录不存在 = 该层为空, 不是错误。
 */
function loadPlaybookLayer(root: string, target: Map<string, Playbook>): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    // 目录读不了 (权限等) —— 留证据后当场拒收整次加载, 不静默跳过这一层。
    throw new Error(`[playbook] 目录读取失败: ${root} (${String(err)})`);
  }
  for (const dirName of entries) {
    const playbookDir = join(root, dirName);
    let raw: unknown;
    try {
      raw = parsePlaybookJson(playbookDir);
    } catch (err) {
      throw new Error(`[playbook:${dirName}] playbook.json 读取或解析失败: ${String(err)}`);
    }
    const pb = validatePlaybook(raw, dirName, playbookDir);
    target.set(pb.name, pb);
  }
}

/**
 * 内置 `templates/playbooks/` + `<cwd>/.omd/playbooks/` 叠加, 项目层同名胜。
 * 三道闸 (A-1/A-2/A-3) 见 `validatePlaybook`; 任一 playbook 不过闸 → 整次调用抛错
 * (不是 fail-open —— 一份坏 playbook 不该被静默丢弃, 见文件顶注)。
 */
export function loadPlaybooks(cwd: string): Map<string, Playbook> {
  const target = new Map<string, Playbook>();
  loadPlaybookLayer(BUILTIN_PLAYBOOK_DIR, target);
  loadPlaybookLayer(join(cwd, PROJECT_PLAYBOOK_DIR), target);
  return target;
}
