/**
 * scripts/omd-seats —— **把座位登记表渲染成人看的那份** (`bun run scripts/omd-seats.ts`)。
 *
 * 真源是 `src/model/seats.ts`;这里只负责渲染 + 把「规格」与「这台机器上实际解析到什么」
 * 并排放。**不要在这里加任何座位知识** —— 加了就又是一份会漂的表。
 *
 * 用法:
 *   bun run scripts/omd-seats.ts          # 规格 + 当前解析 (默认)
 *   bun run scripts/omd-seats.ts --md     # markdown 表格 (贴文档用)
 *   bun run scripts/omd-seats.ts --spec   # 只看规格 (不读 config, 不需要凭证)
 */
import { SEATS, type SeatSpec } from '../src/model/seats';

const CROSS_LABEL: Record<SeatSpec['crossFamily'], string> = {
  required: '必须异族',
  preferred: '异族更好',
  no: '无关',
};

function samplingLabel(s: SeatSpec): string {
  const bits = [
    s.sampling.temperature !== undefined ? `temp ${s.sampling.temperature}` : '',
    s.sampling.topP !== undefined ? `topP ${s.sampling.topP}` : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : '(不发, 用 provider 默认)';
}

/** 当前解析 (读 .omd/config.json + env)。失败 → 全 '—' (规格视图仍可看)。 */
function liveResolution(): Map<string, { coord: string; source: string; thinking: string }> {
  const out = new Map<string, { coord: string; source: string; thinking: string }>();
  try {
    // 动态 import: `--spec` 档不该因为没配凭证/没有 config 就跑不起来。
    const rm = require('../src/model/role-models') as typeof import('../src/model/role-models');
    for (const s of SEATS) {
      const r = rm.tryResolveSeatModel(s.id as never);
      out.set(s.id, {
        coord: r?.model ?? '(未配)',
        source: r?.source ?? '—',
        thinking: (r?.model ? rm.resolveSeatThinking(r.model) : undefined) ?? '(默认)',
      });
    }
  } catch {
    /* 规格视图不依赖它 */
  }
  return out;
}

function renderMarkdown(live: ReturnType<typeof liveResolution>, withLive: boolean): string {
  const head = withLive
    ? '| 座位 | 档 | 干什么 | 频率 | 跨族 | effort | 采样 | 当前坐标 | 当前档 |'
    : '| 座位 | 档 | 干什么 | 频率 | 跨族 | effort | 采样 | 建议 |';
  const sep = `|${'---|'.repeat(withLive ? 9 : 8)}`;
  const rows = SEATS.map((s) => {
    const l = live.get(s.id);
    const base = [
      `\`${s.id}\``,
      s.tier,
      s.what.replace(/\n/g, ' '),
      s.frequency,
      CROSS_LABEL[s.crossFamily],
      s.thinking,
      samplingLabel(s),
    ];
    return `| ${[...base, withLive ? `\`${l?.coord ?? '—'}\`` : s.recommend, ...(withLive ? [l?.thinking ?? '—'] : [])].join(' | ')} |`;
  });
  return [head, sep, ...rows].join('\n');
}

function renderText(live: ReturnType<typeof liveResolution>): string {
  const lines: string[] = [
    'omd 座位登记表 —— 真源: src/model/seats.ts',
    '',
    '三层旋钮各管各的:  意图(seats.ts) → 能力(model-caps.ts) → 调和(pi-transport)',
    '  改角色 / 改 effort / 改采样 → seats.ts',
    '  某个模型收不收得下某个旋钮 → model-caps.ts',
    '',
  ];
  for (const s of SEATS) {
    const l = live.get(s.id);
    lines.push(`━━ ${s.id}  [${s.tier}]`);
    lines.push(`   干什么   ${s.what.replace(/\n/g, ' ')}`);
    lines.push(`   频率     ${s.frequency}`);
    lines.push(`   跨族     ${CROSS_LABEL[s.crossFamily]}`);
    lines.push(`   effort   ${s.thinking}   采样 ${samplingLabel(s)}`);
    lines.push(`   建议     ${s.recommend}`);
    lines.push(`   消费点   ${s.where.join('\n            ')}`);
    if (l) lines.push(`   ▸ 当前   ${l.coord}  [${l.source}]  档=${l.thinking}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function runOmdSeats(argv: readonly string[], out: (s: string) => void = console.log): void {
  const specOnly = argv.includes('--spec');
  const md = argv.includes('--md');
  const live = specOnly ? new Map() : liveResolution();
  out(md ? renderMarkdown(live, !specOnly) : renderText(live));
}

if (import.meta.main) runOmdSeats(process.argv.slice(2));
