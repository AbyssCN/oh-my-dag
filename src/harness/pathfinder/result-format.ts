/**
 * src/harness/pathfinder/result-format —— AFK research 结果的**双端共享契约** (生产者 dag-research /
 * 消费者 afk-hook 同一模块, 防止格式各表)。
 *
 * 结果文件形状 (dag-research --out 落盘):
 *   # 研究: <question>
 *   > <N> leaves · $<cost> · 检索命中 <n> …        ← 成本统计 blockquote (非内容, distill 必须跳过)
 *   ## 终稿 (综合判优)
 *   <综合正文>                                      ← distill 的取材段
 *   (可选) ## children                              ← D-10 自展开: 每行 `- [type] 子问题`
 *   ## Lens 冠军 … / ## 检索语料附录 …              ← 附录, 不参与蒸馏
 *
 * 写入必须走 writeResultAtomic (tmp+rename): 消费端以"文件存在"为就绪信号, 直写最终路径会被
 * 4s 轮询读到半截并永久定格 (票 ruled 后不再重读)。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TicketType } from './types';

/** 终稿段标题前缀 (dag-research 写 `## 终稿 (综合判优)`; 前缀匹配容忍括注变化)。 */
const FINAL_HEADING = /^##\s+终稿/;

/**
 * 原子落盘 (tmp+rename, 同目录同文件系统 → rename 原子): 轮询方看到的文件要么不存在要么完整。
 */
export function writeResultAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 一个段落是否是"非内容"行块 (标题/成本统计 blockquote/分隔线) —— 蒸馏时跳过。 */
function isNoise(para: string): boolean {
  return para.startsWith('#') || para.startsWith('>') || /^-{3,}$/.test(para);
}

/**
 * 从结果正文蒸馏一句 ruling: 优先取 `## 终稿` 段内首个内容段落; 无终稿段 (手写/异构结果) 回退
 * 全文首个内容段落。跳过标题/blockquote (成本统计) /分隔线。折成单行, 截 ~280 字。
 * 空结果 → 占位串 (票仍 ruled, 但标注结果为空)。
 */
export function distill(resultText: string): string {
  const lines = resultText.split('\n');
  // 定位终稿段: FINAL_HEADING 行之后到下一个 `## ` 标题为止。
  let scope = resultText;
  const start = lines.findIndex((l) => FINAL_HEADING.test(l));
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    scope = lines.slice(start + 1, end).join('\n');
  }
  const paras = scope
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !isNoise(p));
  const first = paras[0] ?? '';
  const oneLine = first.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '(AFK 研究结果为空)';
  return oneLine.length > 280 ? oneLine.slice(0, 277) + '…' : oneLine;
}

/**
 * 一段文本是否"长得像 dag-research 结果"(含 `## 终稿` 段)。gh 折入据此从 issue 评论堆里认出结果评论,
 * 区别于 `**ruling**` 裁决评论 / `⚠ research failed` 失败通知 (两者皆无终稿段)。与 distill 共用 FINAL_HEADING
 * 锚点 → 认结果的判据与蒸馏取材的判据同源, 不各表。
 */
export function looksLikeResult(text: string): boolean {
  return text.split('\n').some((l) => FINAL_HEADING.test(l));
}

const CHILDREN_HEADING = /^##\s+children\s*$/i;
const VALID_TYPES: ReadonlySet<string> = new Set(['research', 'grill', 'prototype', 'task']);

// ── D-10 自展开的边界哲学 ────────────────────────────────────────────────────
// 落图 ≠ 激活: 子票落图零成本 (research 不派发只是一行字; task/grill 无 owner /rule + /deliver
// 永远惰性)。**深度不设限** — 地图深度是知识结构, 复杂目的地就该深。成本的唯一边界是派发预算
// (OMD_PATH_RESEARCH_BUDGET, 见 pathfinder-extension 自续): 预算 = owner 一次设定的尺度旋钮。

/**
 * 单票子票上限 — **契约兜底非尺度政策**: 尺度由生产端指令控 ("最多 4 条宁缺毋滥");
 * 此截断只防契约被违反时一张结果炸出一屏票淹掉前沿。
 */
export const MAX_CHILDREN_PER_TICKET = 4;

/**
 * 生产端综合指令 (--children 时附到终稿 framing 后): 让综合模型在答案末尾按本模块 parseChildren
 * 认识的格式提子问题。**opt-in**: 只有 pathfinder 派发的研究带此指令, 通用 dag-research 输出不长这段。
 */
export const CHILDREN_INSTRUCTION = [
  '另外: 若研究揭示了**值得单独立项**的未决子问题, 在答案最末尾追加一个 `## children` 段, 每行一条:',
  '`- [research|grill|prototype|task] <一句话子问题>`',
  '(research=还需检索调研 / grill=需与 owner 审议对齐 / prototype=需沙盒验证 / task=已明确到可施工)。',
  `最多 ${MAX_CHILDREN_PER_TICKET} 条, 宁缺毋滥; 没有真值得立项的就不要输出该段。`,
].join('\n');

/** 解析出的一条子票草案 (id 由折入方分配: 后端自派, 血缘靠 parentId)。 */
export interface ChildDraft {
  type: TicketType;
  title: string;
}

/**
 * 解析 `## children` 段 (D-10 自展开): 段内每行 `- [type] 标题` 或 `- 标题` (type 缺省 research)。
 * 遇下一个 `## ` 标题即止。非法 type 回退 research。无该段 → []。
 */
export function parseChildren(resultText: string): ChildDraft[] {
  const lines = resultText.split('\n');
  const out: ChildDraft[] = [];
  let inSection = false;
  for (const line of lines) {
    if (CHILDREN_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s+/.test(line)) break; // 下一段标题 → children 段结束
    const m = line.match(/^\s*[-*]\s+(?:\[([a-zA-Z]+)\]\s*)?(.+?)\s*$/);
    if (!m) continue;
    const rawType = (m[1] ?? 'research').toLowerCase();
    const type = (VALID_TYPES.has(rawType) ? rawType : 'research') as TicketType;
    const title = m[2]!.trim();
    if (title) out.push({ type, title });
  }
  return out;
}
