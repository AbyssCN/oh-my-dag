/**
 * src/tui/render/statusbar —— **底栏三行的渲染面**(切片②,v5 第一节样张 + 第四节算法)。
 *
 * 三行:① 工作区+座位+ctx+会话花费+5h 窗口 · ② in/out/cache + 各 provider 额度 + ssh · ③ 帮助。
 * 顶栏没了(v5:信息下沉 —— 眼睛在输入框附近,状态离输入框越近越容易被看见)。
 *
 * ## segment 模型(照 Oh My Posh 的分段思想,不抄实现)
 *
 * 每段自己决定显不显示:**没数据就不画**,不画 0、不画空占位。
 * powerline 箭头不搬(要 Nerd Font,字形闸判 unsafe);段间用 ` │ ` 分隔。
 *
 * ## 三条不许违反的(v5 原话)
 *
 * 1. **订阅与计费分开画** —— 订阅制不折算美元(折算是编的);
 * 2. **拿不到就写「未知」** —— 不画 0%,0% 会被读成"还没用";
 * 3. **本地估算要标注** —— 「本地 N+」与官方读数在屏上分得开。
 */
import type { ContextPressure } from '../../harness/chat/usage';
import { BORDER } from '../design/tokens';
import type { WindowSummary } from '../usage/ledger';
import { humanTokens } from './pressure';

/** 一个 provider 怎么画额度:订阅制画本地计数,按量制画窗口花费。 */
export type BillingMode = 'subscription' | 'token';

/**
 * 默认 billing 归类(v5 第四节那张表)。`.omd/config.json` 的 `declaredPlans` 可覆盖:
 * kind === 'token' → token,其余(request/session/flat)→ subscription。
 */
export const DEFAULT_BILLING: Readonly<Record<string, BillingMode>> = {
  'kimi-coding': 'subscription',
  'opencode-go': 'subscription',
  anthropic: 'subscription',
  deepseek: 'token',
  mimo: 'token',
  vllm: 'token',
};

export interface WorkspaceInfo {
  /** 仓名(目录名)。 */
  repo: string;
  /** 分支;detached 时给短 SHA。`null` = 不是 git 仓(段不画)。 */
  branch: string | null;
  /** 脏文件数(`git status --porcelain` 行数)。0 = 干净(不画 +N)。 */
  dirty: number;
  /** worktree 名;主工作树 = `null`(段不画)。 */
  worktree: string | null;
}

export interface StatusBarInput {
  ws: WorkspaceInfo | null;
  /** 座位坐标(`connection.url` 去掉协议头)。 */
  seat: string;
  pressure: ContextPressure | null;
  /** 本进程合计(「会话」格)。`null` = 还没跑过一轮(不画,不是 $0)。 */
  session: { costUsd: number; unpriced: boolean; calls: number } | null;
  /** 5h 滚动窗口。`null` 或 calls=0 = 窗口里没有记录(段不画)。 */
  win: WindowSummary | null;
}

const SEP = ` ${BORDER.v} `;

/** `$0.83` / `$12.4`;未计价的调用在场时 → `$…+`(后缀 + = 下界,不冒充真值;`≥` 是未量字形不能用)。 */
export function fmtUsd(costUsd: number, unpriced: boolean): string {
  const n = costUsd < 10 ? costUsd.toFixed(2) : costUsd.toFixed(1);
  return `$${n}${unpriced ? '+' : ''}`;
}

/** 行①:`oh-my-dag · main +2 · wt:fanin │ kimi-coding:k3 │ ctx 4.7k/1049k 0% │ 会话 $0.83 │ 5h $0.42` */
export function formatStatusLine(i: StatusBarInput): string {
  const segs: string[] = [];
  if (i.ws) {
    const parts = [i.ws.repo];
    if (i.ws.branch) parts.push(`${i.ws.branch}${i.ws.dirty > 0 ? ` +${i.ws.dirty}` : ''}`);
    if (i.ws.worktree) parts.push(`wt:${i.ws.worktree}`);
    segs.push(parts.join(' · '));
  }
  if (i.seat) segs.push(i.seat);
  if (i.pressure && i.pressure.usedTokens > 0) {
    const p = i.pressure;
    segs.push(
      p.ratio === null
        ? `ctx ${humanTokens(p.usedTokens)} 窗口未知`
        : `ctx ${humanTokens(p.usedTokens)}/${humanTokens(p.windowTokens)} ${Math.round(p.ratio * 100)}%`,
    );
  }
  if (i.session && i.session.calls > 0) segs.push(`会话 ${fmtUsd(i.session.costUsd, i.session.unpriced)}`);
  if (i.win && i.win.calls > 0) segs.push(`5h ${fmtUsd(i.win.costUsd, i.win.unpriced)} · ${i.win.calls} 次`);
  return segs.join(SEP);
}

/**
 * 行②:`in 312k out 18.4k cache 276k 88% │ kimi-coding 本地3+ 额度未知 · deepseek $1.20 │ ssh ms02 · tmux`
 *
 * `null` = 窗口里一条记录都没有 → 返回空串,这一行**不占位**(与"跑了但全是 0"分得开:
 * 后者 calls > 0,照画)。
 */
export function formatUsageLine(
  win: WindowSummary | null,
  o: { billing?: Readonly<Record<string, BillingMode>>; ssh?: string | null; tmux?: boolean } = {},
): string {
  if (!win || win.calls === 0) return '';
  const billing = o.billing ?? DEFAULT_BILLING;
  const segs: string[] = [];
  const cachePct = win.in > 0 && win.cacheHit > 0 ? ` ${Math.round((win.cacheHit / win.in) * 100)}%` : '';
  segs.push(`in ${humanTokens(win.in)} out ${humanTokens(win.out)}${win.cacheHit > 0 ? ` cache ${humanTokens(win.cacheHit)}${cachePct}` : ''}`);
  if (win.byProvider.length > 0) {
    segs.push(
      win.byProvider
        .map((p) => {
          const mode = billing[p.provider] ?? 'token';
          // 订阅制: 本地计数是下界(别的客户端烧的看不见), 额度没有官方端点 → 未知。
          if (mode === 'subscription') return `${p.provider} 本地${p.calls}+ 额度未知`;
          return `${p.provider} ${fmtUsd(p.costUsd, p.unpriced)}`;
        })
        .join(' · '),
    );
  }
  const tail = [o.ssh ? `ssh ${o.ssh}` : null, o.tmux ? 'tmux' : null].filter(Boolean);
  if (tail.length > 0) segs.push(tail.join(' · '));
  return segs.join(SEP);
}
