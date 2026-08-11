/**
 * src/harness/profiles/review-ledger —— 审查发现台账 (INV-5 / G-5 前半落地)。
 *
 * 不变量 (逐字):
 * - INV-5: 台账有界 ≤64 条; 溢出**丢最老**, 且**必留一行证据** (丢了几条、何时) ——
 *   证据落盘进 `overflows` 数组 + logger.warn 双写, 不许静默 DELETE。
 * - G-5 前半: 指纹去重 —— 已有指纹 F 再来同指纹 finding → deduped+1, 不重报。
 *
 * 指纹: sha256(where + 归一化 evidence 类别)。归一化 = 小写 + 去空白/标点, 类别稳定,
 * 同一证据的排版差异不产生新指纹。指纹由调用方随 finding 带入 (ReviewFinding.fingerprint
 * 形状冻结), 本文件只负责比较与去重; `fingerprintOf` 是给调用方算指纹的公开帮手。
 *
 * 存储: ledgerPath 指向的 JSON 文件 `{ findings: ReviewFinding[], overflows: OverflowRecord[] }`。
 * 写失败 **throw** —— 审查证据不可重建, 与 touch-ledger 的「可重建投影 fail-open」不同, 不许
 * 静默吞掉已报的 finding; 读失败 (不存在/损坏) → 空台账 + warn, 不扰动调用方。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger';

/** 冻结形状 (逐字, 勿改): fingerprint = sha256(where + 归一化 evidence 类别)。 */
export interface ReviewFinding {
  where: string;
  severity: 'p0' | 'p1' | 'p2';
  evidence: string;
  suggestion: string;
  uncertainty: string;
  fingerprint: string;
}

/** 溢出证据行 (INV-5「必留一行证据」): 一次溢出丢了几条、何时 (ISO)。 */
export interface OverflowRecord {
  dropped: number;
  at: string;
}

/** INV-5 上限: 台账有界 ≤64 条。 */
export const LEDGER_CAP = 64;

interface LedgerFile {
  findings: ReviewFinding[];
  overflows: OverflowRecord[];
}

/** 归一化 evidence 类别: 小写 + 去空白/标点。排版差异不产生新类别。 */
export function normalizeEvidenceCategory(evidence: string): string {
  return evidence.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 指纹 = sha256(where + 归一化 evidence 类别) 的完整 hex (64 位)。 */
export function fingerprintOf(where: string, evidence: string): string {
  return createHash('sha256').update(where + normalizeEvidenceCategory(evidence)).digest('hex');
}

/** 空/不存在/损坏的 ledgerPath → 空台账 (损坏时 warn 留痕, 不吞调用方)。 */
export function loadLedger(ledgerPath: string): ReviewFinding[] {
  if (!ledgerPath || !existsSync(ledgerPath)) return [];
  try {
    const file = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Partial<LedgerFile>;
    return Array.isArray(file.findings) ? file.findings : [];
  } catch (e) {
    logger.warn({ path: ledgerPath, err: (e as Error).message }, '[omd/review-ledger] 台账损坏, 按空台账处理');
    return [];
  }
}

/** 读整份台账文件 (含溢出证据)。损坏 → 空台账 + warn。 */
function readLedgerFile(ledgerPath: string): LedgerFile {
  if (!ledgerPath || !existsSync(ledgerPath)) return { findings: [], overflows: [] };
  try {
    const file = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Partial<LedgerFile>;
    return {
      findings: Array.isArray(file.findings) ? file.findings : [],
      overflows: Array.isArray(file.overflows) ? file.overflows : [],
    };
  } catch (e) {
    logger.warn({ path: ledgerPath, err: (e as Error).message }, '[omd/review-ledger] 台账损坏, 按空台账重建');
    return { findings: [], overflows: [] };
  }
}

/**
 * 追加 findings 到台账 (文件不存在则创建, 目录自动建)。返回 { added, deduped }:
 * - added: 真正落账条数; deduped: 指纹已存在被跳过的条数 (含同一批内重复, G-5 前半)。
 * - INV-5: 落账后 >64 条 → 丢最老 (数组头), 溢出证据写进 overflows + logger.warn。
 * - 写失败 throw (证据不可重建, 不 fail-open)。
 */
export function appendFindings(ledgerPath: string, fs2: ReviewFinding[]): { added: number; deduped: number } {
  if (!ledgerPath) throw new Error('appendFindings 需要非空 ledgerPath');
  const file = readLedgerFile(ledgerPath);
  const seen = new Set(file.findings.map((f) => f.fingerprint));
  let added = 0;
  let deduped = 0;
  const incoming: ReviewFinding[] = [];
  for (const f of fs2) {
    if (seen.has(f.fingerprint)) {
      deduped++;
      continue;
    }
    seen.add(f.fingerprint);
    incoming.push(f);
    added++;
  }

  const merged = [...file.findings, ...incoming];
  let overflows = file.overflows;
  if (merged.length > LEDGER_CAP) {
    const dropped = merged.length - LEDGER_CAP;
    const at = new Date().toISOString();
    merged.splice(0, dropped); // 丢最老 (数组头 = 先入)
    overflows = [...overflows, { dropped, at }];
    logger.warn(
      { path: ledgerPath, dropped, at, 依据: `台账 ${LEDGER_CAP} 条上限 (INV-5), 丢最老` },
      '[omd/review-ledger] 台账溢出, 丢最老 N 条 (INV-5 证据已落盘)',
    );
  }

  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ findings: merged, overflows }, null, 2), 'utf8');
  return { added, deduped };
}
