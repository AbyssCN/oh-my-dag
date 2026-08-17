/**
 * scripts/probes/tui-frame-dump —— **抓真实可见帧**(2026-08-17,owner:「打开真实 UI 对照完善」)。
 *
 * 与 tui-pty-check 的分工:那边的 oracle 是**累积字节流**(判"出现过"),这边用
 * `@xterm/headless` 重建**屏幕现状**(判"现在长什么样、摆在哪") —— 布局/留白/密度
 * 只有帧看得出。产物写 /tmp/tui-frames/*.txt,人(或我)逐帧读。
 *
 * 用法:node scripts/probes/tui-frame-dump.mjs [--color]
 *   默认 NO_COLOR(判布局);--color 保留 SGR(判配色,帧文件里是裸转义)。
 */
import { spawn as spawnNodePty } from '@lydell/node-pty';
import xterm from '@xterm/headless';
const { Terminal } = xterm;
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUN = process.env.BUN_BIN ?? 'bun';
const COLS = 120;
const ROWS = 36;
const OUT = '/tmp/tui-frames';
const COLOR = process.argv.includes('--color');

// 自带一张票图 (tui-pty-check 的 seedTicketMap 同款做法, 不吃真仓状态)。
const cwd = mkdtempSync(join(tmpdir(), 'omd-frame-'));
{
  const store = JSON.stringify(join(ROOT, 'src/harness/pathfinder/map-store.ts'));
  const map = JSON.stringify({
    destination: '引擎墙钟与 leaf 档位: 让编排既准又快',
    slug: 'frame-fixture',
    decisionsLog: [],
    tickets: [
      { id: 'r1', type: 'research', title: '实测并发只到 ~4 而配置允许 16: 差距未解释, 要先量过再定', blockedBy: [], status: 'open' },
      { id: 't1', type: 'task', title: 'fan-out 依赖接到单个分片的形状要改', blockedBy: [], status: 'open' },
      { id: 'g2', type: 'grill', title: '串行审计尾巴过重: 并行段之后还有 5 段串行', blockedBy: ['r1'], status: 'open' },
      { id: 'g1', type: 'grill', title: 'leaf 档位判据', blockedBy: [], status: 'ruled' },
    ],
  });
  execFileSync(BUN, ['-e', `const m = await import(${store}); m.saveMap(${map}, ${JSON.stringify(cwd)});`], { stdio: 'pipe' });
}

mkdirSync(OUT, { recursive: true });
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
let buf = '';
const pty = spawnNodePty(BUN, ['run', join(ROOT, 'src/harness/cli.ts'), 'tui'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    ...(COLOR ? { COLORTERM: 'truecolor' } : { NO_COLOR: '1' }),
    OMD_INSTALL_SKILLS: '0',
    OMD_TUI_BACKEND: 'fixture',
    OMD_TUI_USAGE_DIR: mkdtempSync(join(tmpdir(), 'omd-frame-usage-')),
  },
});
pty.onData((d) => {
  buf += d;
  term.write(d);
});

const flush = () => new Promise((r) => term.write('', r));
const waitFor = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(buf)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
};
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function snap(name) {
  await settle();
  await flush();
  const b = term.buffer.active;
  const lines = [];
  for (let y = 0; y < ROWS; y++) {
    lines.push((b.getLine(b.viewportY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
  }
  const ruler = `${'0123456789'.repeat(Math.ceil(COLS / 10)).slice(0, COLS)}`;
  writeFileSync(join(OUT, `${name}.txt`), [`# ${name} · ${COLS}x${ROWS} · viewportY=${b.viewportY}`, ruler, ...lines].join('\n'));
  console.log(`frame: ${name} (viewportY=${b.viewportY})`);
}

try {
  if (!(await waitFor((t) => t.includes('engine')))) throw new Error('boot 超时');
  await snap('01-welcome');
  pty.write('给我三行关于这个仓的介绍\r');
  await waitFor((t) => t.includes('fixture'), 20000);
  await snap('02-after-turn');
  pty.write('fixture:dag\r');
  await waitFor((t) => t.includes('└─') || t.includes('fixture-fanout'), 20000);
  await snap('03-dag-sidebar');
  pty.write('\x07'); // Ctrl+G 全屏
  await snap('04-dag-full');
  pty.write('\x07');
  await snap('05-back-from-full');
  pty.write('/help\r');
  await snap('06-help');
} finally {
  try {
    pty.kill();
  } catch {}
}
console.log(`done -> ${OUT}`);
process.exit(0);
