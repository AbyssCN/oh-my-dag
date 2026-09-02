/**
 * harness/report/trailer-audit —— **尾块 vs 引擎记录**的确定性差集(P3 S3 / D-13 / INV-6)。
 *
 * 此前「声称 vs 事实」靠散文正则(`plan/claimed-actions.ts`), 已知误伤指令句与整改回执, 所以只报不拦。
 * 尾块把事实面从散文挪到七个字段, 差集就成了程序可判的谓词:
 *   · `acceptance_ran: true` 而引擎记录 `acceptance.ran === false` → **red**(谎报跑过验收);
 *   · `changed` 里有引擎写集核实之外的路径 → **red**(声称改了引擎没看见的文件);
 *   · `acceptance_exit` 与引擎自己跑出的退出码不一致 → **notice**(记错数比谎报轻, 只报);
 *   · 记录面**缺格**(视图没带过来)→ **notice** + 一行证据, **不判红**(D-24: 别把「视图漏格」报成「模型谎报」);
 *   · 尾块缺席 → 合成 + `self_report:'missing'`, **不判红**(INV-5)。
 *
 * 证伪方式(trailer-audit.test.ts): 把 `record.acceptance === undefined` 那格改成判红 → 「缺格 → notice」即红;
 * 把缺席分支改成 red → INV-5 那格即红;把 `changed` 差集改成子集判反 → 「声称改了引擎没看见的文件 → red」即红。
 */
import { readTrailer, synthesizeTrailer, type Trailer, type TrailerRead } from './trailer';

/** 判词前缀 —— 与 GATE_REGISTRY 的 `report-trailer` 条目逐字同源(gate-registry.test.ts 实扫)。 */
export const REPORT_TRAILER_VERDICT = '[omd/executor-dag][report-trailer]';

/** 引擎侧记录面。每一格都可缺席 —— 缺席是「没带过来」, 不是「没发生」。 */
export interface TrailerRecord {
  /** S2 的三态台账: 缺席 = 没派判据;null = 派了没作用域;对象 = 派了。 */
  acceptance?: { ran: boolean; exit: number | null } | null;
  /** 引擎核实的改动集(写集核实 / 受控写工具的 filesTouched)。缺席 = 没带过来。 */
  changed?: readonly string[];
}

export interface TrailerVerdict {
  severity: 'red' | 'notice';
  code: 'acceptance-ran' | 'changed' | 'acceptance-exit' | 'record-missing' | 'self-report-missing' | 'self-report-unparsable';
  message: string;
}

export interface TrailerAudit {
  read: TrailerRead;
  /** 引擎最终采用的尾块: 真值, 或缺席/解析失败时的合成品。 */
  trailer: Trailer;
  /** `leaf` = 真值;`missing` = 合成;`unparsable` = 有 fence 但读不出, 合成。 */
  selfReport: 'leaf' | 'missing' | 'unparsable';
  verdicts: TrailerVerdict[];
  red: boolean;
}

const norm = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '');

/** 审一个节点的末条消息。纯函数, 不读盘。 */
export function auditTrailer(finalText: string, record: TrailerRecord): TrailerAudit {
  const read = readTrailer(finalText);
  const verdicts: TrailerVerdict[] = [];
  const synth = () =>
    synthesizeTrailer({
      ...(record.changed ? { changed: record.changed } : {}),
      ...(record.acceptance !== undefined ? { acceptance: record.acceptance } : {}),
    });
  if (read.kind === 'missing') {
    verdicts.push({ severity: 'notice', code: 'self-report-missing', message: `${REPORT_TRAILER_VERDICT} 尾块缺席 → 引擎按记录合成 (self_report=missing), 不判红` });
    return { read, trailer: synth(), selfReport: 'missing', verdicts, red: false };
  }
  if (read.kind === 'unparsable') {
    verdicts.push({ severity: 'notice', code: 'self-report-unparsable', message: `${REPORT_TRAILER_VERDICT} 尾块解析失败 (${read.why}) → 按缺席处理并留原文, 不判红` });
    return { read, trailer: synth(), selfReport: 'unparsable', verdicts, red: false };
  }
  const t = read.trailer;
  // ① acceptance_ran
  if (record.acceptance === undefined) {
    verdicts.push({ severity: 'notice', code: 'record-missing', message: `${REPORT_TRAILER_VERDICT} 记录面缺 acceptance (视图没带过来) → acceptance_ran=${t.acceptance_ran} 无法对账, 不判红` });
  } else if (t.acceptance_ran && (record.acceptance === null || !record.acceptance.ran)) {
    verdicts.push({ severity: 'red', code: 'acceptance-ran', message: `${REPORT_TRAILER_VERDICT} 尾块声称 acceptance_ran=true, 引擎记录里 run_acceptance 一次都没调 (ran=${record.acceptance?.ran ?? 'null'})` });
  } else if (record.acceptance && record.acceptance.ran && t.acceptance_exit !== record.acceptance.exit) {
    verdicts.push({ severity: 'notice', code: 'acceptance-exit', message: `${REPORT_TRAILER_VERDICT} 尾块 acceptance_exit=${t.acceptance_exit} 与引擎复验 ${record.acceptance.exit} 不一致 (只报)` });
  }
  // ② changed ⊆ 引擎核实
  if (record.changed === undefined) {
    verdicts.push({ severity: 'notice', code: 'record-missing', message: `${REPORT_TRAILER_VERDICT} 记录面缺 changed (视图没带过来) → changed 无法对账, 不判红` });
  } else {
    const seen = new Set(record.changed.map(norm));
    const unseen = t.changed.map(norm).filter((p) => !seen.has(p));
    if (unseen.length > 0) {
      verdicts.push({ severity: 'red', code: 'changed', message: `${REPORT_TRAILER_VERDICT} 尾块声称改了引擎没看见的文件: ${unseen.slice(0, 8).join(', ')} (引擎核实: ${record.changed.length} 个)` });
    }
  }
  return { read, trailer: t, selfReport: 'leaf', verdicts, red: verdicts.some((v) => v.severity === 'red') };
}
