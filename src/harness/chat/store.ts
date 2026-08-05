/**
 * src/harness/chat/store —— conductor chat 会话的持久化(`.omd/chat/<id>.json`)。
 *
 * leaf 的 session 是一次性弃置(agent-leaf.ts:每次调用现构造空 messages);chat conductor
 * 相反——对话跨轮跨 daemon 重启存活。持久单元 = 整个 `AgentMessage[]`(纯 JSON 数据,
 * 与 runAgentLoop 的输入输出同形,不经任何转换 —— 序列化面即运行面,零映射漂移)。
 *
 * 与 HudMirror 的**方向相反的铁律**:mirror 是观察者(fail-open,不许扰动被观察者);
 * 本 store 是**主存储**——save 失败 = 用户的对话丢了,必须响亮抛,不许吞。
 * fail-open 只用在 list() 跳过单个坏文件(一个坏文件不该杀掉整个会话列表),
 * 且按仓规「吞异常不吞证据」:跳过时把 path + 错误原文 WARN 出来。
 *
 * 脏场景处置(枚举于设计期):
 *  - 半截写入:tmp+rename 原子写 → 读侧永远见完整 JSON;残留 .tmp 下次 save 覆写。
 *  - 并发写同一会话:整文件 last-write-wins。单用户 daemon 串行化每个会话的轮次,显式接受。
 *  - id 来自 HTTP 边界:白名单正则闸,路径穿越直接拒(响亮)。
 *  - 会话变多:list() 全量读盘解析。单用户几十个会话规模显式接受;膨胀了再上索引。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { logger } from '../../logger';
import { dataPath } from '../project-scope';

const CHAT_DIR = '.omd/chat';
export const CHAT_SCHEMA = 1;

/** 文件名即 id → 必须过白名单(HTTP 边界进来的 id 不可信,`../` 直接拒)。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ChatSession {
  schema: typeof CHAT_SCHEMA;
  id: string;
  /** 列表页显示名。默认取首条 user 消息截断;可改。 */
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class ChatStore {
  /** @param repoRoot 项目根(= assemble 的 cwd,与 HudMirror/CheckpointManager 同源)。 */
  constructor(private readonly repoRoot: string) {}

  private dir(): string {
    return process.env.OMD_DATA_HOME?.trim() ? dataPath('chat') : join(this.repoRoot, CHAT_DIR);
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`[chat-store] 非法会话 id: ${JSON.stringify(id)}(白名单 ${ID_RE})`);
    return join(this.dir(), `${id}.json`);
  }

  /** 新会话(不落盘——首条消息 save 时才落,避免空会话垃圾)。 */
  create(id: string, title = ''): ChatSession {
    this.file(id); // id 闸提前踩(创建时就拒非法 id,别等 save)
    const now = new Date().toISOString();
    return { schema: CHAT_SCHEMA, id, title, createdAt: now, updatedAt: now, messages: [] };
  }

  /** 不存在 → null(缺席不是错误);存在但坏 → 响亮抛(对话数据损坏必须被看见,不许静默当新会话)。 */
  load(id: string): ChatSession | null {
    const f = this.file(id);
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as ChatSession;
    if (parsed.schema !== CHAT_SCHEMA || !Array.isArray(parsed.messages)) {
      throw new Error(`[chat-store] 会话文件形状不对: ${f}(schema=${String(parsed.schema)})`);
    }
    return parsed;
  }

  /** 原子写(tmp+rename)。失败**响亮抛**——主存储不 fail-open。 */
  save(session: ChatSession): void {
    const f = this.file(session.id);
    const dir = this.dir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }), 'utf-8');
    renameSync(tmp, f);
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }

  /** 按 updatedAt 降序。单个坏文件跳过但留证据(path + 错误原文),不杀整个列表。 */
  list(): ChatSessionMeta[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const metas: ChatSessionMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue; // .tmp 残留等一律不进列表
      try {
        const s = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ChatSession;
        if (s.schema !== CHAT_SCHEMA || !Array.isArray(s.messages)) throw new Error(`schema=${String(s.schema)}`);
        metas.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        });
      } catch (err) {
        logger.warn({ file: join(dir, name), err: String(err) }, '[chat-store] 跳过损坏会话文件 (证据在此, 文件未动)');
      }
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}
