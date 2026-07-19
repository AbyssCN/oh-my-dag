/**
 * src/harness/review/verify —— finding 收敛层(不加发散加收敛)。
 *
 * 动机(实测):多维 find 层共享 diff-only 盲区,大量误报是多维度独立撞同一条错
 * (换 persona ≠ 换证据)。改法 = find 层不动,出口前对每条 finding 做
 * **script 侧确定性取证**(读 file:line 上下文 + ugrep 符号真身,leaf 拿不到的仓库事实)
 * + **model 侧证伪裁决**(refute checklist 抓三大系统性误报模式)。
 * 出口只放 CONFIRMED;REFUTED 留档;裁决失败 → UNVERIFIED(fail-open,不静默丢真伤)。
 */
import { $ } from 'bun';
import { send } from '../../model/gateway';

/** 可注入的模型调用 (测试 fake generate 用; 默认 gateway send)。 */
export type ReviewSendFn = typeof send;

export interface ExtractedFinding {
  severity: 'P0' | 'P1';
  file: string;
  line?: number;
  claim: string;
  /** claim 涉及的关键符号(函数/导出/表名),script 侧 ugrep 真身用。 */
  symbols: string[];
  dimension: string;
}

export interface VerifiedFinding extends ExtractedFinding {
  verdict: 'CONFIRMED' | 'REFUTED' | 'UNVERIFIED';
  reason: string;
}

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1]! : s).trim();
}

/** 结构化归一 key:同 file + claim 归一前缀 视为同一条(跨 lens 撞同一 bug 才折叠)。 */
function findingKey(f: ExtractedFinding): string {
  const claim = (f.claim ?? '').toLowerCase().replace(/\s+/g, '').slice(0, 50);
  return `${f.file}::${claim}`;
}

/**
 * 维度散文 → 结构化 finding 清单。
 *
 * **实证教训(一条 correctness P0 authz 真伤曾在此层被静默丢)**:
 * 旧实现 = 单次 model 调用把多维文本一起喂,且**兼做裁决**(排除"维度已推翻")+ 跨维去重
 * —— 跨多段长文本召回不稳(model 漏发一条即永久消失,不进存活也不进证伪)。
 * 新实现三点:① **每维度独立提取**(单 lens 文本喂一次 → 高召回,不跨段丢条)
 * ② **只结构化不裁决**(证伪是下游 verifyOne 的事,extract 不排除任何条目)
 * ③ **保守确定性去重**(同 file+claim 前缀才折叠;宁留重复,绝不丢真伤)。
 */
export async function extractFindings(
  dimensionTexts: { dimension: string; text: string }[],
  model: string,
  sendFn: ReviewSendFn = send,
): Promise<ExtractedFinding[]> {
  const perDim = await Promise.all(
    dimensionTexts.map(async (d): Promise<ExtractedFinding[]> => {
      if (!d.text?.trim()) return [];
      const res = await sendFn({
        model,
        messages: [{
          role: 'user',
          content: `下面是"${d.dimension}"维度代码审查的原始输出。把其中**每一条** P0/P1 主张
结构化提取出来。**不要判断真假、不要排除任何条目**(证伪是下游的事,这里只做结构化);
宁可多提不可漏提。只输出 JSON 数组,无其它文字:
[{"severity":"P0|P1","file":"repo相对路径","line":123,"claim":"一句话主张",
"symbols":["涉及的函数/导出/表名"],"dimension":"${d.dimension}"}]
没有 P0/P1 输出 []。

${d.text}`,
        }],
      });
      try {
        const arr = JSON.parse(stripFence(res.text)) as ExtractedFinding[];
        return Array.isArray(arr)
          ? arr.filter((f) => f?.file && f?.claim).map((f) => ({ ...f, dimension: d.dimension }))
          : [];
      } catch {
        return [];
      }
    }),
  );

  // 保守去重:只折叠 file+claim 前缀相同的(跨 lens 撞同一条);措辞不同的近似条目宁留重复。
  const seen = new Map<string, ExtractedFinding>();
  for (const f of perDim.flat()) {
    const key = findingKey(f);
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

/** script 侧确定性取证:file:line 上下文 + 符号全仓真身(leaf 在 find 层拿不到的事实)。 */
async function gatherEvidence(f: ExtractedFinding, cwd: string): Promise<string> {
  const parts: string[] = [];
  const file = Bun.file(`${cwd}/${f.file}`);
  if (await file.exists()) {
    const lines = (await file.text()).split('\n');
    const at = Math.max(0, (f.line ?? 1) - 1);
    const lo = Math.max(0, at - 30);
    const hi = Math.min(lines.length, at + 30);
    parts.push(`### ${f.file} 第 ${lo + 1}-${hi} 行(现行真身)\n${lines.slice(lo, hi).map((l, i) => `${lo + i + 1}\t${l}`).join('\n')}`);
  } else {
    parts.push(`### ${f.file} 不存在于仓库`);
  }
  for (const sym of (f.symbols ?? []).slice(0, 4)) {
    // 取末段成员名(declarationStore.list → list),ERE 词界匹配定义/调用址。
    const leaf = sym.includes('.') ? sym.split('.').pop()! : sym;
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 定义/实现址优先 + 函数体上下文(-A 8):裁决 leaf 要看到守卫/排序/校验真身,
    // 而非散落调用行号——「未保证排序/缺守卫」类误报正靠这段体内 .sort()/JOIN 证伪。
    // ugrep 缺失 → grep -E 兜底 (nothrow, 证据缺失时裁决自然偏 CONFIRMED 升人工)。
    const def = (await $`sh -c ${`(ugrep -rn --no-heading -A 8 -E '\\b${esc}\\b\\s*[(:=]' src apps packages 2>/dev/null || grep -rn -A 8 -E '\\b${esc}\\b\\s*[(:=]' src apps packages 2>/dev/null) | head -48`}`
      .cwd(cwd).nothrow().text()).trim();
    const hits = def || (await $`sh -c ${`(ugrep -rn -F -w -A 4 '${leaf}' src apps packages 2>/dev/null || grep -rn -F -w -A 4 '${leaf}' src apps packages 2>/dev/null) | head -24`}`
      .cwd(cwd).nothrow().text()).trim();
    parts.push(`### 符号 \`${sym}\` 定义/实现真身(带函数体上下文)\n${hits || '(无命中)'}`);
  }
  return parts.join('\n\n').slice(0, 8000);
}

/** 单条证伪裁决(refute-first;裁决词解析失败 → UNVERIFIED fail-open)。 */
async function verifyOne(
  f: ExtractedFinding,
  cwd: string,
  model: string,
  verdictEffort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh',
  sendFn: ReviewSendFn = send,
): Promise<VerifiedFinding> {
  try {
    const evidence = await gatherEvidence(f, cwd);
    const res = await sendFn({
      model,
      thinkingLevel: verdictEffort,
      messages: [{
        role: 'user',
        content: `你是审查 finding 的证伪裁决员。finding 来自只看 diff 文本的审查器,
已知三大系统性误报模式:① 声称"X 未导出/未定义"但 X 是 diff 外既有代码
② 声称"缺权限守卫"但守卫以 JOIN/EXISTS 形式已在查询里 ③ 用"可能/如果内部没有校验"
推测而非查证。下面给你**仓库现行真身证据**(finding 作者没有的信息),据此裁决:

FINDING [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.claim}

${evidence}

规则:证据表明主张不成立 → REFUTED;证据支持主张 → CONFIRMED;证据不足以判 → CONFIRMED
(宁可放进人工终裁,不静默吞真伤)。第一行只输出 VERDICT: CONFIRMED 或 VERDICT: REFUTED,
第二行一句话依据(引证据行号)。`,
      }],
    });
    const m = res.text.match(/VERDICT:\s*(CONFIRMED|REFUTED)/i);
    let verdict: VerifiedFinding['verdict'];
    if (m) {
      verdict = m[1]!.toUpperCase() as VerifiedFinding['verdict'];
    } else {
      // leaf 未遵格式(hedge 成散文)→ 读意图,不默认泄 UNVERIFIED:
      // 明确证伪词(已排序/守卫/导出/不成立…)→ REFUTED;否则 CONFIRMED(升人工终裁,不静默吞真伤)。
      verdict = /不成立|已(排序|校验|守卫|导出|防呆|过滤)|内部(已|自)|推翻|驳回|误报|refut|not a (bug|real|valid)|no (bug|issue)/i
        .test(res.text) ? 'REFUTED' : 'CONFIRMED';
    }
    const reason = res.text.split('\n').slice(m ? 1 : 0).join(' ').trim().slice(0, 300);
    return { ...f, verdict, reason };
  } catch (e) {
    return { ...f, verdict: 'UNVERIFIED', reason: `verify 调用失败: ${(e as Error).message.slice(0, 120)}` };
  }
}

/** 收敛层入口:extract → 并发取证+裁决。findings 为空 → []。 */
export async function verifyFindings(
  dimensionTexts: { dimension: string; text: string }[],
  opts: {
    model: string;
    cwd?: string;
    verdictEffort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh';
    /** 注入模型调用 (测试用; 默认 gateway send)。 */
    send?: ReviewSendFn;
  },
): Promise<VerifiedFinding[]> {
  const cwd = opts.cwd ?? process.cwd();
  const sendFn = opts.send ?? send;
  // extract = 纯结构化(JSON 抽取), 不吃 effort; 只有 verdict 判决焚推理 (verdictEffort)。
  const extracted = await extractFindings(dimensionTexts, opts.model, sendFn);
  if (extracted.length === 0) return [];
  return Promise.all(extracted.map((f) => verifyOne(f, cwd, opts.model, opts.verdictEffort, sendFn)));
}
