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
 */
import { deriveStatus } from './frontier';
import { looksLikeResult } from './result-format';
import type { GhResult, GhRunner, PathBackend } from './backend';
import type { Ticket, TicketStatus, TicketType } from './types';

const TICKET_TYPES: readonly TicketType[] = ['research', 'grill', 'prototype', 'task'];
const MAP_LABEL = 'path:map';
const DELIVERED_LABEL = 'path:delivered';
/** 云端 Actions 研究完成后打的 label (S2 workflow 打, S3 折入据此收料 + ack 时摘)。 */
const RESEARCH_DONE_LABEL = 'research-done';
const MAP_TITLE_PREFIX = '🧭 [map] ';
/** 有 sub_issues 特性的 GraphQL 需带此 header (对齐 gh api 用法; 真 gh 幂等接受)。 */
const SUB_ISSUE_HEADER = 'GraphQL-Features: sub_issues';

// ── gh 调用小工具 ────────────────────────────────────────────────────────────────

/** 跑一条 gh; 非零退出即 throw (fail-loud: 写操作/读拼装任一 gh 失败都要显性, 不静默半成品)。 */
function run(gh: GhRunner, args: string[], ctx: string): string {
  const r: GhResult = gh(args);
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

/** 评论里的裁决: 首行 `**ruling**: <text>` → text (取第一条命中)。 */
function parseRuling(comments: Array<{ body: string }>): string | undefined {
  for (const c of comments) {
    const mm = c.body.match(/^\*\*ruling\*\*:\s*(.*)$/m);
    if (mm) return mm[1]!.trim();
  }
  return undefined;
}

/** issue state + labels → 静态 status (open 票的 blocked 归一延后到全票集齐后 deriveStatus)。 */
function baseStatus(state: string, labels: string[]): TicketStatus {
  const closed = state.toUpperCase() === 'CLOSED';
  if (closed) return labels.includes(DELIVERED_LABEL) ? 'delivered' : 'ruled';
  return 'open';
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
        number title body state
        labels(first:20){ nodes{ name } }
        comments(first:50){ nodes{ body } }
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
  comments: { nodes: Array<{ body: string }> };
  subIssues: { nodes: Array<{ number: number }> };
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

// ── 后端工厂 (构造即探测 repo, fail-loud) ───────────────────────────────────────

/**
 * 构造 gh 后端: 先探 `gh repo view --json nameWithOwner` (一次覆盖 gh 装没装 / 认没认证 / 有没 remote
 * 三种失败, D-E fail-loud)。owner/repo 缓存进闭包供后续 GraphQL 用。探测失败 → throw 带修复命令。
 *
 * `nativeDeps` (缺省 false 保守): blockedBy 真相源二选一 (D-C.2, 每仓恰一真相, 无 fallback 交叉) ——
 *   false = legacy body 尾行; true = 原生 issue-dependencies (读 GraphQL 字段 / 写 REST POST)。
 */
export function createGhBackend(gh: GhRunner, nativeDeps = false): PathBackend {
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

    readMap: (_cwd, slug) => {
      const mapNumber = Number(bareNumber(slug));
      if (!Number.isFinite(mapNumber)) return null;
      const issue = fetchMap(mapNumber);
      if (!issue) return null;
      const destination = issue.title.startsWith(MAP_TITLE_PREFIX) ? issue.title.slice(MAP_TITLE_PREFIX.length) : issue.title;

      // 一遍: 把 sub-issue 拼成静态 Ticket (open 的 blocked 归一在第二遍)。
      const tickets: Ticket[] = issue.subIssues.nodes.map((sub) => {
        const labels = sub.labels.nodes.map((l) => l.name);
        const { type, title } = parseTicketTitle(sub.title, labels);
        const body = sub.body ?? '';
        const status = baseStatus(sub.state, labels);
        const ruling = status === 'ruled' || status === 'delivered' ? parseRuling(sub.comments.nodes) : undefined;
        const children = sub.subIssues.nodes.map((c) => `#${c.number}`);
        // blockedBy 单真相 (D-C.2): native 读原生依赖字段, legacy 读 body 尾行, 二选一不混用。
        const blockedBy = nativeDeps ? (sub.blockedBy?.nodes ?? []).map((n) => `#${n.number}`) : parseBlockedBy(body);
        return {
          id: `#${sub.number}`,
          type,
          title,
          blockedBy,
          status,
          ...(ruling !== undefined ? { ruling } : {}),
          ...(children.length > 0 ? { children } : {}),
        };
      });

      // 二遍: open 票据 blockedBy 是否全裁归一 open/blocked (frontier.deriveStatus 纯函数复用)。
      const ruledSet = new Set(tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
      for (const t of tickets) {
        if (t.status === 'open') t.status = deriveStatus(t, ruledSet);
      }

      const decisionsLog = tickets
        .filter((t) => t.ruling !== undefined)
        .map((t) => ({ ticketId: t.id, gist: t.ruling!.slice(0, 80) }));
      return { destination, slug: String(mapNumber), tickets, decisionsLog };
    },

    createMap: (_cwd, destination) => {
      const body = `Destination: ${destination}\n\n## Fog\n\n## Decisions so far\n`;
      const out = run(gh, ['issue', 'create', '--title', `${MAP_TITLE_PREFIX}${destination}`, '--label', MAP_LABEL, '--body', body], 'createMap');
      const number = parseCreatedNumber(out, 'createMap');
      return { destination, slug: String(number), tickets: [], decisionsLog: [] };
    },

    addTicket: (_cwd, slug, nt) => {
      const bodyLines: string[] = [];
      if (nt.body) bodyLines.push(nt.body);
      // legacy 策略: blockedBy 落 body 尾行 (单真相)。native 策略: body 绝不写尾行, 前置边走原生 REST (见下)。
      if (!nativeDeps && nt.blockedBy.length > 0) bodyLines.push(`Blocked-by: ${nt.blockedBy.join(', ')}`);
      const body = bodyLines.join('\n\n');
      const out = run(
        gh,
        ['issue', 'create', '--title', `[${nt.type}] ${nt.title}`, '--label', `path:${nt.type}`, '--body', body],
        'addTicket',
      );
      const number = parseCreatedNumber(out, 'addTicket');

      // sub-issue 挂接 (归属血缘, D-G): parentId 给则挂母票, 否则挂地图。
      const parentNumber = bareNumber(nt.parentId ?? slug);
      const parentId = nodeId(gh, parentNumber, 'addTicket:parentNode');
      const childId = nodeId(gh, String(number), 'addTicket:childNode');
      run(
        gh,
        ['api', 'graphql', '-H', SUB_ISSUE_HEADER, '-f', `query=${ADD_SUB_ISSUE_MUTATION}`, '-f', `parentId=${parentId}`, '-f', `childId=${childId}`],
        'addTicket:addSubIssue',
      );

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

    rule: (_cwd, _slug, ticketId, ruling) => {
      const n = bareNumber(ticketId);
      run(gh, ['issue', 'comment', n, '--body', `**ruling**: ${ruling}`], 'rule:comment');
      run(gh, ['issue', 'close', n], 'rule:close');
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
  };
}
