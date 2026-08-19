/**
 * goal/design-review-mechanical —— **审核的机械层前置** (#98, owner 2026-08-11 persona 判序①)。
 *
 * ## 为什么要有它
 *
 * design-review 今天一上来就调模型。而 `impeccable` 那套里已经有一个**确定性、零 LLM** 的
 * 反模式检测器 (`.omd/skills/impeccable/scripts/detect.mjs`), 它认得出边框/动效/辉光/排版/
 * 布局/HTML 那一族「AI 生成界面的口音」。这些规则命中**是事实不是意见** —— 拿模型去重新
 * 发现一遍, 既慢又贵, 而且模型还可能漏。
 *
 * 判序①: **机械层先跑, 命中直接落 finding; 模型只审机械层拦不住的整读与品味。**
 *
 * ## 接之前先验它会不会响 (2026-08-19 实测)
 *
 * 一个恒返空的检测器接进来 = 又一个零方差仪器 (#199 刚踩过: 判别力探针 66/66 全过, 量的是尺子)。
 * 所以接线前在**本仓真文件**上跑过:
 *   · `web/index.html` → `overused-font` (Google Fonts: inter, line 12)
 *   · `docs/design/2026-08-07-…设计稿.html` → `side-tab` (border-left:3px solid, line 28) + `em-dash-overuse`
 *   · `src/serve/board-page.ts` / `src/tui` → `[]` (那里确实没有前端反模式)
 * **它会响, 也会不响** —— 这才是一把在量被测物的尺子。
 *
 * ## 指纹 = (位置, 规则)
 *
 * 票面说「规则 id 即指纹」。这里**不另造一套指纹**, 仍走 `fingerprintOf(where, evidence)` 的
 * 冻结契约 (`validateFinding` 会逐条校验它) —— 只是把**规则 id 放进 evidence**, 于是同一处
 * 同一条规则恒得同一指纹, 效果就是票面要的那个。另造一套会让机械 finding 与模型 finding
 * 的去重各走各路, 而台账的全部价值在于两者能互相认出来。
 */
import { fingerprintOf, type ReviewFinding } from '../profiles/review-ledger';
import { logger } from '../logger';

/** 检测器一条命中的形状 (只取我们用得上的字段; 多余字段忽略)。 */
interface DetectorHit {
  antipattern?: unknown;
  name?: unknown;
  description?: unknown;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  snippet?: unknown;
}

/** 检测器脚本相对仓根的位置 (skill 自带, 随 `.omd/skills/` 分发)。 */
export const DETECTOR_SCRIPT = '.omd/skills/impeccable/scripts/detect.mjs';

/**
 * 检测器 severity → 台账 severity。
 *
 * **刻意全部落 p2**: 机械层认的是「口音」(过度使用的字体 / 侧边强调条 / em-dash 密度), 它们是
 * **确定的观察**但不是**确定的缺陷** —— 一条 `border-left:3px` 在某些设计里就是对的。
 * 把确定性规则的命中升成 p0/p1 会让 D-4 升档 (P0/P1 → 调强模型复审) 被一堆风格项占满,
 * 而那正是这一层要省下来的钱。要改这条先回 owner 重定判序①。
 */
const MECHANICAL_SEVERITY: ReviewFinding['severity'] = 'p2';

/** 把检测器命中转成台账 finding; 形状不对的丢弃并留痕 (fail-open 可以吞异常, 不许吞证据)。 */
export function hitToFinding(hit: DetectorHit, cwd: string): ReviewFinding | null {
  const rule = typeof hit.antipattern === 'string' ? hit.antipattern : '';
  const file = typeof hit.file === 'string' ? hit.file : '';
  if (!rule || !file) return null;
  // 路径归一到相对仓根 —— 检测器吐绝对路径, 而 `where` 要跨机器可比 (指纹里含它)。
  const rel = file.startsWith(cwd) ? file.slice(cwd.length).replace(/^\//, '') : file;
  const line = typeof hit.line === 'number' && Number.isFinite(hit.line) ? `:${hit.line}` : '';
  const snippet = typeof hit.snippet === 'string' && hit.snippet ? ` — ${hit.snippet}` : '';
  const where = `${rel}${line}`;
  // evidence 里带规则 id ⇒ 同一处同一规则恒同指纹 (票面「规则 id 即指纹」的效果)。
  const evidence = `[${rule}]${snippet}`;
  const suggestion = typeof hit.description === 'string' && hit.description ? hit.description : `修掉 ${rule}`;
  return {
    where,
    severity: MECHANICAL_SEVERITY,
    evidence,
    suggestion,
    // D-5「不确定就写」的机械侧答案: 这一条**没有推断**, 是规则匹配。写清楚才不会被读成模型判断。
    uncertainty: `无推断 — 确定性规则 ${rule} 命中 (机械层, 零 LLM)`,
    fingerprint: fingerprintOf(where, evidence),
  };
}

export interface MechanicalDeps {
  /** 跑检测器; 返回 stdout。注入面 —— 测试永不起真进程。 */
  run?: (script: string, targets: string[], cwd: string) => { stdout: string; exitCode: number };
}

/**
 * 跑机械层, 返回 findings。
 *
 * **fail-open 且留证据**: 脚本缺席 / 非零退出 / JSON 解析不了 → 返 `[]` 并 warn, **不拦**审核 ——
 * 机械层是前置加固, 不是前置条件 (同 acceptance-gate 那两道探针的纪律)。
 * ⚠ 返 `[]` 因此有两个意思 (没命中 / 没跑成), 调用方要分辨就看日志 —— 这里不编第三个值,
 * 因为下游对两者的动作相同 (都得让模型接着审)。
 */
export function runMechanicalLayer(files: string[], cwd: string, deps: MechanicalDeps = {}): ReviewFinding[] {
  if (files.length === 0) return [];
  const run =
    deps.run ??
    ((script, targets, root) => {
      const r = Bun.spawnSync(['node', script, '--json', ...targets], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      return { stdout: new TextDecoder().decode(r.stdout), exitCode: r.exitCode };
    });
  let out: { stdout: string; exitCode: number };
  try {
    out = run(DETECTOR_SCRIPT, files, cwd);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, '[omd/design-review] 机械层跑不起来 → 跳过 (fail-open, 模型层照审)');
    return [];
  }
  // ⚠ **退出码不是"成没成"** —— 这个检测器走 lint 惯例: **命中即非零** (实测 2026-08-19:
  // 无命中 → 0; `web/index.html` 命中 overused-font → **2**, 而 stdout 是完整的 JSON)。
  // 第一版把「非零 = 跑不起来」写进 fail-open, 于是它**恰好把自己存在的唯一理由扔了**:
  // 有命中的那次全被丢掉, 只有无命中的那次被收下 —— 一把只在没东西时才读数的尺子。
  //
  // 所以判据改成**能不能解析出 JSON 数组**, 不看退出码。退出码只进日志当旁证。
  let hits: unknown;
  try {
    hits = JSON.parse(out.stdout || '[]');
  } catch {
    logger.warn(
      { exitCode: out.exitCode, head: out.stdout.slice(0, 160) },
      '[omd/design-review] 机械层输出不是 JSON → 跳过 (fail-open); 退出码只是旁证, 判据是能不能解析',
    );
    return [];
  }
  if (!Array.isArray(hits)) return [];
  const findings: ReviewFinding[] = [];
  for (const h of hits) {
    const f = hitToFinding(h as DetectorHit, cwd);
    if (f) findings.push(f);
    else logger.warn({ hit: JSON.stringify(h).slice(0, 160) }, '[omd/design-review] 机械层命中形状不对 → 丢弃这一条');
  }
  return findings;
}
