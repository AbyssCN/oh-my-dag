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
import { JsonlSessionRepo, buildSessionContext, type AgentMessage, type Session } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { dataPath } from '../project-scope';
import { acquireWriteLock, type LockDeps } from './session-lock';

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
  /** 投影出来的对话视图 —— **不是持久单元**。 */
  messages(): Promise<AgentMessage[]>;
  /** 追加一条消息(替掉 `push` + 全量 `save`)。 */
  append(m: AgentMessage): Promise<void>;
  /**
   * 压缩落成一条 `compaction` 条目。
   * 投影会从**最后一条** compaction 起截断,所以调用方不必再改数组。
   */
  appendCompaction(x: { summary: string; tokensBefore: number; retainedTail: AgentMessage[] }): Promise<void>;
  /** 逐条读原始条目(compaction / custom 都在里面)—— §1.2 与 §1.3 要吃它。 */
  entries(): Promise<Awaited<ReturnType<Session['findEntriesOnBranch']>>>;
}

export interface OmdSessionStore {
  list(): Promise<ChatSessionMeta[]>;
  /** 不存在返回 `null`(不是抛)—— 与 `ChatStore.load` 同语义。 */
  open(id: string): Promise<OmdSession | null>;
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
function sessionsRootFor(repoRoot: string): string {
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
    entries: () => branch(s),
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
      await s.appendEntry({
        type: 'compaction',
        id: uuidv7(),
        summary: x.summary,
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
