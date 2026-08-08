/**
 * src/tui/components/path-hud —— **pathfinder 进 HUD**(goal §4 S13,A4)。
 *
 * ## 三种状态,三种画法(断链说明卡)
 *
 * - **一张图都没有** → `render()` 返回 `[]`(**无源恒缺席**)。
 *   画一个"前沿 0 / 阻塞 0"的空框会读成"有图但没票",而实际上是根本没开过图。
 * - **有图但前沿为空** → 画 `0`,并说清是**为什么**空(全裁决完了 / 全被阻塞)。
 *   这是**灰常量即真值**:0 是这一格的真答案,不是缺数据。
 * - **有图有票** → 照实画。
 *
 * ⚠ 这三者的区别就是 goal §4 S13 那条 verify 的全部内容(「地图为空时走断链说明卡不是假数据」)。
 *
 * ## 数据从盘上读,不从工具调
 *
 * `map_tickets` 那个 MCP 工具是**给 conductor 用的**(它要把票读进 prompt)。HUD 是给人看的,
 * 走同一批纯函数(`summarizeOpenMaps` / `loadMap` / `computeFrontier`)直接读盘 ——
 * 让 UI 去调一个工具意味着要么等一轮模型往返,要么在 UI 里复制一份工具调度。
 */
import type { Component } from '@earendil-works/pi-tui';
import { computeFrontier } from '../../harness/pathfinder/frontier';
import { loadMap, summarizeOpenMaps } from '../../harness/pathfinder/maps';
import { fitLine } from '../render/line';
import { renderBar } from '../render/bar';
import { BAR_MAX_COLS } from '../design/tokens';
import { renderTable } from '../render/table';
import type { OmdTuiTheme } from '../theme';

export interface PathSnapshot {
  destination: string;
  slug: string;
  /** 前沿票(可动的)。 */
  frontier: { id: string; type: string; title: string }[];
  /** 被别的票挡住的数量。 */
  blocked: number;
  /** 已裁决 / 总数 —— 散雾进度。 */
  ruled: number;
  total: number;
}

export type PathReader = () => PathSnapshot | null;

/**
 * 真读侧:扫 `docs/plan/pathfinder/*.md`,取**前沿票最多**的那张图。
 *
 * ⚠ 为什么是"前沿最多"而不是"第一张":按 slug 排序的第一张很可能是一张早就散完雾的老图,
 * 那样 HUD 会长期显示一张与当下无关的地图 —— 一个看起来在工作、其实指着别处的仪表盘。
 *
 * @param slug 切片⑧:显式选一张图(Ctrl+P 切图)。给了就读它;读不到 → null(缺席不是错误)。
 */
export function createPathReader(cwd: string, slug?: string): PathReader {
  return () => {
    const maps = summarizeOpenMaps(cwd);
    if (maps.length === 0) return null; // 一张图都没有 → 恒缺席
    const pick = slug ? maps.find((m) => m.slug === slug) : maps.reduce((a, b) => (b.frontierCount > a.frontierCount ? b : a));
    if (!pick) return null;
    const map = loadMap(cwd, pick.slug);
    if (!map) return null;
    const frontier = computeFrontier(map);
    const ruled = map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').length;
    return {
      destination: map.destination,
      slug: map.slug || pick.slug,
      frontier: frontier.map((t) => ({ id: t.id, type: t.type, title: t.title })),
      blocked: map.tickets.filter(
        (t) => t.status !== 'ruled' && t.status !== 'delivered' && t.status !== 'suggested' && t.blockedBy.length > 0,
      ).length,
      ruled,
      total: map.tickets.length,
    };
  };
}

const MAX_ROWS = 5;

export class PathHud implements Component {
  private snap: PathSnapshot | null = null;
  /** 上一次读盘失败的原因。`null` = 没失败过。**与 `snap === null` 是两件事**。 */
  private readError: string | null = null;

  constructor(
    private theme: OmdTuiTheme,
    private read: PathReader,
  ) {}

  /** 重读一次。**不在 render 里读盘** —— render 每帧都会被调,那会变成每帧一次目录扫描。 */
  refresh(): void {
    try {
      this.snap = this.read();
      this.readError = null;
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据: 原因留着画在屏上。
      this.snap = null;
      this.readError = err instanceof Error ? err.message : String(err);
    }
  }

  get active(): boolean {
    return this.snap !== null || this.readError !== null;
  }

  render(width: number): string[] {
    if (this.readError) {
      return [this.theme.chrome.warn(fitLine(`pathfinder 读不出来: ${this.readError}`, width))];
    }
    if (!this.snap) return []; // 无源恒缺席
    const s = this.snap;
    const out = [
      this.theme.chrome.accent(fitLine(`地图 ${s.destination}`, width)),
      // ⚠ 进度条**不占满全宽**(`BAR_MAX_COLS`)—— 见 token 那一条的理由:
      //   盲比两跑都把"110 列的条子只表达 8/23"指成我方最大的缺口。
      this.theme.chrome.dim(fitLine(renderBar(s.ruled, s.total, Math.min(width, BAR_MAX_COLS)), width)),
    ];
    if (s.frontier.length === 0) {
      // 灰常量即真值: 0 是这一格的真答案。但要说清**为什么**是 0。
      const why = s.blocked > 0 ? `全部 ${s.blocked} 张被前置票挡着` : '全部已裁决';
      out.push(this.theme.chrome.dim(fitLine(`前沿 0 (${why})`, width)));
      return out;
    }
    const shown = s.frontier.slice(0, MAX_ROWS);
    out.push(
      ...renderTable(
        [['前沿票', '类型', '待决'], ...shown.map((t) => [t.id, t.type, t.title])],
        width,
      ),
    );
    const rest = s.frontier.length - shown.length;
    if (rest > 0) out.push(this.theme.chrome.dim(fitLine(`... 另有 ${rest} 张前沿票`, width)));
    if (s.blocked > 0) out.push(this.theme.chrome.dim(fitLine(`阻塞集 ${s.blocked} 张`, width)));
    return out;
  }

  invalidate(): void {}
}
