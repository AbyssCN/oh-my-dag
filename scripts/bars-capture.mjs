/**
 * scripts/bars-capture —— **参照帧采集器**(gauntlet 重建 plan P0)。
 *
 * ## 它是证据,不是闸
 *
 * `scripts/tui-pty-check.mjs` 文件头记着本仓既有裁决:**永不做 ANSI 快照**,
 * 因为快照会因任何布局微调全红,等于没有测试。**那条规矩管的是闸,不管证据。**
 * 本脚本采下来的帧是给 gauntlet 的 critic **看**的,
 * **不许**被改造成 CI 回归闸 —— 谁把它变成闸,谁就装了一条永远红的假闸。
 *
 * ## 为什么又是 `.mjs` 跑在 node 上
 *
 * 同 `tui-pty-check.mjs` 的实测结论:`@lydell/node-pty` 在 **bun 宿主**下一个字节都不回,
 * 必须由 **node** 托管。别"顺手"改成 bun。
 *
 * ## 采集纪律
 *
 * - **同一把尺子**:竞品与我方走同一条采集路径、同一张场景清单、同样的 cols×rows。
 *   两边尺子不一样,后面所有对比作废(本仓 detector「60% 天花板」那条的教训)。
 * - **采不到就写采不到**:失败的场景写进 `_MISSING.md` 并记原因,
 *   **不许用文字描述代替帧**。
 * - **沙箱 HOME**:竞品 CLI 一律在 `--home` 指定的临时 HOME 下跑,
 *   不读不写 Nick 的真配置与凭证;环境里剥掉所有 `*_API_KEY`。
 *
 * 用法:
 *   node scripts/bars-capture.mjs                 # 采全部家族
 *   node scripts/bars-capture.mjs --family pi     # 只采一家
 *   node scripts/bars-capture.mjs --list          # 列场景清单
 */
import { spawn } from '@lydell/node-pty';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'docs/bars/refs');
const CLI_DIR = '/tmp/bars/cli/node_modules/.bin';
const FAKE_HOME = '/tmp/bars/fakehome';

/** 剥 OSC / CSI / SS3 / 单控制码 → 折叠空白。与 tui-pty-check.mjs 逐字同源。 */
export function visibleText(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[()][A-B0-2]|[=>]|O.|.)?/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把原始字节流**重放进一个真的终端网格**再读回来。
 *
 * ⚠ 这一步不是可有可无的加工。实测(2026-08-08):opencode 靠**光标定位**
 * (`CSI row;colH`)绘屏,整条流里**一个换行都没有** —— 按换行切会把整屏收成 1 行,
 * 于是"非空行 1"看起来像采集失败,其实内容全在。
 * 没有网格就数不了**对齐列数 / 溢出字符数**,而那正是 critic 必须给出的那种数。
 *
 * 反测(已做):`\x1b[2J\x1b[HAB\x1b[3;10HXY` → 第 3 行第 10 列出现 `XY`。
 */
async function replayToGrid(raw, cols, rows) {
  // @xterm/headless 是 CJS:ESM `import()` 下 `Terminal` 挂在 `.default` 上,
  // 直接解构会拿到 undefined。两处都取一次,谁在用谁。
  const mod = await import('@xterm/headless');
  const Terminal = mod.Terminal ?? mod.default?.Terminal;
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  await new Promise((res) => term.write(raw, res));
  const buf = term.buffer.active;
  const out = [];
  // 从 viewport 顶端读一屏 —— 竞品与我方同样读法, 同一把尺子。
  const top = buf.baseY;
  for (let y = top; y < top + rows; y++) {
    const line = buf.getLine(y);
    out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  term.dispose();
  return out.join('\n');
}

const WIDE = { cols: 110, rows: 32 };
const NARROW = { cols: 80, rows: 24 };

/**
 * 场景清单 —— **每一家都跑同一张表**。
 * `keys` 里的 `at` 是相对启动的毫秒数;`grab` 是抓帧时刻。
 */
function scenarios(bin, extra = {}) {
  const base = { bin, ...extra };
  return [
    { ...base, id: '01-empty', desc: '空态(启动首屏)', args: [], grab: 6000, ...WIDE },
    {
      ...base,
      id: '02-slash-menu',
      desc: '选单弹窗(斜杠命令)',
      args: [],
      keys: [{ at: 5000, data: '/' }],
      grab: 7500,
      ...WIDE,
    },
    {
      ...base,
      id: '03-help',
      desc: '帮助 / 命令列表',
      args: [],
      keys: [{ at: 5000, data: '/help\r' }],
      grab: 8000,
      ...WIDE,
    },
    { ...base, id: '04-narrow-80', desc: '窄终端 80 列', args: [], grab: 6000, ...NARROW },
    {
      ...base,
      id: '05-no-color',
      desc: 'NO_COLOR',
      args: [],
      grab: 6000,
      ...WIDE,
      env: { NO_COLOR: '1' },
    },
    { ...base, id: '06-help-flag', desc: '--help(非交互)', args: ['--help'], grab: 4000, ...WIDE },
    {
      ...base,
      id: '07-settings',
      desc: '设置页',
      args: [],
      keys: [{ at: 5000, data: '/settings\r' }],
      grab: 8500,
      ...WIDE,
    },
  ];
}

const FAMILIES = {
  openclaw: { bin: join(CLI_DIR, 'openclaw'), scenarios: () => scenarios(join(CLI_DIR, 'openclaw')) },
  opencode: { bin: join(CLI_DIR, 'opencode'), scenarios: () => scenarios(join(CLI_DIR, 'opencode')) },
  pi: { bin: join(CLI_DIR, 'pi'), scenarios: () => scenarios(join(CLI_DIR, 'pi')) },
  // hermes 的 TUI 不发 npm 包, 从仓库源码起(`npm start` = `tsx src/entry.tsx`)。
  // 它自检 TTY("hermes-tui: no TTY"), 所以只有走 PTY 才起得来。
  hermes: {
    bin: 'npx',
    scenarios: () =>
      scenarios('npx', {
        argsPrefix: ['tsx', 'src/entry.tsx'],
        cwd: '/tmp/bars/hermes-agent/ui-tui',
      }),
  },
  omd: {
    bin: 'bun',
    scenarios: () =>
      scenarios('bun', {
        argsPrefix: [join(ROOT, 'src/harness/cli.ts'), 'tui'],
        env: { OMD_TUI_BACKEND: 'fixture' },
        cwd: ROOT,
      }),
  },
};

/** 剥掉一切可能让竞品 CLI 拿到真凭证的东西。 */
function sandboxEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/API_KEY|TOKEN|SECRET|_KEY$|CREDENTIAL/i.test(k)) continue;
    env[k] = v;
  }
  env.HOME = FAKE_HOME;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.NO_COLOR;
  return { ...env, ...extra };
}

function capture(sc) {
  return new Promise((resolve) => {
    const args = [...(sc.argsPrefix ?? []), ...(sc.args ?? [])];
    let raw = '';
    let done = false;
    let child;
    try {
      child = spawn(sc.bin, args, {
        name: 'xterm-256color',
        cols: sc.cols,
        rows: sc.rows,
        cwd: sc.cwd ?? FAKE_HOME,
        env: sandboxEnv({ ...(sc.env ?? {}) }),
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn 失败: ${err?.message ?? String(err)}`, raw: '' });
      return;
    }

    child.onData((d) => {
      raw += d;
    });
    child.onExit(({ exitCode }) => {
      if (done) return;
      done = true;
      resolve({ ok: raw.length > 0, reason: raw.length ? '' : `无输出, 退出码 ${exitCode}`, raw, exitCode });
    });

    for (const k of sc.keys ?? []) {
      setTimeout(() => {
        if (!done) {
          try {
            child.write(k.data);
          } catch {
            /* 进程已退出, 按键丢弃 —— 会体现在帧里, 不吞证据 */
          }
        }
      }, k.at);
    }

    setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* 已经死了 */
      }
      resolve({ ok: raw.length > 0, reason: raw.length ? '' : '超时且无输出', raw });
    }, sc.grab);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--family') ? argv[argv.indexOf('--family') + 1] : null;

  if (argv.includes('--list')) {
    for (const [name, fam] of Object.entries(FAMILIES)) {
      console.log(`\n[${name}]`);
      for (const sc of fam.scenarios()) console.log(`  ${sc.id.padEnd(16)} ${sc.desc}  (${sc.cols}x${sc.rows})`);
    }
    return;
  }

  mkdirSync(FAKE_HOME, { recursive: true });
  const missing = [];

  for (const [name, fam] of Object.entries(FAMILIES)) {
    if (only && only !== name) continue;
    const dir = join(OUT_ROOT, name);
    mkdirSync(dir, { recursive: true });
    for (const sc of fam.scenarios()) {
      process.stdout.write(`采 ${name}/${sc.id} … `);
      const r = await capture(sc);
      if (!r.ok) {
        console.log(`采不到 (${r.reason})`);
        missing.push({ family: name, id: sc.id, desc: sc.desc, reason: r.reason });
        continue;
      }
      writeFileSync(join(dir, `${sc.id}.ansi`), r.raw);
      const grid = await replayToGrid(r.raw, sc.cols, sc.rows);
      writeFileSync(join(dir, `${sc.id}.txt`), grid);
      const rowsArr = grid.split('\n');
      const nonEmpty = rowsArr.filter((l) => l.trim()).length;
      const over = rowsArr.filter((l) => l.length > sc.cols).length;
      console.log(
        `${r.raw.length} 字节 · 网格 ${sc.cols}x${sc.rows} · 非空行 ${nonEmpty}/${sc.rows} (${Math.round((nonEmpty / sc.rows) * 100)}%) · 溢出行 ${over}`,
      );
    }
  }

  if (missing.length) {
    const md = [
      '# 采不到的帧',
      '',
      '> 按采集纪律:采不到就记采不到,**不用文字描述代替帧**。',
      '',
      '| 家 | 场景 | 说明 | 原因 |',
      '|---|---|---|---|',
      ...missing.map((m) => `| ${m.family} | ${m.id} | ${m.desc} | ${m.reason} |`),
      '',
    ].join('\n');
    mkdirSync(OUT_ROOT, { recursive: true });
    writeFileSync(join(OUT_ROOT, '_MISSING.md'), md);
    console.log(`\n采不到 ${missing.length} 项 → docs/bars/refs/_MISSING.md`);
  }
}

main();
