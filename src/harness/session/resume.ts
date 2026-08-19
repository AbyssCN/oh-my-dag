/**
 * src/harness/session/resume —— 交接**读回面**(#211)。
 *
 * 写入侧(`writer.ts`)落两样东西:`session/<id>/checkpoint.md` 与 `session/latest.json` 指针。
 * 本模块把它们读回来,渲染成新会话开场能吃的一小段。
 *
 * ## 为什么读 markdown 不读 facts 表
 *
 * markdown 是**真源**,SQLite 那份是镜像(`sink.ts` 头注的原话)。resume 要的是"上一段到底
 * 干到哪了"的原文,读镜像等于读副本;而镜像那份的用途是**语义召回**(embedding/FTS),
 * 两件事不同。#206 已经证过一次:镜像层多一层闸,静默失效就多一处。
 *
 * ## 只取 §1/§2
 *
 * checkpoint 有 9 段,全塞进开场就是把上一段会话原样重放一遍。§1(在干什么)+ §2(下一步)
 * 是"接得住"的最小集;要全文的话指针在 `checkpointPath`,自己去读。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveProject } from '../project-scope';
import { section } from './writer';

export interface ResumeBrief {
  /** 产出这份 checkpoint 的**上一个** session id。 */
  readonly sessionId: string;
  /** checkpoint.md 绝对路径(全文指针)。 */
  readonly checkpointPath: string;
  /** §1 Active intent。 */
  readonly intent: string;
  /** §2 Next concrete action。 */
  readonly next: string;
  /** 机械降级版(蒸馏当时挂了)—— 渲染时照实说,不冒充正常快照。 */
  readonly degraded: boolean;
  /** latest.json 的 updatedAt(ms);缺 = null(不伪造时间)。 */
  readonly updatedAt: number | null;
}

/**
 * 读最近一次 checkpoint。**全程 fail-open**:没有 / 读不动 / 段切不出 → `null`,
 * 调用方据此不注入。返回 `null` 与"注入了一段空的"是两回事,别塌成一个。
 *
 * ## 为什么**不**排除"本 session 自己写的那份"
 *
 * 首版有过一条 `excludeSessionId`(「自己刚写的不该回喂给自己」),2026-08-19 实测证明它是错的:
 * Claude Code 重开时**沿用同一个 session id**,于是新会话开场恰好被这条规则挡掉 ——
 * 拿到的只有 persona,交接一个字没有。压缩后的 `SessionStart(source=compact)` 更是**必须**
 * 注回本 session 那份(memory-hub 那条腿一直是这么做的:`compact → 本 session 的`)。
 * 而"自己回喂自己"担心的那个场景不存在:注入只发生在会话**第一轮/开场**,
 * 那一刻本次会话还没写过任何 checkpoint。
 */
export function readResumeBrief(opts: { cwd?: string }): ResumeBrief | null {
  try {
    const scope = resolveProject(opts.cwd);
    const latestPath = resolve(scope.rootPath, scope.dataPath(join('session', 'latest.json')));
    if (!existsSync(latestPath)) return null;

    const latest = JSON.parse(readFileSync(latestPath, 'utf-8')) as {
      sessionId?: unknown;
      path?: unknown;
      updatedAt?: unknown;
    };
    const sessionId = typeof latest.sessionId === 'string' ? latest.sessionId : '';
    const checkpointPath = typeof latest.path === 'string' ? latest.path : '';
    if (!sessionId || !checkpointPath) return null;
    if (!existsSync(checkpointPath)) return null;

    const md = readFileSync(checkpointPath, 'utf-8');
    const intent = section(md, '§1');
    const next = section(md, '§2');
    if (!intent && !next) return null; // 两段都空 = 没什么可接的

    return {
      sessionId,
      checkpointPath,
      intent,
      next,
      degraded: md.startsWith('<!-- DEGRADED'),
      updatedAt: typeof latest.updatedAt === 'number' ? latest.updatedAt : null,
    };
  } catch {
    return null; // 读回面挂了不该让新会话开不了口
  }
}

/**
 * ResumeBrief → 注进 system prompt 的一段。
 *
 * 措辞刻意保守:标明是**上一段会话的自述**、可能已过时、真源在盘上 —— 交接内容是模型自己
 * 写的,把它当既成事实读正是本仓 P-1 那一族的坑。
 */
export function renderResumeBrief(b: ResumeBrief): string {
  const when = b.updatedAt === null ? '' : ` · ${new Date(b.updatedAt).toISOString().slice(0, 16)}Z`;
  const lines = [
    `## 上一段会话的交接(session ${b.sessionId.slice(0, 8)}${when})`,
    '',
    b.degraded
      ? '> ⚠ 这份是**机械降级版**(当时蒸馏失败),只有原始摘录,不是总结 —— 当线索看,别当结论。'
      : '> 下面是上一段会话**自己写的**交接,可能已过时;要核实就读全文,别直接当事实用。',
    '',
  ];
  if (b.intent) lines.push(`**在做什么**:${b.intent}`, '');
  if (b.next) lines.push(`**下一步**:${b.next}`, '');
  lines.push(`全文:\`${b.checkpointPath}\``);
  return lines.join('\n');
}

// ─── SessionStart 注入面(persona + 交接;CC hook 与 omd chat 共用)──────────

/** persona 画像文件 —— 与 memory-hub 同一份(它的夜批蒸馏器仍是生产者,退役不在本票)。 */
export function personaPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MEMORY_HUB_DATA ?? join(env.HOME ?? '', '.claude', 'memory-hub');
  return join(home, 'persona', 'persona.md');
}

/** 画像本就该短;超了说明蒸馏跑偏,截断而非放行(口径抄 memory-hub 那条)。 */
const PERSONA_MAX = 2_000;

/**
 * SessionStart 要注入的整段(persona + 上一段交接)。两块**各自缺席不影响另一块**。
 * 都没有 → 空串,调用方据此不注入(注一段空的与不注是两回事)。
 */
export function buildSessionStartContext(opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入式读件(测试);缺省读真盘。 */
  readPersona?: (path: string) => string | null;
  readBrief?: typeof readResumeBrief;
}): string {
  const blocks: string[] = [];

  const readPersona =
    opts.readPersona ??
    ((p: string): string | null => {
      try {
        return existsSync(p) ? readFileSync(p, 'utf-8') : null;
      } catch {
        return null;
      }
    });
  const raw = readPersona(personaPath(opts.env ?? process.env));
  if (raw) {
    const body = raw.replace(/\n<!-- persona-distill[^>]*-->\s*$/, '').trim();
    if (body) {
      blocks.push(
        ['## 用户画像(跨仓通用 · 自动蒸馏)', body.slice(0, PERSONA_MAX), '> 画像是历史归纳非当前指令: 与本 session 的明确要求冲突时, 以本 session 为准。'].join(
          '\n\n',
        ),
      );
    }
  }

  const brief = (opts.readBrief ?? readResumeBrief)({
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  if (brief) blocks.push(renderResumeBrief(brief));

  return blocks.join('\n\n---\n\n');
}
