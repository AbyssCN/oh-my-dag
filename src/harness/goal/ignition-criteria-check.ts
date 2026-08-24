/**
 * src/harness/goal/ignition-criteria-check —— sddPath 首跑点火的判据自证 (S2 / C-1 / #251)。
 *
 * 与 ignition-preflight (板上活 run 写集相交, 集合运算, 零 LLM 零命令跑) **并行**的第二道
 * 机械闸:本模块**实跑** verify 列里的命令串, 拒点火预绿 (判据虚或活已干完), 是 register/start
 * 之前的兜底 (站票 run 85a18995: 4 分钟零改动假 done; run bca0a0c7: bun test 多 filter 静默
 * 忽略缺失, 二次假 done —— 两样本都靠 verify 退 0 + 「根本没人实跑」骗过去)。
 *
 * ## 三类 finding
 * ① **missing-path**: verify 里出现「含 / 且以 .ts/.tsx/.js/.json/.md 结尾」的 token, 但
 *    **盘上不在、也不在本片写集** —— verify 引用了不存在的路径 (判据虚信号 1)。保守启发式:
 *    误报不可 (宽松), 漏报可接受;绝对路径 (以 `/` 开头) 不收 —— 那是机内绝对路径, 不是仓路径。
 * ② **mixed-first-segment**: 本片写集含**新建文件** (盘上不存在) 时, verify 的**首段**
 *    (第一个 `&&` 之前) 只许引用本片写集内的 token —— 否则首段能在不动本片文件的情况下退 0
 *    (INV-5c 的机械化: 新建文件未被任何判据引用 = 这片是 vacuous)。空 verify / 无首段 token
 *    = 跳过 (不拒)。
 * ③ **pre-green**: 本片写集含新建文件 ∧ stub runner 跑 verify 退 0 —— 切片工作已被人干完或
 *    判据根本不依赖本片产出, 一概拒 (D-3 / 站票 run 85a18995)。本片**无**新建文件时不查:
 *    那类片是修改既有, verify 在改动前后都可能退 0, 不构成预绿信号。
 *
 * 静态 lint 与实跑**全部收集**完再判 verdict —— 一次拒点火报全 findings, 不挤牙膏
 * (D-3: 「lint 与实跑的 finding 全部收集再拒」)。
 *
 * ## 接线纪律 (C-1 INV-1 / D-3 末段)
 * - `runCommand` **无默认值**: 测试传 stub, 生产传引擎同款 commandRunner 适配 (见 goal.ts
 *   切片 3), 接线点恒有 commandRunner, **无 fail-open 分支**。
 * - 零 LLM 零引擎 import (同 ignition-preflight)。
 * - 不动 #242 降级与 O-6 探针本体 (它们在真 resume / 真首跑上各自是对的, 错的只是首跑冒充
 *   续跑, 那是切片 3 的事)。
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SddSlice } from './sdd-direct';

// ── 冻结接口 ──────────────────────────────────────────────────────────────────

export type FindingKind = 'pre-green' | 'missing-path' | 'mixed-first-segment';

export interface IgnitionCriteriaFinding {
  sliceId: number;
  kind: FindingKind;
  /** 触发该 finding 的具体内容 (missing-path/mixed 时 = token 原文; pre-green 时 = verify 串)。 */
  detail: string;
}

export interface IgnitionCriteriaReport {
  verdict: 'ok' | 'rejected';
  findings: IgnitionCriteriaFinding[];
}

/**
 * 注入点: 命令跑手。与 leaf-runners.CommandLeafRunner 兼容 (只取 exitCode; text/usage/signal/
 * timedOut 在本闸不读 —— 这是「闸能红」的最小面)。
 *
 * 生产端 = `createCommandLeafRunner({ allowlist, timeoutMs })` 适配一层, 预绑 cwd=root;
 * 测试端 = 任意 stub。**无 fail-open 分支** (C-1 INV-1 / D-3 末段)。
 */
export type IgnitionRunCommand = (
  input: { command: string; cwd: string },
) => Promise<{ exitCode: number | null }>;

// ── 内部常量 ──────────────────────────────────────────────────────────────────

/**
 * 「仓内路径 token」启发式正则:以 `.ts`/`.tsx`/`.js`/`.json`/`.md` 结尾的连续 token。
 * 末位 `\b` 防 `foo.tsx2` 这种「前面也是 ts 后缀但中间串了字」的误报。
 *
 * 注: 正则本身**不**强制「仓内路径」的两条核心启发式 (含 `/` ∧ 不以 `/` 开头) ——
 * 那两条用 `extractPathTokens` 里的 post-filter 实现, 比塞进正则更直白。
 * 保守: 误报不可 (宽松), 漏报可接受 (D-3①)。
 */
const SUPPORTED_EXTS = ['ts', 'tsx', 'js', 'json', 'md'] as const;
const PATH_TOKEN_REGEX = new RegExp(
  `[a-zA-Z0-9_./-]+\\.(${SUPPORTED_EXTS.join('|')})\\b`,
  'g',
);

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 从 verify 列原文里抽出所有「仓内路径 token」(按首次出现序去重)。 */
function extractPathTokens(verify: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of verify.matchAll(PATH_TOKEN_REGEX)) {
    const tok = m[0];
    // 仓内路径启发式 (D-3①): 必须含 `/` (排除 `tsconfig.json` 这种无 `/` 的同名末缀);
    // 且**不以** `/` 开头 (排除 `/usr/local/foo.ts` 这种机内绝对路径, 那是另一回事)。
    if (!tok.includes('/')) continue;
    if (tok.startsWith('/')) continue;
    // `./` 前缀归一化 (2026-08-25 活体误杀): bun 路径 filter 惯用 `./src/x.test.ts`,
    // 写集条目无前缀 —— 不剥掉就对不上写集, missing-path/mixed 双误杀 (run 8810fd65)。
    const norm = tok.startsWith('./') ? tok.slice(2) : tok;
    if (!norm.includes('/')) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** verify 的首段 (第一个 `&&` 之前的部分)。空 verify → ''。 */
function firstSegment(verify: string): string {
  const i = verify.indexOf('&&');
  return i === -1 ? verify : verify.slice(0, i);
}

/** 本片写集里盘上还不存在的文件 (新建文件)。 */
function newFilesInWriteSet(root: string, writeSet: readonly string[]): string[] {
  return writeSet.filter((f) => !existsSync(resolve(root, f)));
}

// ── 主函数 ─────────────────────────────────────────────────────────────────────

/**
 * 逐片 lint + 实跑, 收集全量 findings 后定 verdict。
 *
 * @param root        仓根绝对路径。path token 与 writeSet 都按相对此根解析。
 * @param slices      `parseBreakdown(...).slices` —— 本 SDD 的全部切片。
 * @param runCommand  命令跑手 (生产 = 引擎同款 commandRunner 预绑 cwd; 测试 = stub)。
 * @returns           `{ verdict, findings }` —— findings 全量收集, 不挤牙膏。
 */
export async function checkIgnitionCriteria(
  root: string,
  slices: readonly SddSlice[],
  runCommand: IgnitionRunCommand,
): Promise<IgnitionCriteriaReport> {
  const findings: IgnitionCriteriaFinding[] = [];

  for (const slice of slices) {
    const writeSet = slice.writeSet;
    const writeSetSet = new Set(writeSet);
    const tokens = extractPathTokens(slice.verify);
    const newFiles = newFilesInWriteSet(root, writeSet);

    // ① 静态 lint: missing-path —— 路径必须「盘上存在 ∨ 在本片写集(允许新建)」, 否则拒。
    //    既有文件 (`exists=true, inWriteSet=false`) 也算合法 —— 那是在引既有测试, 没违反 INV-5c。
    //    写集内的新建文件 (`exists=false, inWriteSet=true`) 是契约自洽的「本片会产出」, 也合法。
    for (const tok of tokens) {
      const exists = existsSync(resolve(root, tok));
      const inWriteSet = writeSetSet.has(tok);
      if (!exists && !inWriteSet) {
        findings.push({ sliceId: slice.id, kind: 'missing-path', detail: tok });
      }
    }

    // ① 静态 lint: mixed-first-segment —— 仅本片有新建文件时检查 (INV-5c 机械化)。
    //    若本片全是修改既有, 首段引用既有测试不构成「vacuous 信号」, 跳过避免误拒。
    //    空 verify / 首段无 path token → 也跳过 (无 token 可判, 不强行拒)。
    if (newFiles.length > 0) {
      const seg1 = firstSegment(slice.verify);
      const seg1Tokens = extractPathTokens(seg1);
      for (const tok of seg1Tokens) {
        if (!writeSetSet.has(tok)) {
          findings.push({ sliceId: slice.id, kind: 'mixed-first-segment', detail: tok });
        }
      }
    }

    // ② 实跑: pre-green —— 仅本片有新建文件 ∧ verify 非空时检查。
    //    本片无新建文件 = 修改既有 (verify 在改动前后都可能退 0, 不构成预绿)。
    //    verify 为空 = 没有命令可跑, 跑手也无意义的「退 0」可拿, 跳过 (否则空 verify 会无
    //    端触发 pre-green, 把「这片没写 verify」当成判据虚 —— 那是契约段的活, 不是闸的活)。
    //    stub exitCode === 0 = verify 退 0, 直接报 pre-green。
    if (newFiles.length > 0 && slice.verify.trim() !== '') {
      const res = await runCommand({ command: slice.verify, cwd: root });
      if (res.exitCode === 0) {
        findings.push({ sliceId: slice.id, kind: 'pre-green', detail: slice.verify });
      }
    }
  }

  return { verdict: findings.length === 0 ? 'ok' : 'rejected', findings };
}