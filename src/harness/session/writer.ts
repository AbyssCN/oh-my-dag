/**
 * src/harness/session/writer —— W1 session 交接 checkpoint 蒸馏器(从 memory-hub 移植 · D6 共享模块）。
 *
 * 被 CLI(scripts/session-writer.ts)/ 未来的 hook / 手动 skill 共同复用(单一真源）。
 *
 * 管线:transcript 增量(distillOffset 起)+ 旧 checkpoint + ledger 尾
 *   → continuity 角色便宜模型蒸馏 9 段 checkpoint.md(段预算,总 ≤6k tok)
 *   → 零-LLM 验真闸(结构 + 文件路径存在 + commit hash ∈ git + noun-gate 容差 3)fail→回喂重写 1 次→机械降级
 *   → 落盘 contDir/checkpoint.md + latest.json 指针;--final 时 splice _NEXT.md 的 AUTO 标记区
 *   → sinkCheckpoint 镜像进 omd SQLite(fail-open,markdown 是真理源)。
 * fail-open:模型/验真全挂也产出机械降级版,永不让调用方(hook 链)报错。
 *
 * 落盘位置 = resolveProject(cwd).dataPath('session')(OMD_DATA_HOME 感知,per-repo);
 * **刻意避开** DAG-run 续跑的 .omd/continuity/(g3 命名分离裁决)。
 *
 * @module
 */
import {
  existsSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { callModel as defaultCallModel, type ModelRequest, type ModelResponse } from '../../model';
import { bootstrapModelRuntime } from '../../model/bootstrap';
import { resolveRoleModel } from '../../model/role-models';
import { roleModelWithFallback } from '../../model/role-fallback';
import { resolveProject } from '../project-scope';
import type { OmdMemory } from '../memory';
import { checkNouns } from './noun-gate';
import { sinkCheckpoint, type CheckpointSinkResult } from './sink';

// ─── constants ──────────────────────────────────────────────────────────────

const SECTION_HEADERS = [
  '## §1 Active intent',
  '## §2 Next concrete action',
  '## §3 Session directives',
  '## §4 Tasks',
  '## §5 Current work',
  '## §6 Files & anchors',
  '## §7 Discovered knowledge',
  '## §8 Errors & fixes',
  '## §9 Decisions',
] as const;
const SECTION_BUDGET_HINT = '§1≤500tok §2≤800 §3≤600 §4≤800 §5≤1200 §6≤800 §7≤800 §8≤800 §9≤1000';
const MAX_CHECKPOINT_CHARS = 54_000; // ≈1.5× 总预算(6k tok ×4 chars ×1.5)
const MAX_EXCERPT_CHARS = 100_000; // 喂便宜模型的 transcript 摘录上限
const TRANSCRIPT_CHUNK_CAP = 6 * 1024 * 1024;

export type WriterMode = 'rolling' | 'final' | 'precompact';

/** 注入式 callModel(测试传假实现;缺省 = 真实 provider-agnostic callModel)。 */
export type CallModelFn = (req: ModelRequest) => Promise<ModelResponse>;

export interface WriterOptions {
  /** CC transcript JSONL 绝对路径。 */
  transcript: string;
  /** session id(会被清洗为文件名安全串)。 */
  sessionId: string;
  /** rolling(每轮) / final(收尾 splice _NEXT.md) / precompact(压缩前)。默认 rolling。 */
  mode?: WriterMode;
  /** 项目根解析用的 cwd;默认 process.cwd()。 */
  cwd?: string;
  /** 镜像层目标(装配好则双写 SQLite;缺省 = 仅 markdown)。 */
  memory?: OmdMemory;
  /** 注入 callModel(测试);缺省 = 真实 callModel + 首次 bootstrap provider。 */
  callModel?: CallModelFn;
  /** 强制机械降级(测试 / 显式跳过模型调用)。 */
  mechanical?: boolean;
  /** 注入时钟(测试确定性);缺省 Date.now。 */
  now?: () => number;
}

export interface WriterResult {
  ok: boolean;
  /** checkpoint.md 绝对路径。 */
  checkpointPath: string;
  /** 是否机械降级版。 */
  degraded: boolean;
  /** checkpoint 字符数。 */
  chars: number;
  /** 无新增内容 → 跳过重蒸馏(保留旧 checkpoint)。 */
  skipped: boolean;
  /** SQLite 镜像结果(fail-open)。 */
  sink?: CheckpointSinkResult;
}

// ─── transcript 增量摘录 ──────────────────────────────────────────────────────

interface WriterState {
  distillOffset?: number;
  [k: string]: unknown;
}

function loadState(statePath: string): WriterState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as WriterState;
  } catch {
    return {};
  }
}

function readChunk(path: string, from: number, cap: number): { text: string; end: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = Math.min(Math.max(from, 0), size);
    if (size - start > cap) start = size - cap;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    const lastNl = text.lastIndexOf('\n');
    return { text: lastNl >= 0 ? text.slice(0, lastNl) : text, end: start + (lastNl >= 0 ? lastNl + 1 : 0) };
  } finally {
    closeSync(fd);
  }
}

/** transcript JSONL → 紧凑对话摘录(U/A/T/R 行),控制在 MAX_EXCERPT_CHARS 内。 */
function excerpt(chunk: string): string {
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let j: {
      type?: string;
      message?: { content?: unknown };
    };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = j?.message?.content;
    if (j.type === 'user') {
      if (typeof content === 'string') {
        if (!content.startsWith('<system-reminder')) out.push(`U: ${content.slice(0, 500)}`);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const p of content as Array<Record<string, unknown>>) {
        if (p.type === 'text' && typeof p.text === 'string' && !p.text.startsWith('<system-reminder'))
          out.push(`U: ${(p.text as string).slice(0, 500)}`);
        if (p.type === 'tool_result') {
          const raw = p.content;
          const t =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.map((c: Record<string, unknown>) => (c.text as string) || '').join(' ')
                : '';
          if (t) out.push(`R: ${t.slice(0, 200)}`);
        }
      }
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      for (const p of content as Array<Record<string, unknown>>) {
        if (p.type === 'text' && p.text) out.push(`A: ${String(p.text).slice(0, 800)}`);
        if (p.type === 'tool_use') {
          const inp = (p.input as Record<string, unknown>) || {};
          const brief =
            inp.file_path || inp.command || inp.query || inp.prompt || JSON.stringify(inp).slice(0, 120);
          out.push(`T: ${String(p.name)} ${String(brief).slice(0, 160)}`);
        }
      }
    }
  }
  let text = out.join('\n');
  if (text.length > MAX_EXCERPT_CHARS) text = `…(更早内容已截)\n${text.slice(-MAX_EXCERPT_CHARS)}`;
  return text;
}

// ─── 验真闸(零 LLM)──────────────────────────────────────────────────────────
// 判据 = "防编造"非"防外部引用":路径/hash 要么真实存在(repo/git),要么逐字出现在
// 源材料里(本 session 真讨论过的外部路径合法)。两者皆否 = 幻觉,打回。

function validate(md: string, material: string, projectRoot: string): string[] {
  const errors: string[] = [];
  for (const h of SECTION_HEADERS) if (!md.includes(h)) errors.push(`缺少段落标头: "${h}"`);
  if (md.length > MAX_CHECKPOINT_CHARS)
    errors.push(`超长: ${md.length} chars > ${MAX_CHECKPOINT_CHARS}(压缩到段预算内: ${SECTION_BUDGET_HINT})`);

  // grounding ①: 相对路径 ∈ repo ∪ 源材料
  const pathRe = /(?:src|docs|scripts|test|frontend|sql|supabase)\/[\w\-./[\]]+/g;
  const paths = [...new Set(md.match(pathRe) || [])].map((p) =>
    p.replace(/[.,;:)\]]+$/, '').replace(/:\d+.*$/, ''),
  );
  const fabricated = paths.filter((p) => !existsSync(join(projectRoot, p)) && !material.includes(p));
  if (fabricated.length > 0)
    errors.push(
      `编造的文件路径(repo 与材料中均不存在): ${fabricated.slice(0, 5).join(', ')} — 只写材料中真实出现的路径`,
    );

  // grounding ②: 提及 commit 的行里的 hash ∈ git ∪ 源材料
  for (const line of md.split('\n')) {
    if (!/commit/i.test(line)) continue;
    for (const h of line.match(/\b[0-9a-f]{7,12}\b/g) || []) {
      if (material.includes(h)) continue;
      try {
        execFileSync('git', ['rev-parse', '-q', '--verify', `${h}^{commit}`], {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      } catch {
        errors.push(`commit hash ${h} 在 git 与材料中均不存在 — 不得编造 hash`);
      }
    }
  }

  // grounding ③: 标识符/文件名类名词 ∈ 材料 ∪ repo 文件树,容差 3
  try {
    const ng = checkNouns({ text: md, material, repoRoot: projectRoot, maxNovel: 3, annotate: false });
    if (!ng.pass)
      errors.push(
        `编造名词(材料与 repo 文件树均未出现,超容差 3): ${ng.novelNouns.slice(0, 6).join(', ')} — 标识符/文件名只写材料中真实出现过的`,
      );
  } catch {
    /* noun-gate 自身挂 → 不阻断(路径/hash 闸仍在) */
  }
  return errors;
}

// ─── 机械降级(fail-open 终点)─────────────────────────────────────────────────

function mechanicalCheckpoint(ledgerTail: string, excerptText: string, reason: string): string {
  const tail = excerptText.split('\n').slice(-60).join('\n');
  return [
    `<!-- DEGRADED: ${reason} -->`,
    ...SECTION_HEADERS.map((h) => {
      if (h.includes('§1')) return `${h}\n(机械降级 — writer 蒸馏失败: ${reason})`;
      if (h.includes('§5')) return `${h}\n最近 ledger:\n\`\`\`\n${ledgerTail}\n\`\`\``;
      if (h.includes('§6')) return `${h}\n最近活动摘录:\n\`\`\`\n${tail}\n\`\`\``;
      return `${h}\n(无)`;
    }),
  ].join('\n\n');
}

// ─── section 抽取 + _NEXT.md AUTO 区 splice ────────────────────────────────────

function section(md: string, tag: string): string {
  const n = tag.replace('§', '');
  const re = new RegExp(`## §${n}[^\\n]*\\n([\\s\\S]*?)(?=\\n## §|$)`);
  return (md.match(re)?.[1] || '').trim().slice(0, 600);
}

/** 把 §1/§2 splice 进 _NEXT.md 的 AUTO 标记区(无标记不自创,不碰人工区)。 */
function spliceNext(md: string, projectRoot: string, sessionId: string, checkpointPath: string, nowMs: number): boolean {
  const nextPath = join(projectRoot, '_NEXT.md');
  if (!existsSync(nextPath)) return false;
  const cur = readFileSync(nextPath, 'utf-8');
  const BEGIN = '<!-- CONTINUITY:AUTO:BEGIN -->';
  const END = '<!-- CONTINUITY:AUTO:END -->';
  const b = cur.indexOf(BEGIN);
  const e = cur.indexOf(END);
  if (b < 0 || e < 0 || e < b) return false; // 无标记区不自创
  const s1 = section(md, '§1');
  const s2 = section(md, '§2');
  const stamp = new Date(nowMs).toISOString().slice(0, 16);
  const block = [
    BEGIN,
    `> ⚡ 自动续接(session ${sessionId.slice(0, 8)} · ${stamp}Z · 全文 \`${checkpointPath}\`)`,
    s1 ? `**Active intent**: ${s1}` : '',
    s2 ? `**Next action**: ${s2}` : '',
    END,
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(nextPath, cur.slice(0, b) + block + cur.slice(e + END.length));
  return true;
}

/** ledger 尾最新一行的 ctxTokens 真值,无则 null。 */
function latestCtxTokens(tail: string): number | null {
  const lines = tail.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as { ctxTokens?: unknown };
      if (typeof j?.ctxTokens === 'number') return j.ctxTokens;
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

// ─── distill(便宜模型 + 验真回喂）─────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 session 续接 checkpoint 写手。把"上一版 checkpoint + 本段新增对话材料"合并蒸馏成一份新的 checkpoint, 供下一个 session 开头注入续接工作。

铁律:
- 只依据材料, 严禁编造。文件路径、commit hash、测试数字只许写材料中真实出现过的。
- 不确定就写"未知", 不要猜。
- 输出 9 段 markdown, 标头一字不差:
${SECTION_HEADERS.join('\n')}
- 段预算(估算): ${SECTION_BUDGET_HINT}。宁短勿长, 旧 checkpoint 中已过时/已完成的内容删掉, 持久知识(§7-§9)累积保留。
- §2 必须是下一步可直接执行的具体动作, 不是方向描述。
- 直接输出 markdown, 不要解释, 不要代码围栏包裹。`;

async function distill(
  call: CallModelFn,
  model: string,
  prevCheckpoint: string,
  ledgerTail: string,
  excerptText: string,
  projectRoot: string,
): Promise<string> {
  let userMsg = [
    prevCheckpoint ? `# 上一版 checkpoint\n${prevCheckpoint}` : '# 上一版 checkpoint\n(无, 这是首版)',
    `# Ledger(每轮记账, ctxTokens=真值)\n${ledgerTail || '(无)'}`,
    `# 本段新增对话材料(U=用户 A=助手 T=工具调用 R=工具结果)\n${excerptText || '(无)'}`,
  ].join('\n\n');
  const material = `${prevCheckpoint}\n${ledgerTail}\n${excerptText}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2,
      maxTokens: 8000,
    });
    const md = res.text.trim().replace(/^```(?:markdown)?\n?|\n?```$/g, '');
    const errors = validate(md, material, projectRoot);
    if (errors.length === 0) return md;
    console.error(`[session-writer] 验真闸 fail (attempt ${attempt + 1}): ${errors.join(' | ')}`);
    userMsg += `\n\n# 上一稿验真失败, 修正后重写全文\n${errors.map((x) => `- ${x}`).join('\n')}`;
  }
  throw new Error('验真闸两次未过');
}

// ─── main ─────────────────────────────────────────────────────────────────────

/**
 * 跑一次 checkpoint 蒸馏 + 落盘 + 镜像。全程 fail-open:任何环节挂了都产出机械降级版并返回,
 * 绝不抛给调用方(hook 链)。
 */
export async function runWriter(opts: WriterOptions): Promise<WriterResult> {
  const now = opts.now ?? Date.now;
  const mode: WriterMode = opts.mode ?? 'rolling';
  const sessionId = opts.sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const scope = resolveProject(opts.cwd);
  const projectRoot = scope.rootPath;

  const contDir = resolve(projectRoot, scope.dataPath(join('session', sessionId)));
  mkdirSync(contDir, { recursive: true });
  const checkpointPath = join(contDir, 'checkpoint.md');
  const statePath = join(contDir, 'state.json');
  const latestPath = resolve(projectRoot, scope.dataPath(join('session', 'latest.json')));

  const state = loadState(statePath);
  const { text: chunk, end: newOffset } = readChunk(
    opts.transcript,
    state.distillOffset || 0,
    TRANSCRIPT_CHUNK_CAP,
  );
  const excerptText = excerpt(chunk);
  const prevCheckpoint = existsSync(checkpointPath) ? readFileSync(checkpointPath, 'utf-8') : '';
  let ledgerTail = '';
  try {
    ledgerTail = readFileSync(join(contDir, 'ledger.jsonl'), 'utf-8').trim().split('\n').slice(-40).join('\n');
  } catch {
    /* 无 ledger(hook 未上线时正常)*/
  }

  // 无新增内容且已有 checkpoint → 跳过重蒸馏(final 仍补一次 splice）。
  if (!excerptText && prevCheckpoint) {
    let spliced = false;
    if (mode === 'final') spliced = spliceNext(prevCheckpoint, projectRoot, sessionId, checkpointPath, now());
    void spliced;
    return {
      ok: true,
      checkpointPath,
      degraded: prevCheckpoint.startsWith('<!-- DEGRADED'),
      chars: prevCheckpoint.length,
      skipped: true,
    };
  }

  // 蒸馏(fail-open → 机械降级）。
  const call = opts.callModel ?? defaultCallModel;
  let md: string;
  try {
    if (opts.mechanical) {
      md = mechanicalCheckpoint(ledgerTail, excerptText, 'mechanical-forced');
    } else {
      if (!opts.callModel) bootstrapModelRuntime(); // 真实 provider 从 env/config 注册
      const model = roleModelWithFallback(resolveRoleModel('continuity'), 'continuity');
      md = await distill(call, model, prevCheckpoint, ledgerTail, excerptText, projectRoot);
    }
  } catch (e) {
    md = mechanicalCheckpoint(ledgerTail, excerptText, String(e instanceof Error ? e.message : e).slice(0, 120));
  }

  const degraded = md.startsWith('<!-- DEGRADED');
  writeFileSync(checkpointPath, md);
  writeFileSync(statePath, JSON.stringify({ ...state, distillOffset: newOffset, lastDistillAt: now(), mode }));
  writeFileSync(latestPath, JSON.stringify({ sessionId, path: checkpointPath, updatedAt: now() }));
  if (mode === 'final') spliceNext(md, projectRoot, sessionId, checkpointPath, now());

  // SQLite 镜像(fail-open,markdown 已落=真理源)。
  let sink: CheckpointSinkResult | undefined;
  try {
    sink = await sinkCheckpoint(
      {
        sessionId,
        mode,
        md,
        intent: section(md, '§1'),
        next: section(md, '§2'),
        ctxTokens: latestCtxTokens(ledgerTail),
        degraded,
        checkpointPath,
      },
      { memory: opts.memory },
    );
  } catch (e) {
    sink = { ok: false, error: `sink threw (fail-open): ${e instanceof Error ? e.message : e}` };
  }

  return { ok: true, checkpointPath, degraded, chars: md.length, skipped: false, sink };
}
