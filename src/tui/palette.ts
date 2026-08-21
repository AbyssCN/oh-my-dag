/**
 * src/tui/palette —— **`Ctrl+K` 去哪**(2026-08-22,视觉系统稿第 6 屏)。
 *
 * ## 它治的是「入口散在四个键上」
 *
 * 今天换会话要 `/session`、看活图要 `Ctrl+G`、看地图要 `Ctrl+P`,三条路三个记忆点,
 * 而**启动时一条 resume 入口都没有**(`sessions.ts:144` 的 `defaultTuiSessionId`
 * 让每个进程直接开新会话,从不问要不要接上次那个)。这里把它们并成一个统一选单:
 * 打字过滤,Enter 去。**空手起 TUI 时,`Ctrl+K` 再 `Enter` 就是「接上一条会话」。**
 *
 * ## 只列**真的去得成**的行
 *
 * 稿上还有一行「收件箱」,这里**没有** —— 收件箱那个屏还不存在(片 5),
 * 而一个点了没反应的入口正是本仓在杀的东西(`tui.ts` 的 `noRunCapability` 同款纪律)。
 * 「活图」也一样:只有本进程真的在跑图(`dagTree.active`)时才有那一行 ——
 * 别的进程的 run 要等 #215/#216 落地(每 run 一份磁盘镜像 + 快照加载)才画得出来。
 *
 * ## 纯函数,逻辑不留在 `tui.ts` 里
 *
 * 与 `sessions.ts` 的 `sessionPickerOptions` 同一条理由:选项构造要能单测。
 * `tui.ts` 那边只剩「取数 → 开框 → 按 target 跳」。
 *
 * ⚠ 硬约束(与 `sessions.ts:109` 同一条):pi-tui 的 `SelectList` **一个 item 只画一行**,
 * `description` 被压成单行放右列。所以下面全是一行式,不是两行卡片。
 */
import type { TuiSessionMeta } from './backend';
import { relTime } from './sessions';

/** 选中一行之后要去的地方。**解析出来的,不是字符串到处传** —— 拼错了 tsc 会说话。 */
export type PaletteTarget =
  | { kind: 'session'; id: string }
  | { kind: 'map'; slug: string }
  | { kind: 'run' };

export interface PaletteMap {
  slug: string;
  destination: string;
  frontierCount: number;
  openCount: number;
}

/** 本进程在跑的那张图。**没在跑就是 `null`** —— 不编一个 0 节点的行(无源恒缺席)。 */
export interface PaletteLiveRun {
  /** `DagTree.snapshot().runLabel`。缺席时调用方不该构造这个对象。 */
  label: string;
  nodes: number;
  running: number;
}

export interface PaletteInput {
  sessions: readonly TuiSessionMeta[];
  /** 当前会话 id —— 标 `*`,与 `formatSessions` / `sessionPickerOptions` 同一个记号。 */
  currentSession: string;
  maps: readonly PaletteMap[];
  liveRun: PaletteLiveRun | null;
  now: number;
}

export interface PaletteOption {
  value: string;
  label: string;
  description: string;
}

/**
 * `value` 的编码。第一个 `:` 之前是种类,之后整段是 id ——
 * 会话 id 过 `sessions.ts` 的 `ID_RE`(不含 `:`),map slug 是文件名,都不会把种类吃掉。
 */
const SESSION_PREFIX = 'session:';
const MAP_PREFIX = 'map:';
const RUN_VALUE = 'run:';

/**
 * 选单的行。**顺序照稿**:会话 → 活图 → 地图。
 *
 * 会话按最近使用倒序 —— 「Ctrl+K 再 Enter = 接上一条」靠的就是这个序,
 * 所以它是判据不是排版口味(`palette.test.ts` 有闸)。
 *
 * ⚠ `updatedAt === 0` 是「没记时间」不是「刚刚」(`relTime` 那条 NULL ≠ 0),
 * 排序里它沉底,画出来是 `—`。
 */
export function paletteOptions(input: PaletteInput): PaletteOption[] {
  const out: PaletteOption[] = [];
  const byRecency = [...input.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of byRecency) {
    out.push({
      value: `${SESSION_PREFIX}${s.id}`,
      label: `${s.id === input.currentSession ? '* ' : '  '}会话  ${s.title || '(no title)'}`,
      description: [s.id, relTime(s.updatedAt, input.now), ...(s.parent ? [`forked from ${s.parent}`] : [])].join(' · '),
    });
  }
  if (input.liveRun) {
    out.push({
      value: RUN_VALUE,
      label: `  活图  ${input.liveRun.label}`,
      // 「几个在跑」是 0 时照写 0 —— 这里 0 是**量到的真值**(图还在、节点都结了),
      // 与 NULL ≠ 0 不冲突:缺席的那一档在上面由 `liveRun === null` 整行不画。
      description: `${input.liveRun.nodes} 节点 · ${input.liveRun.running} 在跑`,
    });
  }
  for (const m of input.maps) {
    out.push({
      value: `${MAP_PREFIX}${m.slug}`,
      label: `  地图  ${m.destination || m.slug}`,
      description: `map ${m.slug} · 前沿 ${m.frontierCount} · 未结 ${m.openCount}`,
    });
  }
  return out;
}

/** `value` → 去处。认不出返回 `null`(调用方什么都不做,不猜一个)。 */
export function parsePaletteValue(value: string): PaletteTarget | null {
  if (value === RUN_VALUE) return { kind: 'run' };
  if (value.startsWith(SESSION_PREFIX)) {
    const id = value.slice(SESSION_PREFIX.length);
    return id ? { kind: 'session', id } : null;
  }
  if (value.startsWith(MAP_PREFIX)) {
    const slug = value.slice(MAP_PREFIX.length);
    return slug ? { kind: 'map', slug } : null;
  }
  return null;
}
