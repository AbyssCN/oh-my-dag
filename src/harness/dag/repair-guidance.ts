/**
 * src/harness/dag/repair-guidance —— Tier-0 事件触发召回:修复轮的可教指引登记表。
 * (grill 票 4,契约 C-5;D-15 按 2026-08-10 实证修订 —— 见下)
 *
 * ## 形状
 *
 * 触发 = 引擎确定性信号(verifier 判词/失败证据原文的**窄 fingerprint**),零 LLM 零 embedding;
 * 匹配 = 受控精确键(每条带历史样本出处,不做语义聚类);
 * 注入点 = escalation 的 escTask(`engine.ts` 修复轮任务文本)。
 *
 * ## D-15 修订(为什么是「注入强化」不是「跳过修复轮」)
 *
 * grill 原判(C-4)拟让形式红不进补丁轮。2026-08-10 夜三图给了两侧读数把它改了:
 *   · S5 N0a(gate-rejected)修复轮**改写后修成**——跳过形状会挡住这次自愈;
 *   · S6 N1b 消费 N4 报告四项全中——补丁轮对语义红高效;
 *   · 真正的浪费 = **没带指引的盲修**(样本 G 烧一轮才悟出改写)与
 *     **可根因消灭的类**(merge-base 已入白名单,一行灭全类)。
 * 所以本模块把「上次怎么处置的」直接喂给修复轮;「跳过」判据缓议至 S-B
 * (dispatch 层座位存活重解析落地后,座位死类在 escalation 根本不会出现)。
 *
 * ## 纪律
 *
 * 加新条目三问:① 触发原文是确定性的引擎/工具输出吗(不是 LLM 措辞)?
 * ② 指引给的是**处置路**不是任务改写吗?③ 历史样本锚(NOTES/commit)写了吗?
 * pattern 宁窄勿宽 —— 误注入的指引会把修复轮带偏(node-failure.ts 同款警告:
 * 「宁可窄而准,不靠输出正则去猜」;这里允许正则只因触发面是引擎自产的固定判词)。
 *
 * ## 纠正台账(owner 2026-08-17:leaf 被纠正 → 持久迭代,不靠改码重建)
 *
 * 内置表之外,`<root>/.omd/repair-guidance.jsonl` 是**项目级追加源**(同 agent-templates
 * 的 .omd/agents 先例):每行一条 `{"id","pattern","guidance","anchor","flags"?}`。
 * 验尸/收编时抓到一条可指纹化的 leaf 纠正 → append 一行,下一次同形失败在修复轮直接吃到
 * 处置路 —— 这就是「被纠正 → 迭代」的记录方法。三问纪律照过:anchor(runId/NOTES 引用)
 * **必填**,缺锚的行拒载(纪律③ 的机器化)。同 id 覆盖内置(允许不改码修正内置指引)。
 * 坏行(JSON 坏 / regex 坏 / 缺字段)→ warn 留原行证据 + 跳过,永不阻断修复轮(fail-open
 * 吞异常不吞证据)。不可指纹化的纠正不进这里 —— 那是 memory 层(advisory)的活,见 #146。
 * ⚠ .omd/ 在 .gitignore 里 → 台账是机器本地件;反复被命中、值得跨机器的条目**提干进上面的
 * 内置表**(带测试与历史锚),台账里同 id 行即可删 —— 台账是暂存区,内置表才是真源。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';

export interface RepairFingerprint {
  /** 受控键(唯一;NOTES 样本对照用)。 */
  id: string;
  /** 匹配失败证据原文。窄而准;每条注释带历史样本出处。 */
  pattern: RegExp;
  /** 可教指引:处置路,不改任务目标。注入 escTask 后修复轮照做。 */
  guidance: string;
}

export const REPAIR_FINGERPRINTS: readonly RepairFingerprint[] = [
  {
    // 样本 G (NOTES 2026-08-10, run 96fc81e2 N0a): 引擎自产判词, 原文
    // `[blocked git-write: 'merge-base' ∉ 只读子命令 status/diff/...]` (command-leaf.ts:319)
    id: 'git-subcommand-blocked',
    pattern: /\[blocked git-write: '[^']+' ∉ 只读子命令/,
    guidance:
      'command 节点的 git 子命令不在只读白名单 —— 不是代码错。补丁只改该节点:' +
      '① 换白名单内等价命令 (rev-parse/cat-file/log 等);② 该检查挪进 agent 节点执行。' +
      '不要改任务目标;若子命令本身确属只读, 白名单登记是引擎侧修法 (merge-base 2026-08-10 已入)。',
  },
  {
    // S2 票 A (NOTES 2026-08-09): bun 把 `bun x` 的 x 当脚本名, 原文 `error: Script not found "x"`
    // (command-leaf.ts:296 注)。2ca019a 已在闸层拒得可教; 本条覆盖老 server/漏网形态。
    id: 'bun-x-form',
    pattern: /Script not found "x"/,
    guidance: '`bun x` 应写 `bunx` (bun 把 x 当脚本名)。补丁只改命令形式, 不动节点目标与依赖。',
  },
  {
    // 样本 A/B/C/D (NOTES 2026-08-09 座位事故): 403 计费周期耗尽 = 周期级下线。
    id: 'seat-quota-403',
    pattern: /403[\s\S]{0,120}(配额|耗尽|quota|Forbidden)|(配额|耗尽|quota)[\s\S]{0,120}403/,
    guidance:
      '座位配额耗尽 (403, 周期级) —— 重试/改 prompt 无效, 该座位到计费周期边界前都不可用。' +
      '补丁只做一件事: 把死座节点的 model 重钉到已知活座 (deepseek 族), 其余字段逐字保留。' +
      '(S4 二派实证: 补丁重钉座位有效; plan 级 pin 不会自愈, 必须显式改。)',
  },
  {
    // 样本 A (NOTES 2026-08-09): mimo 429 周限 ~7h 复位, 瞬时退避拦不住周期窗。
    id: 'seat-rate-429',
    pattern: /\b429\b[\s\S]{0,120}(rate|限|Too Many|too many)|(rate limit|Too Many Requests)[\s\S]{0,80}\b429\b/,
    guidance:
      '座位限流 (429) —— 若为周期窗 (如日/周限) 而非瞬时, 重试无效。补丁把该节点 model' +
      '重钉到别的活座, 其余字段逐字保留。',
  },
  {
    // 样本 E (NOTES 2026-08-09, run 50607a26): agent 叶 WS 断连, 原文
    // `WebSocket closed 1006 Connection ended`; 单发探针绿不覆盖 agent 循环路。
    id: 'agent-ws-1006',
    pattern: /WebSocket closed 1006|Connection ended/,
    guidance:
      'agent 叶 WS 传输层断连 (非代码错, 非任务错)。补丁把该节点改钉别的座位家族, ' +
      '或把纯确定性工作改成 command 节点; 不要改任务目标。(探针绿只覆盖单发路, 不覆盖 agent 叶位。)',
  },
  {
    // S2 票 B (NOTES 2026-08-09): 零写入预期的验证节点被产物闸误杀, 实质工作全对;
    // 判词原文含「filesTouched 空」(node-failure.ts:172 evidence)。
    id: 'empty-artifact-zero-write',
    pattern: /filesTouched 空|empty-artifact/,
    guidance:
      '产物闸判空 —— 若该节点是纯验证/纯自查 (零写入预期), 它的实质工作可能全对:' +
      '补丁给它声明 output_path 让判词/报告落文件, 而不是改写它的检查逻辑。',
  },
];

/** 纠正台账文件(root 相对)。追加式 JSONL,格式与纪律见文件头「纠正台账」节。 */
export const REPAIR_LEDGER_FILE = '.omd/repair-guidance.jsonl';

/**
 * 加载生效登记表 = 内置表 + root 纠正台账(同 id 台账覆盖内置,登记序 = 内置序 + 台账行序)。
 * 台账缺席 → 纯内置(零变化)。坏行 warn 带原行证据 + 跳过,永不抛(修复轮不因台账坏而断)。
 */
export function loadRepairFingerprints(opts: { root?: string } = {}): RepairFingerprint[] {
  const file = join(opts.root ?? process.cwd(), REPAIR_LEDGER_FILE);
  if (!existsSync(file)) return [...REPAIR_FINGERPRINTS];
  const byId = new Map<string, RepairFingerprint>(REPAIR_FINGERPRINTS.map((f) => [f.id, f]));
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch (err) {
    logger.warn({ file, err: (err as Error).message }, '[omd/repair-guidance] 纠正台账读取失败 → 纯内置 (fail-open)');
    return [...REPAIR_FINGERPRINTS];
  }
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    let entry: { id?: unknown; pattern?: unknown; guidance?: unknown; anchor?: unknown; flags?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      logger.warn({ file, lineNo: i + 1, line: line.slice(0, 120) }, '[omd/repair-guidance] 台账行 JSON 坏 → 跳过 (证据在此)');
      continue;
    }
    const { id, pattern, guidance, anchor, flags } = entry;
    if (typeof id !== 'string' || !id || typeof pattern !== 'string' || !pattern || typeof guidance !== 'string' || !guidance) {
      logger.warn({ file, lineNo: i + 1, line: line.slice(0, 120) }, '[omd/repair-guidance] 台账行缺 id/pattern/guidance → 跳过');
      continue;
    }
    if (typeof anchor !== 'string' || !anchor.trim()) {
      logger.warn({ file, lineNo: i + 1, id }, '[omd/repair-guidance] 台账行缺 anchor (历史样本锚, 纪律③) → 拒载');
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, typeof flags === 'string' ? flags : undefined);
    } catch (err) {
      logger.warn({ file, lineNo: i + 1, id, err: (err as Error).message }, '[omd/repair-guidance] 台账行 regex 坏 → 跳过');
      continue;
    }
    byId.set(id, { id, pattern: re, guidance });
  }
  return [...byId.values()];
}

/**
 * 对失败证据原文跑登记表,返回命中的可教指引(按 id 去重,保持登记序)。
 * 零命中 → 空数组(escTask 零变化 —— 本模块对无指纹的失败完全中立)。
 * fingerprints 缺省内置表;要吃纠正台账的调用方传 `loadRepairFingerprints({ root })`。
 */
export function collectRepairGuidance(evidence: string, fingerprints: readonly RepairFingerprint[] = REPAIR_FINGERPRINTS): string[] {
  const out: string[] = [];
  for (const f of fingerprints) {
    if (f.pattern.test(evidence)) out.push(`[修复指引 ${f.id}] ${f.guidance}`);
  }
  return out;
}
