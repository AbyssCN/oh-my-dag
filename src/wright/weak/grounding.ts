/**
 * weak/grounding —— L2 承重柱: 法定数字必 grounding (SDD §6 / D67), R5 三层拆分。
 *
 * 弱模型最危险的失败 = 自信地编一个**法定数字** (memory: DeepSeek 说 ALV 24%, 实际
 * 25.5%)。这层不靠模型自觉, 靠与模型无关的代码闸。R5 后拆成三层 (镜像 safeguard 注入):
 *
 *   ① 机制 (本文件, OPEN CORE, domain-free): "命中可疑声明 → 要求引文 → 按 severity 动作"
 *      的通用引擎。它**不知道**什么算法定数字 —— 词表是注入的。默认 EMPTY_LEXICON
 *      (零 pattern) → 通用部署什么都不触发, 绝不误伤。
 *   ② 词表 (domain pack, R5): 什么算"必 grounding 的声明" (芬兰 ALV/Finlex/KILA 的正则)
 *      住 src/domain/a sibling project/grounding-lexicon.ts, 部署在边界注入。开源 wright 不打包。
 *   ③ 严格度 (profile): severity = off | annotate | block。**开源默认 annotate** (检出裸
 *      法定数字只追加一行免责声明, 绝不拦), 仅 a sibling project 审计部署设 block。verifier 是 D 的
 *      RAG 验真钩子 (数字对 Vero/Finlex 真理源), 本机制层只留 seam, 不实装。
 *
 * fact-write 路径另算: 任何写进记忆的 fact 必过 validateFactWrite (已强制 source anchor),
 * 见 {@link factWriteIsGrounded} —— 那条不分域, 源锚定不变量与 namespace 无关。
 *
 * 这是启发式 (正则) 的散文闸: 职责是**召回**可疑声明 (宁可错杀), 真值由引文 / verifier 背书。
 */
import { validateFactWrite } from '../../memory/safeguards/validator';

// ---------------------------------------------------------------------------
// ① 机制层类型 (open core, domain-free)
// ---------------------------------------------------------------------------

/** 检出的声明。kind 由注入词表定义 (开放 string, 非硬编 union)。 */
export interface LegalClaim {
  /** 命中类别 (词表定义, 如 'vat_rate' / 'statutory_deadline')。 */
  kind: string;
  /** 命中的原文片段。 */
  span: string;
}

/** 一条召回规则: 命中即"必须 grounding"。 */
export interface GroundingPattern {
  kind: string;
  re: RegExp;
}

/**
 * 注入式词表 —— 决定"什么算必 grounding 的声明" + 哪些算"声称有源"的领域标记。
 * 开源 core 默认 {@link EMPTY_LEXICON} (零 pattern, 什么都不触发); domain pack 注入。
 */
export interface GroundingLexicon {
  /** 召回规则。空 = 什么都不触发 (开源默认, 零误伤)。 */
  patterns: ReadonlyArray<GroundingPattern>;
  /** 领域专属引文标记 (如 finlex.fi/vero.fi)。与通用标记取并集判定。 */
  citationMarkers: ReadonlyArray<RegExp>;
}

/** 开源 core 默认词表: domain-free, 检出 nothing。部署经 config.lexicon 注入领域词表。 */
export const EMPTY_LEXICON: GroundingLexicon = { patterns: [], citationMarkers: [] };

/**
 * 通用引文标记 (与领域无关的引用约定) —— 任何词表都先认这些, 再并上自己的领域标记。
 * URL / [source:…] / [ref|cite|来源|出处:…] 是跨域通用的"声称有源"形式。
 */
export const UNIVERSAL_CITATION_MARKERS: ReadonlyArray<RegExp> = [
  /https?:\/\/\S+/i,
  /\[source:[^\]]+\]/i,
  /\[(?:ref|cite|来源|出处)[:：][^\]]+\]/i,
];

/** ③ 严格度 profile: 检出无源声明时的动作。 */
export type GroundingSeverity = 'off' | 'annotate' | 'block';

/** 调用方应执行的动作 (severity 应用后的结论)。 */
export type GroundingAction = 'pass' | 'annotate' | 'block';

/** D 的 RAG 验真钩子: 给定声明, 判其数值是否符合权威源。本机制层不实装, 仅留 seam。 */
export type GroundingVerifier = (claim: LegalClaim) => boolean;

export interface GroundingConfig {
  /** 注入词表。默认 EMPTY_LEXICON (开源 domain-free)。 */
  lexicon?: GroundingLexicon;
  /** 严格度。默认 'annotate' (检出即标注不拦, 开源安全默认)。 */
  severity?: GroundingSeverity;
  /** D 的验真钩子 (a sibling project RAG)。给定时, 有引文的声明还需 verifier 通过才算 grounded。 */
  verifier?: GroundingVerifier;
}

export interface GroundingVerdict {
  /** true = 无可疑声明, 或全部有引文背书 (且 verifier 若有也通过)。 */
  grounded: boolean;
  /** 检出的声明 (即使 grounded:true 也回, 供审计)。 */
  claims: LegalClaim[];
  /** 调用方应执行的动作 (severity 应用后)。 */
  action: GroundingAction;
  /** action='annotate' 时, 建议追加到输出的免责声明。 */
  notice?: string;
  /** 不通过的理由 (grounded:false 时)。 */
  reason?: string;
}

// ---------------------------------------------------------------------------
// 机制实现
// ---------------------------------------------------------------------------

/** 扫描散文, 按注入词表返回所有命中片段 (去重)。空词表 → 永远空。 */
export function detectLegalClaims(
  text: string,
  lexicon: GroundingLexicon = EMPTY_LEXICON,
): LegalClaim[] {
  const out: LegalClaim[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of lexicon.patterns) {
    // 全局正则需重置 lastIndex (复用同一 RegExp 对象)。
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = `${kind}:${m[0].toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, span: m[0] });
      }
      if (m.index === re.lastIndex) re.lastIndex++; // 防零宽匹配死循环
    }
  }
  return out;
}

/**
 * 散文 grounding 闸 (三层): 按注入词表召回可疑声明, 无引文 (且 verifier 不背书) → 不 grounded;
 * 动作由 severity 决定。**默认 EMPTY_LEXICON + 'annotate'** → 开源部署不触发 / 触发也只标注不拦,
 * 绝不误伤普通对话。a sibling project 部署注入芬兰词表 + severity:'block' (+ D 的 verifier) 才硬拦。
 */
export function checkProseGrounding(text: string, config: GroundingConfig = {}): GroundingVerdict {
  const lexicon = config.lexicon ?? EMPTY_LEXICON;
  const severity = config.severity ?? 'annotate';
  const claims = detectLegalClaims(text, lexicon);

  if (claims.length === 0) return { grounded: true, claims, action: 'pass' };

  const markers = [...UNIVERSAL_CITATION_MARKERS, ...lexicon.citationMarkers];
  const hasCitation = markers.some((re) => re.test(text));
  // verifier (D/RAG): 给定时, 有引文还需逐条验真; 任一不背书即不 grounded。未注入 → 仅判引文存在。
  const verified = config.verifier ? claims.every((c) => config.verifier!(c)) : true;
  const grounded = hasCitation && verified;

  if (grounded) return { grounded: true, claims, action: 'pass' };

  const spans = claims.map((c) => c.span).join(' / ');
  const reason = config.verifier && hasCitation
    ? `检出 ${claims.length} 个法定声明, 有引文但 verifier 未背书其数值: ${spans}`
    : `检出 ${claims.length} 个法定声明但无引文背书: ${spans}`;

  if (severity === 'off') return { grounded: false, claims, action: 'pass', reason };
  if (severity === 'block') return { grounded: false, claims, action: 'block', reason };
  // 'annotate' (默认): 不拦, 追加免责声明。
  return {
    grounded: false,
    claims,
    action: 'annotate',
    reason,
    notice: `⚠️ 以下法定数字未经源校验, 请自行核实: ${spans}`,
  };
}

/**
 * fact-write 路径的 grounding = validateFactWrite 已强制 source anchor (与域无关)。此处薄封装,
 * 让 L2 两条路径同名可见: 一个 fact 无源 → false (validateFactWrite reject)。
 */
export function factWriteIsGrounded(fact: unknown): boolean {
  const r = validateFactWrite(fact);
  return r.ok;
}
