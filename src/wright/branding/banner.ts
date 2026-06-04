/**
 * identity/banner —— Xihe 启动 banner (setHeader 注入, 替换 pi 内置 logo header)。
 *
 * 像 hermes-agent 那样: figlet 字标 + 羲和日轮徽记 + 版本/后端行 + 工作流教程 + 指令速查 + 底部提示。
 * 配色走 [[palette]] (朱砂金太阳, gold→cinnabar 日出渐变)。
 *
 * 分两件: ① renderXiheBanner(opts) 纯函数返 string[] (含 ANSI, 可单测)
 *         ② createBannerExtension(opts) 经 pi ui.setHeader 把 banner 作启动 header。
 * header 工厂只拿 (tui, theme) → 后端/版本在扩展创建时由 tui.ts 注入 (静态启动 banner 够用)。
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { bold, dim, fg } from './palette';

/** XIHE 字标 (ANSI Shadow), 6 行。每行配一个渐变色 (顶金 → 底朱砂, 日出)。 */
const FIGLET: readonly string[] = [
  '██╗  ██╗██╗██╗  ██╗███████╗',
  '╚██╗██╔╝██║██║  ██║██╔════╝',
  ' ╚███╔╝ ██║███████║█████╗  ',
  ' ██╔██╗ ██║██╔══██║██╔══╝  ',
  '██╔╝ ██╗██║██║  ██║███████╗',
  '╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚══════╝',
];
/** 渐变 (top→bottom = 日轮升起: 金顶 → 朱砂底)。 */
const FIGLET_GRADIENT: readonly string[] = [
  'goldBright',
  'gold',
  'gold',
  'cinnabarBright',
  'cinnabar',
  'cinnabar',
];

export interface BannerInfo {
  /** xihe 版本 (package.json)。 */
  version?: string;
  /** 当前后端 provider (deepseek/mimo/…)。 */
  provider?: string;
  /** 当前 model id。 */
  model?: string;
  /** thinking 档。 */
  thinking?: string;
  /** web 工具是否启用 (有无 search key)。 */
  webEnabled?: boolean;
}

/** 指令速查分组 (label + 每条 {cmd, desc})。驱动渲染, 改命令只改这里。 */
const COMMAND_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<[string, string]> }> = [
  {
    label: '规划',
    items: [
      ['shift+tab', '进/出只读审议座舱'],
      ['/council', '多视角生成择优'],
      ['/grill', '对抗式逼问锁契约'],
      ['/sdd', '落 SDD+TDD 骨架'],
    ],
  },
  {
    label: '知识',
    items: [
      ['/ref <url>', '摄取链接 (抓取+蒸馏)'],
      ['/search', '元搜索更多来源'],
      ['/crystallize', '结晶当前审议'],
      ['/crystals', '跨 session 召回结晶'],
    ],
  },
  {
    label: '执行',
    items: [
      ['/cg', '代码检索 grounding'],
      ['/audit', '安全/质量审计'],
      ['/iterate', '迭代到收敛'],
      ['/cost', '花费 / 预算闸'],
    ],
  },
  {
    label: '记忆',
    items: [
      ['/recall', '召回历史决策'],
      ['/config', '角色模型选型'],
      ['/mcp', 'MCP 工具路由'],
      ['/code', '多工具编排省 token'],
    ],
  },
];

/** 工作流一句话教程 (基础闭环)。 */
const WORKFLOW = 'shift+tab 进 plan → 把方案讨论透 → /sdd 落骨架 → 退出执行 → /cg·/audit 复查';

function divider(width: number): string {
  const n = Math.max(24, Math.min(width - 1, 64));
  return fg('border', '─'.repeat(n));
}

/**
 * 渲染 Xihe banner → 行数组 (含 ANSI 真彩)。width 用于横线宽度自适应。
 */
export function renderXiheBanner(info: BannerInfo = {}, width = 64): string[] {
  const lines: string[] = [];
  // 日轮徽记 + 双语字标行
  lines.push(`  ${fg('gold', '╴─╴')} ${fg('cinnabarBright', '◉')} ${fg('gold', '╴─╴')}    ${bold(fg('goldBright', '羲和'))} ${fg('riceDim', '·')} ${bold(fg('cinnabar', 'XIHE'))}`);
  lines.push('');
  // figlet (日出渐变)
  FIGLET.forEach((row, i) => lines.push(` ${fg(FIGLET_GRADIENT[i] ?? 'gold', row)}`));
  lines.push('');
  // tagline
  lines.push(` ${fg('riceMuted', 'model-agnostic agent runtime')} ${fg('riceDim', '· 1-dev harness 的杠杆')}`);
  // 版本 / 后端
  const ver = info.version ? `xihe v${info.version}` : 'xihe';
  const backend = info.provider && info.model ? `${info.provider}:${info.model}` : info.provider ?? '未配置后端';
  const meta = [
    fg('gold', ver),
    fg('jade', backend),
    info.thinking ? fg('riceMuted', `thinking=${info.thinking}`) : '',
    info.webEnabled === false ? fg('riceDim', 'web off') : info.webEnabled ? fg('riceDim', 'web on') : '',
  ].filter(Boolean);
  lines.push(` ${meta.join(fg('riceDim', '  ·  '))}`);
  lines.push('');
  // 工作流教程
  lines.push(divider(width));
  lines.push(` ${bold(fg('cinnabarBright', '工作流'))}  ${fg('rice', WORKFLOW)}`);
  lines.push(divider(width));
  // 指令速查 (每组一行: 金标签 + 朱砂命令 + 米描述)
  for (const g of COMMAND_GROUPS) {
    const cmds = g.items
      .map(([cmd, desc]) => `${fg('cinnabar', cmd)} ${fg('riceDim', desc)}`)
      .join(fg('border', '  ·  '));
    lines.push(` ${bold(fg('gold', g.label))}  ${cmds}`);
  }
  lines.push(divider(width));
  // 底部提示
  lines.push(` ${dim(fg('riceMuted', 'ctrl+o 展开 · / 命令 · ! bash · shift+tab 切 plan · /theme 主题'))}`);
  return lines;
}

/**
 * 把 Xihe banner 作启动 header 注入 pi。boot 时 tui.ts 传入版本/后端 (静态)。
 * setHeader 在 ctx.ui (非 pi 顶层) → 经 session_start 事件 ctx 注入 (banner 启动即显)。
 */
export function createBannerExtension(info: BannerInfo = {}): ExtensionFactory {
  return (pi) => {
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.setHeader(() => {
        let cached: { width: number; lines: string[] } | null = null;
        return {
          render(width: number): string[] {
            if (!cached || cached.width !== width) {
              cached = { width, lines: renderXiheBanner(info, width) };
            }
            return cached.lines;
          },
          invalidate(): void {
            cached = null;
          },
        };
      });
    });
  };
}
