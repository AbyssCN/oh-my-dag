/**
 * src/harness/pathfinder/backend-gh —— GitHub Issues 后端 (SDD S1 · D-B/D-C/D-D/D-G)。
 *
 * 决策地图落 Issues: **map** = 一张 issue (label `path:map`, 命名空间, D-G), **票** = map 的
 * sub-issue (label `path:<type>`)。read 方向实时拼 PathMap (一次 GraphQL 抓两层 + 评论 + 标签),
 * write 方向 emit 语义操作 (issue create/comment/close/edit + addSubIssue mutation)。
 *
 * 全部 gh 调用经注入的 GhRunner (D-B: 一律 shell-out `gh` + `--json`/graphql, 不自造 REST 客户端);
 * **测试注入 fixture, 永不真调 gh** (dispatch.ts 同款 idiom: 纯决策 + 注入副作用)。
 *
 * id 约定 (D-D): 票 id = issue number 的 `#N` 串, 无内部映射表; map slug = map issue number 串 (无 `#`)。
 * blockedBy (D-C, 单真相不混用) —— 由 `nativeDeps` 开关二选一, **无 fallback 交叉** (每仓恰一真相):
 *   - **legacy** (nativeDeps=false, 老 GHE): issue **正文尾行** `Blocked-by: #N, #M` 为唯一真相
 *     (确定性 · 读写对称 · 不赌 preview 版原生 dependencies GraphQL)。
 *   - **native** (nativeDeps=true, D-C.2 owner 明令切换): GitHub 原生 issue-dependencies ——
 *     读走 GraphQL `blockedBy(first:N){nodes{number}}` 字段, 写走 REST
 *     `POST /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` (issue_id = blocking 票 databaseId);
 *     **完全不读不写 body 尾行**。开关由 resolveBackend 从 config.capabilities.nativeDependencies 读, 缺省 false。
 *
 * 2026-08-11 切片4 (控制面统一 SDD D-4 / G-3 / INV-1) 补两件:
 *   - `path:suggested` label 映射 (S-1 片 e 的 t5 欠账): suggested 票镜像成**开着 + 带该 label**的
 *     issue, confirm accept 摘 label (成 open 票), confirm reject 关票**但保留 label**
 *     (CLOSED+suggested = 已拒建议, 与 CLOSED 的已裁票区分开)。溯源/指纹走正文锚往返。
 *   - `syncFromMap` (G-3 后半): gh 侧被人手改 → 以**盘上 map** 为准覆盖, 且**先**在该 issue 留冲突
 *     注记 (含两侧各自认为的状态与时间)。INV-1: gh 侧不产生独立状态, 这里只纠正渲染, 零裁决。
 *
 * 2026-08-11 O-1 终裁 + O-5 还账 (D-5/G-5) 再补三件:
 *   - **`escalated` 有表达位了**: `path:escalated` label (开着 + 该 label)。此前 gh 侧"等人裁"
 *     只有 suggested 一态, `escalate` 整个没实装 —— 而 `reflowGoalResults` 调它时票是 **ruled**
 *     (gh 上 = CLOSED), 光打戳不 reopen 的话读回来仍是 ruled, 升级等于没发生。
 *   - **D-5 三戳的 gh 载体 = 评论流 + 出生正文锚** (不是"改正文"):
 *       · `waitingSince` — suggested 出生态落**正文锚** `Waiting-since:`(建票时一次写死, 零重写);
 *                          escalate 落**评论锚** `**waiting-since**:`(票已存在, 改正文要读-改-写
 *                          整段正文, 那正是 1890115 事故的形状 —— 手写字段被静默丢弃)。
 *       · `ruledAt`     — **不额外写**: 裁决评论自带 `createdAt` 就是那一刻 (还能补读历史票);
 *                          多写一条戳评论只是给手机上的人多推一条噪声。
 *       · `staleAt`     — 提醒评论里的 `**stale-at**:` 锚 (notify-gh 定型)。幂等键必须是我们
 *                          自己写的串, 不许依赖服务端字段的有无 (缺了就每 tick 重发提醒)。
 *   - `sweepWaiting` + 提醒通道: 超时票 → 经 `WaitingHumanNotifier` 在该 issue 落提醒评论。
 *     **零 stale 零写**同 md (1890115): 零票超时 = 零 gh 写调用 (只有一次 readMap 查询)。
 */
import { deriveStatus, sweepWaitingHuman } from './frontier';
import { createGhWaitingNotifier, parseStaleAt } from './notify-gh';
import { looksLikeResult } from './result-format';
import {
  applySuggestions,
  confirmSuggestion as confirmSuggestionPure,
  type ApplySuggestionsOpts,
  type ApplySuggestionsResult,
  type ConfirmAction,
  type SuggestionDraft,
} from './suggest';
import type { GhResult, GhRunner, PathBackend } from './backend';
import type { WaitingHumanNotifier } from './frontier';
import type { ExecutorKind, PathMap, SuggestionLogEntry, Ticket, TicketStatus, TicketType, WaitingLogEntry } from './types';

const TICKET_TYPES: readonly TicketType[] = ['research', 'grill', 'prototype', 'task'];
/** `Executor-kind` 正文锚的词表 (词表外 = 不认, 见 readMap 处注记)。与 types.ts 的 ExecutorKind 同域。 */
const EXECUTOR_KINDS: readonly ExecutorKind[] = ['command', 'inproc', 'agent', 'map', 'primitive', 'goal'];
/** gh issue 标题硬上限 (GraphQL createIssue: `Title is too long (maximum is 256 characters)`)。 */
const GH_TITLE_MAX = 256;
const MAP_LABEL = 'path:map';
const DELIVERED_LABEL = 'path:delivered';
/** S-1 片 e (t5 欠账): 机器建议票的 gh 映射 —— 开着 + 此 label = suggested; 关着 + 此 label = 已拒。 */
const SUGGESTED_LABEL = 'path:suggested';
/** D-5: `escalated` 的 gh 表达位 —— 开着 + 此 label = 等 owner 裁 (关着则是已裁, label 不再作数)。 */
const ESCALATED_LABEL = 'path:escalated';
/** 云端 Actions 研究完成后打的 label (S2 workflow 打, S3 折入据此收料 + ack 时摘)。 */
const RESEARCH_DONE_LABEL = 'research-done';
const MAP_TITLE_PREFIX = '🧭 [map] ';
/** 有 sub_issues 特性的 GraphQL 需带此 header (对齐 gh api 用法; 真 gh 幂等接受)。 */
const SUB_ISSUE_HEADER = 'GraphQL-Features: sub_issues';

// ── gh 调用小工具 ────────────────────────────────────────────────────────────────

/**
 * 公开面归因剥离 (owner 2026-08-11): 本后端写的是**公开仓** issue —— 任何 session 把
 * `Claude-Session:`/`claude.ai/code` 链接或 "Generated with Claude Code" 署名带进票身/判词/
 * 评论, 都会直接落到公开面 (实测样本: 公开仓 11 个 issue 带署名、2 个带 session 链接,
 * 2026-08-11 已手工清偿)。session 链接虽账号门控, session id 仍是元数据外泄。
 * 剥在 run() 咽喉 (--body/--title 后继参数), 六个现有出口与未来新增出口全覆盖 —— 不指望
 * 上游自觉 (§8.4 讲道理拦不住)。
 */
const ATTRIBUTION_LINE = /^\s*(Co-Authored-By: Claude.*|Claude-Session:.*|.*claude\.ai\/code\/.*|.*Generated with .{0,3}Claude Code.*)$\n?/gm;
function scrubAttribution(text: string): string {
  return text.replace(ATTRIBUTION_LINE, '').trimEnd();
}

/** 跑一条 gh; 非零退出即 throw (fail-loud: 写操作/读拼装任一 gh 失败都要显性, 不静默半成品)。 */
function run(gh: GhRunner, args: string[], ctx: string): string {
  const scrubbed = args.map((a, i) => (i > 0 && (args[i - 1] === '--body' || args[i - 1] === '--title') ? scrubAttribution(a) : a));
  const r: GhResult = gh(scrubbed);
  if (r.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} 失败 (${ctx}, exit=${r.exitCode}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

/** `gh issue create` 打印 issue URL → 尾部 number。拿不到 → throw (创建成功却读不到 number = 半成品)。 */
function parseCreatedNumber(stdout: string, ctx: string): number {
  const m = stdout.match(/\/issues\/(\d+)/) ?? stdout.match(/(\d+)\s*$/);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${ctx}: 从 gh 输出解析不到 issue number: ${stdout.trim()}`);
  return n;
}

/** `#N` / `N` → 纯 number 串 (gh CLI 收 number, 不收 `#`)。 */
function bareNumber(id: string): string {
  return id.replace(/^#/, '');
}

/** 取一张 issue 的 GraphQL node id (addSubIssue mutation 收 node id, 非 number)。 */
function nodeId(gh: GhRunner, issueNumber: string, ctx: string): string {
  const out = run(gh, ['issue', 'view', issueNumber, '--json', 'id'], ctx);
  const j = JSON.parse(out) as { id?: string };
  if (!j.id) throw new Error(`${ctx}: issue ${issueNumber} 无 node id`);
  return j.id;
}

// ── read 拼装 helpers ────────────────────────────────────────────────────────────

/** title `[<type>] <t>` → {type,title}; 无法识别的前缀 → 默认 task, 原样标题。 */
function parseTicketTitle(raw: string, labels: string[]): { type: TicketType; title: string } {
  const fromLabel = labels.map((l) => l.replace(/^path:/, '')).find((n) => (TICKET_TYPES as readonly string[]).includes(n)) as
    | TicketType
    | undefined;
  const mm = raw.match(/^\[([a-z]+)\]\s+(.*)$/);
  const fromTitle = mm && (TICKET_TYPES as readonly string[]).includes(mm[1]!) ? (mm[1] as TicketType) : undefined;
  const type = fromLabel ?? fromTitle ?? 'task';
  const title = mm ? mm[2]! : raw;
  return { type, title };
}

/** 正文尾行 `Blocked-by: #1, #2` → ['#1','#2'] (D-C 单真相; 无该行 → [])。 */
function parseBlockedBy(body: string): string[] {
  const mm = body.match(/^Blocked-by:\s*(.+)$/m);
  if (!mm) return [];
  return mm[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 评论里的裁决: `**ruling**: <text>` → text, **text 一直取到评论末尾** (取**最后一条**命中)。
 *
 * 取最后一条是 #137 (2026-08-17) 改的: `rule()` 每次**新发**一条评论 (gh 上改不了旧评论),
 * comments 按时间正序抓 → 重裁同一张票时最后一条才是现行判词。此前取第一条, 而 `ruledAt`
 * (parseWaitingStamps) 取最后一条的 createdAt —— 同一条记录的两半各指一条评论, 重裁后
 * 文本是旧的、时间戳是新的, 且两侧都不报错。现在两者指同一条。
 *
 * ⚠ `[\s\S]*` 不是 `.*`: JS 里 `.` 不匹配换行、`$` 在 `/m` 下是行尾, 用 `(.*)` 会把判词
 * 截到第一行。实测代价 (2026-08-12 切 gh 当天): issue #103 评论全长 1850 → 读回 93,
 * **丢 94.9%**; 全图 7 张多段判词合计约 13k 字符读不回来。而判词是 `path_deliver` 编
 * slice 节点 goal 的**原料** —— 首行通常只是「修」「封存」这种结论句, 判据/边界/反向自检
 * 全在后面几段, 截掉之后执行体拿到一句结论、零约束, 且两侧都不报错。
 * 整段闸在 `backend-gh-ruling-parse.test.ts`。
 */
export function parseRuling(comments: Array<{ body: string }>): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const mm = comments[i]!.body.match(/^\*\*ruling\*\*:\s*([\s\S]*)$/m);
    if (mm) return mm[1]!.trim();
  }
  return undefined;
}

/**
 * issue state + labels → 静态 status (open 票的 blocked 归一延后到全票集齐后 deriveStatus)。
 * CLOSED 分支**不看** suggested/escalated label: 票已终结, 那两个 label 只是上一轮的残留
 * (已拒建议的 CLOSED+suggested 由 readMapImpl 单独摘掉, 见那里)。
 */
export function baseStatus(state: string, labels: string[]): TicketStatus {
  const closed = state.toUpperCase() === 'CLOSED';
  if (closed) return labels.includes(DELIVERED_LABEL) ? 'delivered' : 'ruled';
  if (labels.includes(SUGGESTED_LABEL)) return 'suggested';
  return labels.includes(ESCALATED_LABEL) ? 'escalated' : 'open';
}

/** 正文锚行 `<Key>: <value>` → value (S-1 溯源/指纹的往返载体; 无该行 → undefined)。 */
function parseAnchor(body: string, key: string): string | undefined {
  const mm = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return mm ? mm[1]!.trim() : undefined;
}

/**
 * 评论流里**最新一条**锚 (#136): retitle 的标题锚走追加评论 (gh 上改正文 = 读-改-写整段,
 * 正是 1890115 事故的形状; 评论 append-only 零 RMW)。取最新与「评论事件戳盖过出生正文锚」
 * (D-5 三戳) 及 parseRuling (#137) 同一个次序纪律。
 */
function latestCommentAnchor(comments: Array<{ body: string }>, key: string): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const v = parseAnchor(comments[i]!.body, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** #136: 三条写题路 (addTicket / suggest / confirmSuggestion retitle) 共用的截断 —— 一处实现, 三处同兜。 */
function fitTitle(full: string): { display: string; overlong: boolean } {
  const overlong = full.length > GH_TITLE_MAX;
  return { display: overlong ? `${full.slice(0, GH_TITLE_MAX - 1)}…` : full, overlong };
}

/** 评论里的 S-1 台账行 `**suggestion-log**: <outcome> <at> <runId>` (一票可多行, 按序收)。 */
function parseSuggestionLog(ticketId: string, comments: Array<{ body: string }>): SuggestionLogEntry[] {
  const out: SuggestionLogEntry[] = [];
  for (const c of comments) {
    const mm = c.body.match(/^\*\*suggestion-log\*\*:\s*(accepted|edited|rejected|deduped|deduped-semantic)\s+(\S+)\s+(\S+)\s*$/m);
    if (mm) out.push({ ticketId, outcome: mm[1] as SuggestionLogEntry['outcome'], at: mm[2]!, runId: mm[3]! });
  }
  return out;
}

/** 一条台账行的评论正文 (写与读同一处定型, 防两边漂移)。 */
function suggestionLogBody(e: SuggestionLogEntry): string {
  return `**suggestion-log**: ${e.outcome} ${e.at} ${e.runId}`;
}

// ── D-5 三戳的 gh 载体 (评论流 = 事件, 出生正文锚 = 初值; 见文件头) ──────────────

/** escalate 打的进入戳评论 (人读一行 + 机器读的 `**waiting-since**` 锚; 写读同一处定型)。 */
function escalatedCommentBody(atIso: string): string {
  return [
    `**waiting-human**: 自动通道到此为止 — 这张票升给 owner 裁 (D-5 escalated)。`,
    ``,
    `**waiting-since**: ${atIso}`,
  ].join('\n');
}

/**
 * 把一张票的评论流**按序重放**成三戳 (纯):
 *  - `**waiting-since**: <iso>` → 新一轮等待开始, 且**清掉**此前的 stale 标
 *    (= 纯核 `markWaitingHuman` 的 delete staleAt; gh 上删不掉旧评论, 靠重放顺序等价实现)。
 *  - `**stale-at**: <iso>`      → 本轮已提醒过 (幂等键, 由 notify-gh 写)。
 *  - `**ruling**: …` 评论的 `createdAt` → ruledAt (最后一条为准: "最近一次裁决被记下的时刻";
 *    #137 后 `parseRuling` 也取最后一条 —— 判词文本与时间戳指**同一条**评论, 重裁不再各说各话)。
 *    响应没给 createdAt (老 fixture / 精简查询) → ruledAt 缺席 = **没记上**, 不编时间 (NULL≠0)。
 */
function parseWaitingStamps(comments: Array<{ body: string; createdAt?: string }>): Pick<Ticket, 'waitingSince' | 'ruledAt' | 'staleAt'> {
  const out: { waitingSince?: string; ruledAt?: string; staleAt?: string } = {};
  for (const c of comments) {
    const since = c.body.match(/^\*\*waiting-since\*\*:\s*(\S+)\s*$/m);
    if (since) {
      out.waitingSince = since[1]!;
      delete out.staleAt;
    }
    const stale = parseStaleAt(c.body);
    if (stale !== undefined) out.staleAt = stale;
    if (/^\*\*ruling\*\*:/m.test(c.body) && c.createdAt !== undefined) out.ruledAt = c.createdAt;
  }
  return out;
}

// ── D-4 渲染面 (INV-1: gh 侧状态**只是**这三位的投影, 不是独立真源) ─────────────────

/** gh 侧渲染四元组: issue 开/关 + 三个状态 label。两个 status 渲染相同 = 无冲突 (不刷注记)。
 * export (2026-08-11, S5 票看板): 双端同数测试的 gh 臂必须对拍**真实现**而非在测试里复刻语义 ——
 * 复刻与实装同源转录, 实装改坏抓不到 (本仓「测试与实装互相背书」图鉴形态)。 */
export interface GhRender {
  closed: boolean;
  suggested: boolean;
  delivered: boolean;
  escalated: boolean;
}

/**
 * 盘上 status → 它**应该**长成的 gh 渲染。
 * `blocked` 与 `open` 仍是同一渲染 (前置未散是**算出来的**, gh 侧不存这个);
 * `escalated` 从 2026-08-11 起有表达位 (`path:escalated`) —— 切片 4 那句"gh 侧无对应表达位"
 * 到此为止: 有位就得纳入比对, 否则 gh 侧留着一个盘上没有的 label = 独立状态 (违 INV-1)。
 */
export function renderOf(status: TicketStatus): GhRender {
  switch (status) {
    case 'suggested':
      return { closed: false, suggested: true, delivered: false, escalated: false };
    case 'escalated':
      return { closed: false, suggested: false, delivered: false, escalated: true };
    case 'ruled':
      return { closed: true, suggested: false, delivered: false, escalated: false };
    case 'delivered':
      return { closed: true, suggested: false, delivered: true, escalated: false };
    default:
      return { closed: false, suggested: false, delivered: false, escalated: false };
  }
}

// GraphQL: map issue + 两层 sub-issue + 标签/评论 (一次抓齐, SDD "readMap 每次实时拼, 不做缓存层")。
// native 策略额外并进 `blockedBy(first:50){nodes{number}}` (D-C.2: 前沿边真相走原生依赖, readMap 仍一次抓齐)。
function readMapQuery(nativeDeps: boolean): string {
  const blockedByField = nativeDeps ? '\n        blockedBy(first:50){ nodes{ number } }' : '';
  return `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      number title body state
      subIssues(first:100){ nodes{
        number title body state updatedAt
        labels(first:20){ nodes{ name } }
        comments(first:50){ nodes{ body createdAt author{ login } } }
        subIssues(first:100){ nodes{ number } }${blockedByField}
      }}
    }
  }
}`;
}

const ADD_SUB_ISSUE_MUTATION = `mutation($parentId:ID!,$childId:ID!){
  addSubIssue(input:{issueId:$parentId,subIssueId:$childId}){ issue{ number } }
}`;

interface GqlLabel {
  name: string;
}
interface GqlSubTicket {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { nodes: GqlLabel[] };
  /** `createdAt` = ruledAt 那一戳的来源 (老 fixture / 旧响应可能没有 → 该戳缺席, 不编)。 */
  comments: { nodes: Array<{ body: string; createdAt?: string; author?: { login: string } | null }> };
  subIssues: { nodes: Array<{ number: number }> };
  /** gh 侧最后改动时刻 (G-3 冲突注记的 gh 时间; 老 fixture / 旧响应可能没有 → 注记写「未知」)。 */
  updatedAt?: string;
  /** native 策略专属: 原生 issue-dependencies 前置票 (legacy 策略该字段不查, 为 undefined)。 */
  blockedBy?: { nodes: Array<{ number: number }> };
}
interface GqlMapIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  subIssues: { nodes: GqlSubTicket[] };
}

// ── D-4 镜像同步口 (G-3 后半; PathBackend 之外的 gh 专属能力, 故独立接口) ─────────

/** 一条"gh 侧被手改"的冲突记录 (以盘为准覆盖之后的回执; 注记原文一并带回, 调用方可直接念)。 */
export interface GhMirrorConflict {
  ticketId: string;
  /** 盘上 map 认为的状态 (唯一真源)。 */
  mapStatus: TicketStatus;
  /** gh 侧自称的状态 (由 issue 开关 + 状态 label 反推)。 */
  ghStatus: TicketStatus;
  /** gh 侧最后改动时刻; 响应无该字段 → undefined (NULL≠0: 不编时间)。 */
  ghUpdatedAt?: string;
  /** 落在该 issue 上的冲突注记原文。 */
  note: string;
}

export interface GhMirrorSyncResult {
  /** 被纠正回盘上状态的票 (= conflicts 的 id 集)。 */
  synced: string[];
  conflicts: GhMirrorConflict[];
  /** 盘上有票但 gh 无对应 issue —— 本切片不代建, 但绝不静默 (NULL≠0)。 */
  missing: string[];
}

/** gh 渲染后端的镜像同步能力 (D-4: 盘上 map 唯一真源, gh 镜像不裁决)。 */
export interface GhMirror {
  /**
   * 以盘上 map (`truth`) 为准把 gh 侧渲染纠正回来 (G-3): 逐票比对**渲染三元组**
   * (开关 + suggested/delivered label) —— 渲染等价的状态差 (blocked/escalated ↔ open) 不算冲突,
   * 否则每轮刷一条无意义注记。发现不一致 → **先**在该 issue 留冲突注记 (含两侧状态与时间),
   * **再**覆盖 (证据先行: 覆盖中途炸了, 现场还在)。map issue 不存在 → throw (不静默当全一致)。
   */
  syncFromMap(cwd: string, slug: string, truth: PathMap, opts: { at: string }): GhMirrorSyncResult;
}

// ── 后端工厂 (构造即探测 repo, fail-loud) ───────────────────────────────────────

/**
 * 构造 gh 后端: 先探 `gh repo view --json nameWithOwner` (一次覆盖 gh 装没装 / 认没认证 / 有没 remote
 * 三种失败, D-E fail-loud)。owner/repo 缓存进闭包供后续 GraphQL 用。探测失败 → throw 带修复命令。
 *
 * `nativeDeps` (缺省 false 保守): blockedBy 真相源二选一 (D-C.2, 每仓恰一真相, 无 fallback 交叉) ——
 *   false = legacy body 尾行; true = 原生 issue-dependencies (读 GraphQL 字段 / 写 REST POST)。
 *
 * `notify` (缺省 = gh 评论通道): `sweepWaiting` 标 stale 时的提醒钩子 (O-1)。缺省实装就落在
 * 同一个 `gh` 上, 所以 `resolveBackend` 不必知道通道的存在 (接线零改动); 测试可注入替身。
 */
export function createGhBackend(gh: GhRunner, nativeDeps = false, notify: WaitingHumanNotifier = createGhWaitingNotifier(gh)): PathBackend & GhMirror {
  const probe = gh(['repo', 'view', '--json', 'nameWithOwner']);
  if (probe.exitCode !== 0) {
    throw new Error(
      `pathfinder gh 后端不可用 (探测 \`gh repo view\` 失败, exit=${probe.exitCode}): ${(probe.stderr || probe.stdout || '').trim()}\n` +
        `修复: 装 gh (https://cli.github.com) → \`gh auth login\` (需 repo,workflow scope: \`gh auth refresh -s repo,workflow\`) → 在有 GitHub remote 的 repo 内运行; ` +
        `或设 OMD_PATH_BACKEND=md 用本地 markdown 后端。`,
    );
  }
  let owner = '';
  let repo = '';
  try {
    const nwo = (JSON.parse(probe.stdout) as { nameWithOwner?: string }).nameWithOwner ?? '';
    const parts = nwo.split('/');
    owner = parts[0] ?? '';
    repo = parts[1] ?? '';
  } catch {
    /* 落到下面的空值校验 */
  }
  if (!owner || !repo) {
    throw new Error(`pathfinder gh 后端: 解析不到 owner/repo (gh repo view 输出: ${probe.stdout.trim()}) — 设 OMD_PATH_BACKEND=md 回退。`);
  }

  // 该后端实例的 read 查询按策略定型一次 (native 多并一个 blockedBy 字段)。
  const readQuery = readMapQuery(nativeDeps);

  /** 跑 readMap 的 GraphQL, 返回 map issue 节点 (不存在 → null)。 */
  const fetchMap = (mapNumber: number): GqlMapIssue | null => {
    const out = run(
      gh,
      ['api', 'graphql', '-H', SUB_ISSUE_HEADER, '-f', `query=${readQuery}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${mapNumber}`],
      'readMap',
    );
    const j = JSON.parse(out) as { data?: { repository?: { issue?: GqlMapIssue | null } } };
    return j.data?.repository?.issue ?? null;
  };

  /** native 策略: 取一张 issue 的 databaseId (REST dependencies 端点收 databaseId, 非 number)。 */
  const databaseId = (issueNumber: string, ctx: string): string => {
    const out = run(gh, ['api', `repos/${owner}/${repo}/issues/${issueNumber}`, '--jq', '.id'], ctx);
    const id = out.trim();
    if (!id) throw new Error(`${ctx}: issue ${issueNumber} 取不到 databaseId`);
    return id;
  };

  /** 建一张票 issue 并挂到母票/地图下 (addTicket 与 suggest 共用; 调用序: create → 母/子 nodeId → addSubIssue)。 */
  const createTicketIssue = (o: { title: string; labels: string[]; body: string; parent: string; ctx: string }): number => {
    const out = run(gh, ['issue', 'create', '--title', o.title, '--label', o.labels.join(','), '--body', o.body], o.ctx);
    const number = parseCreatedNumber(out, o.ctx);
    const parentId = nodeId(gh, bareNumber(o.parent), `${o.ctx}:parentNode`);
    const childId = nodeId(gh, String(number), `${o.ctx}:childNode`);
    run(
      gh,
      ['api', 'graphql', '-H', SUB_ISSUE_HEADER, '-f', `query=${ADD_SUB_ISSUE_MUTATION}`, '-f', `parentId=${parentId}`, '-f', `childId=${childId}`],
      `${o.ctx}:addSubIssue`,
    );
    return number;
  };

  /** 一条台账评论 (S-1 INV-S1-3: 处置留痕落在**当事 issue**上, 人在 gh 上直接读得到)。 */
  const logComment = (ticketId: string, e: SuggestionLogEntry, ctx: string): void => {
    run(gh, ['issue', 'comment', bareNumber(ticketId), '--body', suggestionLogBody(e)], ctx);
  };

  /** readMap 本体 (suggest/confirmSuggestion 也从这里取图 —— 决策全在纯核, gh 侧只 emit)。 */
  const readMapImpl = (slug: string): PathMap | null => {
    const mapNumber = Number(bareNumber(slug));
    if (!Number.isFinite(mapNumber)) return null;
    const issue = fetchMap(mapNumber);
    if (!issue) return null;
    const destination = issue.title.startsWith(MAP_TITLE_PREFIX) ? issue.title.slice(MAP_TITLE_PREFIX.length) : issue.title;

    // 一遍: 把 sub-issue 拼成静态 Ticket (open 票的 blocked 归一在第二遍)。
    const tickets: Ticket[] = [];
    const suggestionsLog: SuggestionLogEntry[] = [];
    for (const sub of issue.subIssues.nodes) {
      const labels = sub.labels.nodes.map((l) => l.name);
      const id = `#${sub.number}`;
      // S-1 台账先收: 已拒建议的票下面这行也要收 (拒绝不是删除无痕, INV-S1-3)。
      suggestionsLog.push(...parseSuggestionLog(id, sub.comments.nodes));
      const status = baseStatus(sub.state, labels);
      // CLOSED + path:suggested = **已拒建议**: 纯核语义里它已被移出图 → 这里同样不当票
      // (若不认这条, 它会被 baseStatus 读成 ruled 混进决策日志 —— 拒绝反倒成了裁决)。
      if (status !== 'suggested' && labels.includes(SUGGESTED_LABEL)) continue;
      const { type, title } = parseTicketTitle(sub.title, labels);
      const body = sub.body ?? '';
      // 超长票的全文标题锚 (见 addTicket 处注记): 有锚就以锚为准, issue title 只是被截断的显示名。
      // #136: retitle 的锚走追加评论, 最新评论锚 > 出生正文锚 (次序同 D-5 三戳)。
      const fullTitle = latestCommentAnchor(sub.comments.nodes, 'Origin-title') ?? parseAnchor(body, 'Origin-title') ?? title;
      // escalated 也读判词 (2026-08-12): types.ts:49 明写「票可被裁过又重新升人, escalate **不清**
      // ruling」—— 本仓真有这张 (proto-cube-sandbox-leaf, 判词 1108 字后升人)。漏掉这一档 = 升一次人
      // 就把判词读没了, 而 md 侧留着 ⇒ 同一张票两个后端读出两个内容。open/blocked/suggested 仍不读:
      // 那三态**没被裁过**, 评论里出现 `**ruling**` 只可能是人手写的草稿, 不是判词。
      const ruling = status === 'ruled' || status === 'delivered' || status === 'escalated' ? parseRuling(sub.comments.nodes) : undefined;
      const children = sub.subIssues.nodes.map((c) => `#${c.number}`);
      // blockedBy 单真相 (D-C.2): native 读原生依赖字段, legacy 读 body 尾行, 二选一不混用。
      const blockedBy = nativeDeps ? (sub.blockedBy?.nodes ?? []).map((n) => `#${n.number}`) : parseBlockedBy(body);
      // #138 交付级前置: 出生正文锚 ∪ 追加评论锚 (append-only 加边, 退补已存在的票零正文 RMW;
      // 与 #136/#137 同一条评论纪律)。union 语义: 边只增不减 —— 要撤边等于改裁决, 那是 re-rule 的事。
      const blockedByDelivery = [
        ...new Set(
          [parseAnchor(body, 'Blocked-by-delivery'), ...sub.comments.nodes.map((c) => parseAnchor(c.body, 'Blocked-by-delivery'))]
            .flatMap((v) => v?.split(',') ?? [])
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      // S-1 溯源/指纹走正文锚往返 (缺锚 → undefined, 不编)。
      const suggestedBy = parseAnchor(body, 'Suggested-by');
      const fingerprint = parseAnchor(body, 'Fingerprint');
      // executorKind 正文锚往返 (见 addTicket 处注记)。词表外的值不认 (盘上人可手改 → fail-closed,
      // 宁可读成"没标"走缺省, 也不把 `agnet` 这种手滑喂进 toPlanExecutor 的 switch)。
      const ekRaw = parseAnchor(body, 'Executor-kind');
      const executorKind = (EXECUTOR_KINDS as readonly string[]).includes(ekRaw ?? '') ? (ekRaw as ExecutorKind) : undefined;
      // D-5 三戳: 评论流的事件戳**盖过**出生正文锚 (建议票被接受后又被升人 → 后一轮才是当前那轮)。
      const stamps = parseWaitingStamps(sub.comments.nodes);
      const waitingSince = stamps.waitingSince ?? parseAnchor(body, 'Waiting-since');
      tickets.push({
        id,
        type,
        title: fullTitle,
        blockedBy,
        ...(blockedByDelivery.length ? { blockedByDelivery } : {}),
        status,
        ...(ruling !== undefined ? { ruling } : {}),
        ...(executorKind !== undefined ? { executorKind } : {}),
        ...(children.length > 0 ? { children } : {}),
        ...(suggestedBy !== undefined ? { suggestedBy } : {}),
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        ...(waitingSince !== undefined ? { waitingSince } : {}),
        ...(stamps.ruledAt !== undefined ? { ruledAt: stamps.ruledAt } : {}),
        ...(stamps.staleAt !== undefined ? { staleAt: stamps.staleAt } : {}),
      });
    }

    // 二遍: open 票据 blockedBy 是否全裁归一 open/blocked (frontier.deriveStatus 纯函数复用;
    // suggested 票不参与 —— 它在人点头前不获得任何执行力, INV-S1-1)。
    const ruledSet = new Set(tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
    for (const t of tickets) {
      if (t.status === 'open') t.status = deriveStatus(t, ruledSet);
    }

    const decisionsLog = tickets.filter((t) => t.ruling !== undefined).map((t) => ({ ticketId: t.id, gist: t.ruling!.slice(0, 80) }));
    return {
      destination,
      slug: String(mapNumber),
      tickets,
      decisionsLog,
      ...(suggestionsLog.length > 0 ? { suggestionsLog } : {}),
    };
  };

  return {
    kind: 'gh',
    listMaps: () => {
      const out = run(gh, ['issue', 'list', '--label', MAP_LABEL, '--state', 'all', '--json', 'number,title'], 'listMaps');
      const rows = JSON.parse(out) as Array<{ number: number; title: string }>;
      return rows.map((r) => ({
        slug: String(r.number),
        destination: r.title.startsWith(MAP_TITLE_PREFIX) ? r.title.slice(MAP_TITLE_PREFIX.length) : r.title,
      }));
    },

    readMap: (_cwd, slug) => readMapImpl(slug),

    createMap: (_cwd, destination) => {
      const body = `Destination: ${destination}\n\n## Fog\n\n## Decisions so far\n`;
      const out = run(gh, ['issue', 'create', '--title', `${MAP_TITLE_PREFIX}${destination}`, '--label', MAP_LABEL, '--body', body], 'createMap');
      const number = parseCreatedNumber(out, 'createMap');
      return { destination, slug: String(number), tickets: [], decisionsLog: [] };
    },

    addTicket: (_cwd, slug, nt) => {
      const bodyLines: string[] = [];
      if (nt.body) bodyLines.push(nt.body);
      // executorKind 正文锚 (2026-08-12, md→gh 迁移前置): 不落锚就**静默改变交付行为** ——
      // slice-compiler 的 toPlanExecutor 缺省 `inproc → leaf`, 于是一张 `agent` 票搬上 gh 再读回来
      // 会被编译成单发 leaf, 而症状是沉默的 (图照跑, 只是执行器换了)。形状对称 Suggested-by/Fingerprint。
      if (nt.executorKind) bodyLines.push(`Executor-kind: ${nt.executorKind}`);
      // gh issue title 硬上限 256 字 (GraphQL `Title is too long`), 而票的 title 是**不限长的自由文本**
      // —— 本仓真有一张 1600 字的 grill 票 (整篇分析写在标题里)。超长 → issue title 截断作显示名,
      // 全文落 `Origin-title` 锚, readMap 优先读锚 ⇒ **往返无损**, 截断只影响 gh 网页上的那一行。
      const fit = fitTitle(`[${nt.type}] ${nt.title}`);
      if (fit.overlong) bodyLines.push(`Origin-title: ${nt.title}`);
      // legacy 策略: blockedBy 落 body 尾行 (单真相)。native 策略: body 绝不写尾行, 前置边走原生 REST (见下)。
      if (!nativeDeps && nt.blockedBy.length > 0) bodyLines.push(`Blocked-by: ${nt.blockedBy.join(', ')}`);
      // #138 交付级前置: **两种策略都走正文锚** —— 这是我们自己的语义 (delivered 才解锁),
      // gh 原生依赖没有这一档, 塞进去会被读成普通 blockedBy (语义降级比缺席更坏)。
      if (nt.blockedByDelivery?.length) bodyLines.push(`Blocked-by-delivery: ${nt.blockedByDelivery.join(', ')}`);
      const body = bodyLines.join('\n\n');
      // sub-issue 挂接 (归属血缘, D-G): parentId 给则挂母票, 否则挂地图。
      const number = createTicketIssue({
        title: fit.display,
        labels: [`path:${nt.type}`],
        body,
        parent: nt.parentId ?? slug,
        ctx: 'addTicket',
      });

      // native 策略 (D-C.2): 逐个 blocking 票取 databaseId → REST POST 建原生依赖 (任一失败 fail-loud)。
      if (nativeDeps) {
        for (const dep of nt.blockedBy) {
          const depId = databaseId(bareNumber(dep), 'addTicket:blockedByLookup');
          run(
            gh,
            ['api', '-X', 'POST', `repos/${owner}/${repo}/issues/${number}/dependencies/blocked_by`, '-F', `issue_id=${depId}`],
            'addTicket:blockedBy',
          );
        }
      }

      const t: Ticket = {
        id: `#${number}`,
        type: nt.type,
        title: nt.title,
        blockedBy: nt.blockedBy,
        status: 'open',
        ...(nt.executorKind ? { executorKind: nt.executorKind } : {}),
      };
      return t;
    },

    /**
     * S-1 片 e (t5 欠账): 机器建议入图。**决策全在纯核** (applySuggestions: 溯源必填 / 指纹 + 语义
     * 去重 / 双上限), gh 侧只把纯核的结论 emit 成 issue —— 建议票 = 开着 + `path:suggested` label,
     * 溯源与指纹落正文锚 (下次 readMap 往返回来, 跨 session 去重才成立)。
     * 去重/丢弃不静默 (INV-S1-4): 去重行以台账评论落在**撞上的那张票**上。
     */
    suggest: (_cwd, slug, drafts: SuggestionDraft[], opts: ApplySuggestionsOpts): ApplySuggestionsResult => {
      const map = readMapImpl(slug);
      if (!map) throw new Error(`找不到地图 "${slug}"`);
      const before = map.suggestionsLog?.length ?? 0;
      const res = applySuggestions(map, drafts, opts);
      // 纯核给的是内存 id (s1/s2); gh 的稳定 id 只能是 issue number (D-D), 建完回填。
      const added: Ticket[] = res.added.map((t) => {
        const bodyLines = [`Suggested-by: ${t.suggestedBy}`, `Fingerprint: ${t.fingerprint}`];
        // D-5 出生戳 (纯核 applySuggestions 已打在票上): 落**建票时的正文锚** —— 建议票一出生就在
        // 等人确认, 没这一戳它的等待读数恒为 waiting-unknown-since, 超时永不触发 (切片 6 的 md 教训)。
        if (t.waitingSince) bodyLines.push(`Waiting-since: ${t.waitingSince}`);
        if (!nativeDeps && t.blockedBy.length > 0) bodyLines.push(`Blocked-by: ${t.blockedBy.join(', ')}`);
        // #136 路②: 机器建议票的标题同样不限长 (afk-hook 生成), 与 addTicket 同兜 —— 此前裸传,
        // 超 256 直接抛, 整批 suggest 断在半路。
        const fit = fitTitle(`[${t.type}] ${t.title}`);
        if (fit.overlong) bodyLines.push(`Origin-title: ${t.title}`);
        const number = createTicketIssue({
          title: fit.display,
          labels: [`path:${t.type}`, SUGGESTED_LABEL],
          body: bodyLines.join('\n\n'),
          parent: slug,
          ctx: 'suggest',
        });
        return { ...t, id: `#${number}` };
      });
      // 本次新增的台账行 (deduped / deduped-semantic) → 落在被撞上的票下面。
      for (const e of (map.suggestionsLog ?? []).slice(before)) logComment(e.ticketId, e, 'suggest:log');
      return { ...res, added };
    },

    /**
     * 人确认一张 suggested 票 (S-1 GWT-3/4/5)。状态机判定走纯核 (非 suggested 票 → throw, 幂等拒绝),
     * gh 侧只同步渲染:
     *   - accept: (改题则先改 title) → 留台账评论 → **摘 `path:suggested` label** (票就此进前沿生命周期)。
     *   - reject: 留台账评论 → close 但**保留 label** (CLOSED+suggested = 已拒建议, 与已裁票区分)。
     * 台账评论先于状态改动 (证据先行: 改到一半炸了, 处置记录还在)。
     */
    confirmSuggestion: (_cwd, slug, ticketId, action: ConfirmAction, opts): SuggestionLogEntry => {
      const map = readMapImpl(slug);
      if (!map) throw new Error(`找不到地图 "${slug}"`);
      const before = map.tickets.find((t) => t.id === ticketId);
      const entry = confirmSuggestionPure(map, ticketId, action, opts); // 非 suggested / 不存在 → throw (零 gh 写)
      const n = bareNumber(ticketId);
      if (action === 'reject') {
        logComment(ticketId, entry, 'confirmSuggestion:log');
        run(gh, ['issue', 'close', n], 'confirmSuggestion:close');
      } else {
        if (entry.outcome === 'edited') {
          // #136 路③: 改题同兜 256。标题锚走**追加评论**而不是改正文 —— 改正文 = 读-改-写整段
          // (1890115 事故的形状, 手写字段静默丢); 且不只超长时发: 出生若截断过, 正文里的旧
          // Origin-title 锚还在, 不盖会赢过新题 (readMap 次序: 评论锚 > 正文锚 > issue title)。
          const fit = fitTitle(`[${before!.type}] ${opts.title!}`);
          run(gh, ['issue', 'edit', n, '--title', fit.display], 'confirmSuggestion:retitle');
          run(gh, ['issue', 'comment', n, '--body', `Origin-title: ${opts.title!}`], 'confirmSuggestion:retitle-anchor');
        }
        logComment(ticketId, entry, 'confirmSuggestion:log');
        run(gh, ['issue', 'edit', n, '--remove-label', SUGGESTED_LABEL], 'confirmSuggestion:unlabel');
      }
      return entry;
    },

    // D-5 裁决戳 (`ruledAt`) **不在这里写**: 下面这条判词评论自带 `createdAt` 就是"判词落盘的时刻",
    // readMap 直接读它 (还顺带补齐了历史票)。多发一条 `**ruled-at**` 评论只是给手机上的人多推一条噪声,
    // 且判词评论的字节形状是既有闸钉死的 (backend.test.ts「rule: comment **ruling** + close」)。
    rule: (_cwd, _slug, ticketId, ruling) => {
      const n = bareNumber(ticketId);
      run(gh, ['issue', 'comment', n, '--body', `**ruling**: ${ruling}`], 'rule:comment');
      run(gh, ['issue', 'close', n], 'rule:close');
    },

    /**
     * D-G1.4 + D-5: goal 票升人 —— 票翻 escalated 并打进入戳。
     *
     * 三步都不可省 (调用点 `reflowGoalResults` 传进来的票状态是 **ruled** = gh 上 CLOSED):
     *   ① 进入戳评论 (证据先行: 后面两步炸了, "何时升的人"还留得下);
     *   ② CLOSED → reopen (不开回来, readMap 仍读成 ruled, 这次升级等于没发生);
     *   ③ 加 `path:escalated` label (开着 + 该 label 才读得回 escalated)。
     * 票不在图上 → throw (与 md 后端同款 fail-loud; 零 gh 写)。
     */
    escalate: (_cwd, slug, ticketId) => {
      const map = readMapImpl(slug);
      const tk = map?.tickets.find((t) => t.id === ticketId);
      if (!tk) throw new Error(`escalate: 找不到票 "${ticketId}" (图 "${slug}")`);
      const n = bareNumber(ticketId);
      // 时钟在端口取 (纯核 markWaitingHuman 仍不自取时钟, 可重放) —— 同 md 后端。
      run(gh, ['issue', 'comment', n, '--body', escalatedCommentBody(new Date().toISOString())], 'escalate:stamp');
      if (tk.status === 'ruled' || tk.status === 'delivered') run(gh, ['issue', 'reopen', n], 'escalate:reopen');
      if (tk.status !== 'escalated') run(gh, ['issue', 'edit', n, '--add-label', ESCALATED_LABEL], 'escalate:label');
    },

    /**
     * D-5/G-5: 扫本图超时的等人票 → 经 `notify` 在对应 issue 落提醒评论 (O-1 的 gh 通道)。
     *
     * gh 侧**没有本地盘**: 那条提醒评论里的 `**stale-at**` 锚**就是** `staleAt` 的持久化,
     * 于是"同一轮超时不重复提醒"靠状态成立 (下一轮 readMap 读回 staleAt → 纯核直接跳过),
     * 不靠进程记忆 —— MCP server 是 pull 模型, 根本没有跨调用的记忆。
     *
     * **零 stale 零写** (1890115 铁律的 gh 版): 判定全在纯核 (先读后判), 只有真的 fired 才经
     * notify 发评论 —— 没票超时 = 零 gh 写调用。图不存在 → [] (读路径上顺手扫的东西不炸掉 path_tickets)。
     * notify 抛错由纯核 fail-open 吞掉并打 stderr: 此时 `stale-at` 没落地 → 下轮重判重发 (自愈)。
     */
    sweepWaiting: (_cwd, slug, opts): WaitingLogEntry[] => {
      const map = readMapImpl(slug);
      if (!map) return [];
      return sweepWaitingHuman(map, { ...opts, notify });
    },

    // ruled 票已 close (rule 关的); delivered 只补 label → readMap 据 label 区分 ruled/delivered。
    markDelivered: (_cwd, _slug, ticketIds) => {
      for (const id of ticketIds) {
        run(gh, ['issue', 'edit', bareNumber(id), '--add-label', DELIVERED_LABEL], 'markDelivered');
      }
    },

    // S3 折入入料: 带 research-done label 的 sub-issue → body = 评论堆里**最后一条**含结果形状 (`## 终稿`)
    // 的正文 (S2 workflow 贴的即 result.md 原文)。有 label 但无结果评论 (被删/异常) → body 空串,
    // 让编排标警告不 ack (留待下轮), 绝不静默跳过。一次 GraphQL 抓齐 label+评论 (与 readMap 同查询)。
    collectOwnerCommands: (_cwd, slug) => {
      const mapNumber = Number(bareNumber(slug));
      if (!Number.isFinite(mapNumber)) return [];
      const issue = fetchMap(mapNumber);
      if (!issue) return [];
      const out: Array<{ ticketId: string; command: 'rule' | 'confirm-accept' | 'confirm-reject'; text: string }> = [];
      for (const sub of issue.subIssues.nodes) {
        // 幂等锚: 只收未终结的票 (open / suggested / escalated)。CLOSED 票 = 裁决已落地, 下轮天然不再收。
        // ⚠ escalated 必须在内 (2026-08-11): 超时提醒评论叫人在**本 issue** 回 `/rule`, 而 escalated
        //   正是那批票 —— 不收就等于把人引到一条会被静默丢弃的路上 (提醒说的话必须是真的)。
        // ⚠ /rule 额外不认 suggested: suggested 票上的 `/rule` **不收** —— 状态机要求先 confirm,
        //   收了等于绕过人确认直接裁掉一张机器建议 (S-1 GWT-8 挡的正是这个)。
        const status = baseStatus(sub.state, sub.labels.nodes.map((l) => l.name));
        if (status !== 'open' && status !== 'suggested' && status !== 'escalated') continue;
        // 每票取**最后一条** owner 指令评论 (改主意以最新为准)。
        let hit: { command: 'rule' | 'confirm-accept' | 'confirm-reject'; text: string } | null = null;
        for (const c of sub.comments.nodes) {
          // 层间人解锁只认 owner 本人 —— 非 owner (协作者/bot/路人) 的指令评论**永不**生效。
          if (c.author?.login !== owner) continue;
          const rule = c.body.match(/^\/rule\s+([\s\S]+)$/);
          if (rule) {
            hit = { command: 'rule', text: rule[1]!.trim() };
            continue;
          }
          const confirm = c.body.match(/^\/confirm\s+(accept|reject)\s*$/);
          if (confirm) hit = { command: confirm[1] === 'accept' ? 'confirm-accept' : 'confirm-reject', text: '' };
        }
        if (!hit) continue;
        if (hit.command === 'rule' && status === 'suggested') continue; // 见上: suggested 票不接 /rule (escalated 接)
        out.push({ ticketId: `#${sub.number}`, ...hit });
      }
      return out;
    },
    collectResearchResults: (_cwd, slug) => {
      const mapNumber = Number(bareNumber(slug));
      if (!Number.isFinite(mapNumber)) return [];
      const issue = fetchMap(mapNumber);
      if (!issue) return [];
      const out: Array<{ ticketId: string; body: string }> = [];
      for (const sub of issue.subIssues.nodes) {
        const labels = sub.labels.nodes.map((l) => l.name);
        if (!labels.includes(RESEARCH_DONE_LABEL)) continue;
        // 最后一条结果形状评论 (倒序找第一个命中): 同票多次研究时取最新那份。
        let body = '';
        for (let i = sub.comments.nodes.length - 1; i >= 0; i--) {
          const c = sub.comments.nodes[i]!.body;
          if (looksLikeResult(c)) {
            body = c;
            break;
          }
        }
        out.push({ ticketId: `#${sub.number}`, body });
      }
      return out;
    },

    // ack = 摘 research-done label (幂等锚点): 下轮 collectResearchResults 不再命中该票。
    ackResearchResult: (_cwd, _slug, ticketId) => {
      run(gh, ['issue', 'edit', bareNumber(ticketId), '--remove-label', RESEARCH_DONE_LABEL], 'ackResearchResult');
    },

    // D-4/G-3: 盘上 map 是唯一写真源, gh 是渲染后端 —— 手改 gh 不改变任何决定, 只造成一次要被
    // 纠正的漂移。纠正**不静默**: 每条冲突先在该 issue 留注记 (两侧状态 + 两侧时间), 再覆盖。
    // INV-1: 这里发的全是渲染面操作 (close/reopen/label), 零裁决 (不写 **ruling**, 不建票)。
    syncFromMap: (_cwd, slug, truth, opts): GhMirrorSyncResult => {
      const mapNumber = Number(bareNumber(slug));
      const issue = Number.isFinite(mapNumber) ? fetchMap(mapNumber) : null;
      if (!issue) throw new Error(`syncFromMap: 找不到地图 "${slug}" 对应的 gh issue — 同步中止 (不静默当作全一致)`);
      const bySub = new Map(issue.subIssues.nodes.map((s) => [`#${s.number}`, s]));

      const conflicts: GhMirrorConflict[] = [];
      const missing: string[] = [];
      for (const t of truth.tickets) {
        const sub = bySub.get(t.id);
        if (!sub) {
          missing.push(t.id); // 本切片不代建镜像 (非目标); 但"没镜像"要报出来, 不冒充一致
          continue;
        }
        const labels = sub.labels.nodes.map((l) => l.name);
        const have: GhRender = {
          closed: sub.state.toUpperCase() === 'CLOSED',
          suggested: labels.includes(SUGGESTED_LABEL),
          delivered: labels.includes(DELIVERED_LABEL),
          escalated: labels.includes(ESCALATED_LABEL),
        };
        const want = renderOf(t.status);
        if (
          have.closed === want.closed &&
          have.suggested === want.suggested &&
          have.delivered === want.delivered &&
          have.escalated === want.escalated
        ) {
          continue;
        }

        const n = bareNumber(t.id);
        const ghStatus = baseStatus(sub.state, labels);
        const ghAt = sub.updatedAt ?? '未知'; // NULL≠0: 响应没给时间就写"未知", 不拿同步时刻冒充
        const note =
          `**conflict**: gh 侧状态与盘上 map 不一致 — 以盘为准覆盖 (D-4 单真源, gh 是渲染后端不裁决)。\n` +
          `- 盘: ${t.status} (同步于 ${opts.at})\n` +
          `- gh: ${ghStatus} (gh 更新于 ${ghAt}) — 本次已被覆盖\n` +
          `要改状态请走 map (裁决只在盘上落账); 直接改 issue 会在下次同步被盖掉。`;
        // 注记**先发**: 覆盖中途失败也留得下现场 (fail-loud 不吞证据)。
        run(gh, ['issue', 'comment', n, '--body', note], 'syncFromMap:conflictNote');
        if (have.closed !== want.closed) run(gh, ['issue', want.closed ? 'close' : 'reopen', n], 'syncFromMap:state');
        if (have.suggested !== want.suggested) {
          run(gh, ['issue', 'edit', n, want.suggested ? '--add-label' : '--remove-label', SUGGESTED_LABEL], 'syncFromMap:suggestedLabel');
        }
        if (have.delivered !== want.delivered) {
          run(gh, ['issue', 'edit', n, want.delivered ? '--add-label' : '--remove-label', DELIVERED_LABEL], 'syncFromMap:deliveredLabel');
        }
        if (have.escalated !== want.escalated) {
          run(gh, ['issue', 'edit', n, want.escalated ? '--add-label' : '--remove-label', ESCALATED_LABEL], 'syncFromMap:escalatedLabel');
        }
        conflicts.push({ ticketId: t.id, mapStatus: t.status, ghStatus, ...(sub.updatedAt !== undefined ? { ghUpdatedAt: sub.updatedAt } : {}), note });
      }
      return { synced: conflicts.map((c) => c.ticketId), conflicts, missing };
    },
  };
}
