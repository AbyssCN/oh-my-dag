/**
 * src/harness/chat/session-store —— 会话持久层:**pi 的 `Session` 族**,omd 只留一层薄的。
 *
 * 契约:`docs/plan/2026-08-09-session-层换成-pi-session-sdd.md`(片 A)。
 * 台账:`docs/bars/pi-agent-core-模块台账.md` §1.1(四笔欠账里的第一笔,也是另两笔的前置)。
 *
 * ## 借了什么、自己只写什么
 *
 * **借来的(一行都不重写)**:`JsonlSessionRepo`(create/open/list/delete/**fork**)·
 * `Session`(appendMessage/appendEntry/findEntriesOnBranch/lane 族)· `JsonlSessionStorage`
 * 的 append-only JSONL 与 seq 校验 · `buildSessionContext`(条目 → 对话视图的投影)·
 * **fs 直接用 `NodeExecutionEnv`** —— `JsonlSessionRepoFileSystem` 是
 * `Pick<FileSystem, 11 个方法>`,而它全都有(实测,见探针)。**omd 不写一行 fs 代码。**
 *
 * **自己写的只有两件**,而且都是 pi 没有、omd 又必须有的:
 * 1. **进程内单写者**(本文件的 `SESSIONS`):实测两个 `Session` 实例写同一份文件会写出
 *    重复 seq,而**下一次 `open()` 直接抛 `non-consecutive seq` —— 整份会话读不出来**
 *    (`ChatStore` 同场景只是 last-write-wins 丢一条)。同一份文件只留一个实例,
 *    写就落进 pi 的 `enqueue` 串行链(`storage.js:194`)。跨进程那一层在片 B。
 * 2. **id 白名单取交集**:pi 的 `SESSION_ID_PATTERN` 允许 `.`,omd 的 `ID_RE` 不允许。
 *    id 来自 HTTP 边界 ⇒ **语义不许放松**,先过 omd 这道再交给 pi。
 *
 * ## `AgentMessage[]` 不再是持久单元
 *
 * 它是**投影**:`messages()` = `buildSessionContext(entries).messages`。
 * 于是 `agent.ts` 里「改完数组再全量 `save(session)`」那件事**整块消失**,不是搬走 ——
 * 压缩落成一条 `compaction` 条目,投影自己会把它之前的东西截掉
 * (`pi-agent-core/dist/harness/session/context.js` 的 `defaultContextEntryTransform`)。
 */
import { join } from 'node:path';
import { uuidv7 } from '@earendil-works/pi-ai';
import { JsonlSessionRepo, buildSessionContext, createScanningSessionSearch, type AgentMessage, type Entry, type Session } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { dataPath } from '../project-scope';
import { acquireWriteLock, type LockDeps } from './session-lock';

/**
 * 在 compaction 落条**之前**由代码(不是模型)拼到 summary 末行的确定性指针。
 *
 * 格式逐字节钉死 —— 读者(以及 §1.2 的任何工具)用它**直接定位**被这条 compaction 遮蔽的
 * 原始消息,不必再回放整段对话。原文仍在 JSONL 里:append-only 的契约保证**不删**,
 * 走 `history_read` 按 seq 区间取。
 *
 * D-7:span = 分支路径上「前一条 compaction 之后(无则从根)到本次 compaction 之前」的
 * 全部**消息型**条目;shadowed = span 去掉末尾 `retainedTailLength` 条
 * (retainedTail 不带 entry id,只能按条数对位 —— 这是它唯一能给出的对齐键)。
 * count=0 时照拼:读者得看见「这次没遮蔽东西」。
 *
 * 只依赖条目序列 —— 禁时钟、禁随机、禁 LLM、禁网络。同一条 `branchEntries` 喂进去
 * 多少次都吐同一行,这是它能被快照测试锁住的前提。
 *
 * @param id 本次 compaction 的 entryId(由调用方先用 uuidv7 领出来,以便 footer 与
 *   落条时用的 id 是同一份)。
 */
export function buildCompactionFooter(opts: {
  id: string;
  branchEntries: readonly Entry[];
  retainedTailLength: number;
}): string {
  const { id, branchEntries, retainedTailLength } = opts;
  let previousCompactionIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]!.type === 'compaction') { previousCompactionIdx = i; break; }
  }
  const start = previousCompactionIdx === -1 ? 0 : previousCompactionIdx + 1;
  const span = branchEntries.slice(start).filter((e) => e.type === 'message');
  const shadowed = span.length > retainedTailLength
    ? span.slice(0, span.length - retainedTailLength)
    : [];
  const count = shadowed.length;
  const startSeq = count > 0 ? shadowed[0]!.seq : 0;
  const endSeq = count > 0 ? shadowed[shadowed.length - 1]!.seq : 0;
  return `\n[compaction ${id}: shadows ${count} msgs seq ${startSeq}-${endSeq}; originals via history_read]`;
}

const CHAT_DIR = '.omd/chat';

/**
 * omd 的会话 id 白名单 —— 与 `store.ts` 的 `ID_RE` **逐字相同**(有闸钉住)。
 *
 * ⚠ 不许直接用 pi 的 `SESSION_ID_PATTERN`:那一条允许 `.`,而这个 id 会变成文件名、
 * 且来自 HTTP 边界。**取交集 = 取更严的那个。**
 */
export const OMD_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 会话列表里一条的形状。
 *
 * ⚠ 片 E(2026-08-09)之前它住在 `store.ts` 里,随那份手搓存储层一起退役 ——
 * 类型跟着**消费者**走,而消费者(`/session` 列表、daemon 的 `GET /api/chat`)还在。
 */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ⚠ 新层的 `list()` **只读 header**(这是它比老 `ChatStore.list()` 便宜的全部原因),
   * 所以这一格恒为 `0` = **「没数过」**,不是「没有消息」(本仓 NULL ≠ 0 ≠ 不适用)。
   */
  messageCount: number;
  /** fork 来源会话 id。缺席 = 根会话(树的列表面靠它画 lineage)。 */
  parent?: string;
}

export interface OmdSession {
  readonly id: string;
  /**
   * 会话文件的**绝对路径**(JSONL)。给事务日志/锁这类 sidecar 用(见 `compaction-journal.ts`
   * 的 `${path}.compaction-journal`)。只读 —— 写仍必须走 `append` / `appendCompaction` /
   * `navigateTo` 三条过写锁的路。
   */
  readonly path: string;
  /** 投影出来的对话视图 —— **不是持久单元**。 */
  messages(): Promise<AgentMessage[]>;
  /** 追加一条消息(替掉 `push` + 全量 `save`)。 */
  append(m: AgentMessage): Promise<void>;
  /**
   * 压缩落成一条 `compaction` 条目。
   * 投影会从**最后一条** compaction 起截断,所以调用方不必再改数组。
   *
   * @param x.id 可选:compaction 条目 id。省略 = 本层现领一个。事务日志要**写前一步**
   * (write-ahead)时, 调用方先领好 id 写进日志、再传进来, 保证日志里的 entryId 与落条的是同一份。
   */
  appendCompaction(x: { summary: string; tokensBefore: number; retainedTail: AgentMessage[]; id?: string }): Promise<void>;
  /** 逐条读原始条目(compaction / custom 都在里面)—— §1.2 与 §1.3 要吃它。 */
  entries(): Promise<Awaited<ReturnType<Session['findEntriesOnBranch']>>>;
  /**
   * **整棵树**的条目(不只当前分支)—— `/tree` 要画分叉,只看当前分支画不出分叉。
   *
   * ⚠ 与 `entries()` 的差别是**真实的**:`entries()` 走 `findEntriesOnBranch`(从当前叶回溯
   * 到根的那一条路径),分支摘要之后被放弃的那一段**不在里面**,而它们仍在文件里。
   */
  allEntries(): Promise<Awaited<ReturnType<Session['findEntries']>>>;
  /** 当前分支的叶。`null` = 这条会话一条消息都还没有。 */
  leafId(): Promise<string | null>;
  /**
   * ★ pi 的 `Session` 本体 —— **只给那几个形参类型写死 `Session` 的 pi 函数当参数用**
   * (`collectEntriesForBranchSummary` 是其一;`Session` 有 private 字段 ⇒ 结构化窄接口
   * 传不进去,实测 tsc 会红)。
   *
   * ⚠ **不许拿它写**:写必须走本层的 `append` / `appendCompaction` / `navigateTo` ——
   * 只有那三条过 `ensureWritable`(跨进程写锁)。绕过去写不会报错,只会让另一个进程的
   * 那份 `Session` 状态与磁盘对不上 —— 而那是"整份会话读不出来"的来路(见文件头第 1 条)。
   */
  readonly tree: Session;
  /**
   * 导航到树上另一个条目(pi 式分支,台账 §1.3)。
   *
   * `branchSummary` 给了就在**移动之后**追加一条 `branch_summary` 条目 —— 顺序不能反:
   * `appendEntry` 的 `parentId` 取的是**当时**的 lane 指针(`jsonl/storage.js:112`),
   * 先追加就会把摘要挂在旧分支的尾巴上,而那正是它要交代的那条分支。
   *
   * ⚠ 残余风险写明白:`moveLane` 成功而 `appendEntry` 抛,会留下"分支已放弃但没有摘要"
   * 的中间态(pi 没有把两步合成一次写的口子)。条目一条都没丢 —— 用 `/tree` 挑回旧叶即可
   * 回到原处;摘要要不要补由人决定,这一层不静默重试。
   */
  navigateTo(
    targetId: string,
    branchSummary?: { summary: string; fromId: string; details: unknown },
  ): Promise<void>;
}

/** 全文搜索的一条命中(给 TUI 的最小面)。`snippet` 缺席 = 搜索件没给片段,不是空片段。 */
export interface SessionSearchHitLite {
  sessionId: string;
  entryId: string;
  snippet?: string;
}

export interface OmdSessionStore {
  list(): Promise<ChatSessionMeta[]>;
  /** 不存在返回 `null`(不是抛)—— 与 `ChatStore.load` 同语义。 */
  open(id: string): Promise<OmdSession | null>;
  /** 跨会话全文搜索(pi 的扫描式现成件,**只读**)。无命中 = 空表,不是错误。 */
  search(text: string): Promise<SessionSearchHitLite[]>;
  create(id: string, title?: string): Promise<OmdSession>;
  /** 经 `repo.fork` —— **不再手抄消息**,而且它会记 `parentSessionId`。 */
  fork(fromId: string, newId: string): Promise<OmdSession>;
  delete(id: string): Promise<void>;
}

/**
 * ★ **进程内单写者表**:绝对路径 → `Session`。
 *
 * 模块级(不是 store 实例级):同一个进程里两个 store 指到同一份文件也只有一个实例。
 * **反向自检**:把它去掉 → `session-store.test.ts` 的「并发两写两条都在」当场红。
 */
const SESSIONS = new Map<string, Session>();

/** 测试用:清掉单写者表(不同临时目录之间不许串)。生产里没有消费者。 */
export function resetSessionCacheForTest(): void {
  SESSIONS.clear();
}

function assertId(id: string): void {
  if (!OMD_SESSION_ID_RE.test(id)) {
    throw new Error(`[session-store] 非法会话 id: ${JSON.stringify(id)}(白名单 ${OMD_SESSION_ID_RE})`);
  }
}

/** 与 `ChatStore.dir()` 同一条判断:`OMD_DATA_HOME` 在就走它,否则仓内 `.omd/chat`。 */
/**
 * 会话文件根。
 *
 * ⚠ **导出是刻意的**(#212):它依赖 `OMD_DATA_HOME`,而这个 env 会**跨进程漂** ——
 * TUI 不 import `script-bootstrap`(该模块头注写明), 于是 TUI 的会话落 `<repo>/.omd/chat`;
 * 而任何 `scripts/*.ts` 一 import 就把 `OMD_DATA_HOME` 置成 `~/.omd`, 同一个 `repoRoot`
 * 算出来是**另一个目录**, `list()` 一条都找不到 —— 症状是"会话不存在", 不报错。
 * 所以派子进程去读会话时, 由**父进程**算好这个根、经 `OMD_CHAT_ROOT` 传下去。
 */
export function sessionsRootFor(repoRoot: string): string {
  const explicit = process.env.OMD_CHAT_ROOT?.trim();
  if (explicit) return explicit;
  return process.env.OMD_DATA_HOME?.trim() ? dataPath('chat') : join(repoRoot, CHAT_DIR);
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * @param lockDeps 跨进程写锁的依赖(pid / host / 探活 / 陈旧阈值)。
 *   生产里省略;测试注入 —— 「另一个进程持锁」在单进程里只能靠注入造出来。
 */
export function createOmdSessionStore(repoRoot: string, lockDeps?: LockDeps): OmdSessionStore {
  const fs = new NodeExecutionEnv({ cwd: repoRoot });
  const repo = new JsonlSessionRepo({ fs, sessionsRoot: sessionsRootFor(repoRoot) });
  // 全文搜索走 pi 的扫描式现成件。**只读不进单写者表**:它只扫文件,不产生第二个写者。
  const searcher = createScanningSessionSearch(repo);

  /** 同一份文件只许有一个 `Session` —— 见文件头第 1 条。 */
  const hold = (path: string, make: () => Promise<Session>): Promise<Session> => {
    const cached = SESSIONS.get(path);
    if (cached) return Promise.resolve(cached);
    return make().then((s) => {
      // ⚠ 双检:两个并发 open 会各自 make 一份, 后到的那份必须丢掉, 否则又是两个写者。
      const raced = SESSIONS.get(path);
      if (raced) return raced;
      SESSIONS.set(path, s);
      return s;
    });
  };

  const metaOf = async (id: string): Promise<{ path: string; meta: Awaited<ReturnType<typeof repo.list>>[number] } | null> => {
    const all = await repo.list({ cwd: repoRoot });
    const m = all.find((x) => x.id === id);
    return m ? { path: m.path, meta: m } : null;
  };

  /**
   * ⚠⚠ **`order: 'oldestFirst'` 不是可省的。**
   *
   * `findEntriesOnBranch` 默认从**叶往根**走(新的在前,`state.js:189` 那个 else 分支),
   * 而 `buildSessionContext` 的参数叫 `pathEntries` —— 它要的是**根→叶**。
   * 省掉这个选项的话:① 整个对话是**倒着的**;② `defaultContextEntryTransform` 会在
   * index 0 就撞见 compaction,于是"截断它之前的东西"变成"保留它之后的全部",
   * **压缩等于没生效**。两件都不会报错。**是片 A 的那条 compaction 闸把它红出来的。**
   */
  const branch = (s: Session): ReturnType<Session['findEntriesOnBranch']> => s.findEntriesOnBranch({ order: 'oldestFirst' });

  /**
   * ★ **写锁是懒抢的**:第一次写才抢,读(`list` / `messages`)永不上锁 ——
   * 看历史不该被另一个进程挡住(SDD 片 B 的取舍 1)。
   * 抢不到就**抛**,判词里带持有者 pid:静默降级成"只读"会让人以为消息发出去了。
   */
  const locks = new Map<string, () => void>();
  const ensureWritable = (path: string): void => {
    if (locks.has(path)) return;
    const got = lockDeps ? acquireWriteLock(path, lockDeps) : acquireWriteLock(path);
    if (!got.ok) throw new Error(`[session-store] 这份会话现在不能写:${got.why}`);
    locks.set(path, got.release);
  };

  /**
   * ⚠ **append 前必须 JSON round-trip 净化**(2026-08-09,S1 探针实测炸出):
   * pi 的 loop 造 toolResult 时**无条件**写 `details`/`usage` 两个键(`agent-loop.js:538`,
   * 工具没给就是 `undefined`),而 pi 自己的 storage 深检**拒绝任何 undefined 值**
   * (`session.js` 的 `assertJsonSerializable`)—— 两半互相矛盾,踩雷面 = 任何带工具调用的轮,
   * 症状 = `Durable payload contains undefined` 且 user+assistant 已入库(半轮)。
   * round-trip 丢 undefined 键 —— 持久的本来就只是 JSON 能表达的那部分,语义零损失。
   */
  const jsonSafe = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  const wrap = (id: string, s: Session, path: string): OmdSession => ({
    id,
    path,
    tree: s,
    entries: () => branch(s),
    // ⚠ **不带 `start`** —— `findEntries` 是全表, 这正是它与 `entries()` 的差别所在。
    //   `order` 仍要给:默认是叶往根(见下面 `branch` 那条注), 树画出来会上下颠倒。
    allEntries: () => s.findEntries({ order: 'oldestFirst' }),
    leafId: () => s.getLeafId(),
    async navigateTo(targetId, branchSummary) {
      ensureWritable(path);
      await s.moveLane('main', targetId);
      if (!branchSummary) return;
      await s.appendEntry(
        {
          type: 'branch_summary',
          id: uuidv7(),
          fromId: branchSummary.fromId,
          summary: branchSummary.summary,
          // details 来自工具调用抽出来的文件名 —— 与 append 同一条:undefined 键会被 pi 的
          // `assertJsonSerializable` 响亮拒(见下面 `jsonSafe` 那条注)。
          details: jsonSafe(branchSummary.details),
        },
        'main',
      );
    },
    async messages() {
      return buildSessionContext(await branch(s)).messages;
    },
    async append(m) {
      ensureWritable(path);
      await s.appendMessage(jsonSafe(m));
    },
    async appendCompaction(x) {
      ensureWritable(path);
      // `ProvisionedEntry` = Omit<Entry,'parentId'|'seq'|'timestamp'> ⇒ 只用给 id 与内容。
      // id 用 pi 自己的 `uuidv7`(**借,不手搓** —— 它就是 Session 默认 idGenerator 用的那个)。
      // 同一个 id 既写进 footer 也写进 entry —— 读者按 footer 里的 id 反查条目,**同一份**。
      // 调用方写前一步日志时先领好 id 传进来(同一份), 省略则这里现领。
      const id = x.id ?? uuidv7();
      // 必须在 appendEntry **之前**算 span:此刻 branch 的叶是「本次 compaction 之前」的那条,
      // append 完就多了一条 compaction,找「前一条 compaction」会落到自己头上(见 buildCompactionFooter)。
      const footer = buildCompactionFooter({ id, branchEntries: await branch(s), retainedTailLength: x.retainedTail.length });
      await s.appendEntry({
        type: 'compaction',
        id,
        // footer 拼在 summary 末行 —— 它是确定性指针,不是摘要本身;模型在拼 summary 时看不见它。
        summary: x.summary + footer,
        tokensBefore: x.tokensBefore,
        // retainedTail 是 AgentMessage[] —— toolResult 的 undefined 键问题同 append,一并净化。
        retainedTail: jsonSafe(x.retainedTail),
      // ⚠ `appendEntry(entry, lane)` 的 lane **不是可选的**(`session.d.ts:28`)——
      //   `appendMessage` 才默认 'main'。写死 'main':lane 的消费者在 §1.3,不在这一片。
      }, 'main');
    },
  });

  return {
    async list() {
      const all = await repo.list({ cwd: repoRoot });
      return all.map((m) => {
        const title = ((m.metadata as { title?: unknown } | undefined)?.title ?? '') as string;
        return {
          id: m.id,
          title: typeof title === 'string' ? title : '',
          createdAt: iso(m.createdAt),
          updatedAt: iso(m.modifiedAt),
          // ⚠ **不在这里数消息数**:`list` 只读 header 是它比 `ChatStore.list()` 便宜的全部原因,
          //   为了一个计数把每份文件读完就等于把这个优势退回去。0 = "没数过"不是"没有消息",
          //   要真数就单独一条读法(本仓 NULL ≠ 0)。
          messageCount: 0,
          ...(m.parentSessionId ? { parent: m.parentSessionId } : {}),
        } satisfies ChatSessionMeta;
      });
    },

    async search(text) {
      const hits = await searcher.search({ text, cwd: repoRoot });
      return hits.map((h) => ({
        sessionId: h.metadata.id,
        entryId: h.entryId,
        // snippet 缺席原样缺席 —— 不编空串占位 (NULL ≠ '' 的同一条)。
        ...(h.snippet !== undefined ? { snippet: h.snippet } : {}),
      }));
    },

    async open(id) {
      assertId(id);
      const found = await metaOf(id);
      if (!found) return null;
      const s = await hold(found.path, () => repo.open(found.meta));
      return wrap(id, s, found.path);
    },

    async create(id, title = '') {
      assertId(id);
      const s = await repo.create({ id, cwd: repoRoot, metadata: { title } });
      const meta = (await s.getMetadata()) as { path: string };
      SESSIONS.set(meta.path, s);
      return wrap(id, s, meta.path);
    },

    async fork(fromId, newId) {
      assertId(fromId);
      assertId(newId);
      const src = await metaOf(fromId);
      if (!src) throw new Error(`[session-store] 会话不存在: ${fromId}`);
      const s = await repo.fork(src.meta, { id: newId, cwd: repoRoot });
      const meta = (await s.getMetadata()) as { path: string };
      SESSIONS.set(meta.path, s);
      return wrap(newId, s, meta.path);
    },

    async delete(id) {
      assertId(id);
      const found = await metaOf(id);
      if (!found) return; // 与 ChatStore.delete 同语义:删不存在的不报错
      SESSIONS.delete(found.path);
      locks.get(found.path)?.();
      locks.delete(found.path);
      await repo.delete(found.meta);
    },
  };
}
