/**
 * scripts/tui-pty-check —— **L3:真 PTY 里的 `omd tui`**(TUI SDD §9 第三层,切片 S2 验收)。
 *
 * ## ⚠ 为什么是 `.mjs` 跑在 node 上,而不是一条普通的 `bun test`
 *
 * **实测(2026-08-07,不是推测)**:`@lydell/node-pty@1.2.0-beta.14` 在**bun 宿主**下
 * 一个字节都不回 —— `spawn(bun, ['-e','console.log(1)'])` 收到 `bytes=0 exit=0`,
 * 连 `spawn('/bin/bash',['-c','echo A; bun -e ...; echo RC=$?'])` 也只回得到 `A`,
 * 后半截整个消失。同一份代码换 **node 宿主**跑,同样 spawn bun 正常回 12 字节。
 * 对照做全了:bash 子进程在 bun 宿主下**是好的**(9 字节)—— 所以坏的不是 pty 本身,
 * 是 `bun 宿主 + 这个原生模块`这一对。
 *
 * ⇒ PTY 必须由 **node** 托管。`src/tui/tui-pty.test.ts` 只负责把这个脚本调起来收退出码。
 * ⚠ 别"顺手"把它改回 `bun test` —— 会静默变成一条 0 字节因而**永远绿**的假闸。
 *
 * ## 它证明什么 / 不证明什么(SDD §9.1 边界声明)
 *
 * 证明:UI 循环起得来 · 真 pi-tui 渲染出东西 · 按键收得到 · 流式事件装配得对 ·
 * Ctrl+C 两次**干净退出**。
 * **不证明**:引擎行为、真模型、会话持久化、DAG 执行 —— 这条 lane 跑的是
 * `OMD_TUI_BACKEND=fixture`(S10 之后的 L3 接缝),后端自报 `fixture://l3-test`。
 * 拿它声称别的,就是本仓 S-1 那一族。**真引擎那一层是 L4,默认不跑。**
 *
 * ## 永不做 ANSI 快照
 *
 * openclaw `src/tui/AGENTS.md`:*"Avoid raw ANSI snapshots."* —— 快照会因任何布局微调
 * 全红,等于没有测试。这里断言的是**归一化可见文本**(剥 ANSI → 折叠空白 → 找子串),
 * 而那个归一化函数**自己带反测**(见 `selfTestOracle`)。
 *
 * 用法:`node scripts/tui-pty-check.mjs`(退出码 0 = 全过)。
 */
import { spawn } from '@lydell/node-pty';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/harness/cli.ts');
const BUN = process.env.BUN_PATH ?? 'bun';
// 与 `src/tui/backend-fixture.ts` 的 FIXTURE_CHUNKS 逐字一致 —— 这条 lane 是 node 跑的,
// 不 import TS 源;两处不一致时 S10-2/S10-3 会红,而那正是想要的信号。
const FIXTURE_REPLY = ['已收到。', '这是 fixture 后端, 没有发给任何模型。'];

// ---------------------------------------------------------------------------
// oracle:归一化可见文本 + 它自己的反测
// ---------------------------------------------------------------------------

/** 剥 OSC / CSI / SS3 / 单控制码 → 折叠空白。**这就是那个 oracle**。 */
export function visibleText(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[()][A-B0-2]|[=>]|O.|.)?/g, '') // CSI / SS3 / 裸 ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * **闸的反向自检**:一个"从 PTY 捞文本"的 oracle 最容易悄悄变成永远绿的。
 * 所以在跑任何场景之前,先证明它**在该假的时候是假的**。
 */
function selfTestOracle() {
  const framed = '\x1b[?2026h\x1b[1;32mhello\x1b[0m world\x1b[?2026l';
  const checks = [
    [visibleText(framed) === 'hello world', 'oracle 剥不干净 ANSI'],
    [visibleText(framed).includes('goodbye') === false, 'oracle 对不存在的内容判了真'],
    [visibleText(framed).includes('1;32') === false, 'oracle 把颜色码当成了内容'],
    [visibleText(framed).includes('2026') === false, 'oracle 把同步帧标记当成了内容'],
    [visibleText('') === '', '空输出没归一化成空串'],
    [visibleText('\x1b[2J\x1b[H') === '', '纯控制序列没归一化成空串'],
  ];
  const bad = checks.filter(([ok]) => !ok).map(([, why]) => why);
  if (bad.length) {
    console.error(`✗ oracle 反测失败(闸本身坏了,场景结果不可信):\n  - ${bad.join('\n  - ')}`);
    process.exit(2);
  }
  console.log('✓ oracle 反测通过(该假的时候是假的)');
}

// ---------------------------------------------------------------------------
// PTY 驱动
// ---------------------------------------------------------------------------

/** 起一个 PTY 子进程并收全部输出。`startTui` 与日志正对照都走它,免得两处各写一份收流逻辑。 */
function startPty(file, args, opts = {}) {
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    // 尺寸锁死:不锁的话不同机器折行位置不同, 断言就成了碰运气 (SDD §9「锁死环境」)。
    cols: 100,
    rows: 30,
    cwd: opts.cwd ?? ROOT,
    // L3 恒用 fixture 后端: 这条 lane 不许打真模型 (要钱、要网、读数还不稳)。
    env: { ...process.env, NO_COLOR: '1', OMD_INSTALL_SKILLS: '0', OMD_TUI_BACKEND: 'fixture', ...(opts.env ?? {}) },
  });
  let buf = '';
  let exited = null;
  pty.onData((d) => {
    buf += d;
  });
  const exitedP = new Promise((resolve) => {
    pty.onExit(({ exitCode }) => {
      exited = exitCode;
      resolve(exitCode);
    });
  });
  return {
    text: () => visibleText(buf),
    write: (s) => pty.write(s),
    exitedP,
    exitCode: () => exited,
    kill: () => {
      try {
        pty.kill();
      } catch {
        /* 已经死了就算了 —— 这是清理不是判据 */
      }
    },
  };
}

function startTui(opts = {}) {
  return startPty(BUN, ['run', CLI, 'tui'], opts);
}

/** 轮询等到 `pred(可见文本)` 成立。超时**返回 false 不抛** —— 让调用点去说哪里不对。 */
async function waitFor(p, pred, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(p.text())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const failures = [];
function check(ok, label, extra = '') {
  if (ok) console.log(`✓ ${label}`);
  else {
    console.error(`✗ ${label}${extra ? `\n    ${extra}` : ''}`);
    failures.push(label);
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

/** 场景 1:起得来 → 有回显 → Ctrl+C 两次干净退出。 */
async function scenarioHappyPath() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => t.includes('omd tui')), 'S2-1 启动后 TUI 壳出现', p.text().slice(0, 200));
    // 这条 lane 用的是 fixture 后端, footer 上必须**自报家门** ——
    // 一旦这里变成 embedded://, 说明 L3 在打真模型 (要钱, 且读数不再稳定)。
    check(p.text().includes('fixture://l3-test'), 'S2-2 footer 自报 fixture 后端(L3 不打真模型)');

    // S4: 这条 lane 的 cwd 就是 omd 仓, 仓里有 .claude/CLAUDE.md ——
    // 「0 份」正是 SDD §5.1 实测到的那个洞 (两份 harness 一个字都没进过 system prompt)。
    // 断言不钉具体份数: 全局那份取决于跑的人, 钉死份数会变成一条挑机器的闸。
    check(
      /harness [1-9]\d* 份/.test(p.text()),
      'S4-1 头部报出装配到的 harness 份数(不为 0 —— 0 份就是 §5.1 那个洞)',
      p.text().slice(0, 300),
    );
    // ⚠ 这条最初写成 `includes('.claude/CLAUDE.md')` —— **是条假闸**:
    // 全局那份显示成 `~/.claude/CLAUDE.md`, 同一个子串照样命中。实跑证伪时它纹丝不动。
    // 项目那份是相对 cwd 显示的, 所以要连它前面的分隔符一起钉, 才分得开两档。
    check(
      /[:,] \.claude\/CLAUDE\.md/.test(p.text()),
      'S4-2 ★ 项目那份 .claude/CLAUDE.md 真的装进来了(不是被全局那份顶替)',
      p.text().slice(0, 300),
    );

    p.write('hej');
    check(await waitFor(p, (t) => t.includes('hej')), 'S2-3 按键有回显', p.text().slice(0, 200));

    // S8: 回车发一轮 —— 用户消息进记录, 后端 (stub) **响亮地拒绝**。
    p.write('\r');
    check(await waitFor(p, (t) => t.includes('> hej')), 'S8-1 回车后用户消息进对话记录', p.text().slice(0, 400));
    // S10: 后端事件真的装配成了屏幕内容 —— 工具行 + 分两片到达的流式回复。
    check(
      await waitFor(p, (t) => t.includes('fixture_tool ok')),
      'S10-1 工具事件画出来了(start/end 两条真事件)',
      p.text().slice(0, 500),
    );
    check(
      await waitFor(p, (t) => t.includes('这是 fixture 后端')),
      'S10-2 流式回复装配进对话记录',
      p.text().slice(0, 500),
    );
    // S11: HUD 吃到了 DAG 节点事件 —— 逐节点变 + 角色关系行 (owner 裁决 ③)。
    check(
      await waitFor(p, (t) => t.includes('DAG fixture-run')),
      'S11-1 HUD 出现(有 run 才画, 没 run 恒缺席)',
      p.text().slice(0, 600),
    );
    check(
      await waitFor(p, (t) => /conductor .* -> leaf 1 -> verifier 1/.test(t)),
      'S11-2 ★ 角色关系行数对了(leaf 1 / verifier 1)',
      p.text().slice(0, 600),
    );
    check(
      await waitFor(p, (t) => t.includes('fixture-model')),
      'S11-3 节点跑完之后模型名进了表(逐节点变)',
      p.text().slice(0, 600),
    );

    // ★ 两片必须合成**一条**消息。
    // ⚠ 初版写的是"'已收到。' 只出现一次" —— **那是条假闸**: 每片各开一条消息时,
    //   两片文本各自仍只出现一次, 证伪时它纹丝不动 (2026-08-07 实跑抓到)。
    //   分成两条会在中间插一个空行 (ChatLog 的条目间隔), 归一化后变成一个空格;
    //   合成一条则两片**紧挨着**。所以要钉的是拼接后的那个串。
    const merged = FIXTURE_REPLY.join('');
    check(p.text().includes(merged), 'S10-3 ★ 两片流式合成一条消息(中间没有条目间隔)', p.text().slice(0, 500));

    p.write('\x03');
    check(await waitFor(p, (t) => t.includes('再按一次')), 'S2-4 第一次 Ctrl+C 只预备, 不退');

    p.write('\x03');
    const code = await Promise.race([p.exitedP, new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))]);
    check(code === 0, 'S2-5 第二次 Ctrl+C 干净退出 (exit 0)', `实得 ${code}`);
  } finally {
    p.kill();
  }
}

/** 场景 2:预备中打了别的字 → 预备解除,再单击不许退。 */
async function scenarioArmReset() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => t.includes('omd tui')), 'S2-6 (场景2) 启动');
    p.write('\x03');
    check(await waitFor(p, (t) => t.includes('再按一次')), 'S2-7 (场景2) 进入预备');
    // 打的字进输入框 (S8 之后不再是自绘回显)。用一个不会撞上任何 chrome 文案的串。
    p.write('zebra');
    check(await waitFor(p, (t) => t.includes('zebra')), 'S2-8 打字解除预备并回显', p.text().slice(0, 300));
    p.write('\x03');
    // 给它 2s 去"错误地退出"; 没退才算过。
    const died = await Promise.race([
      p.exitedP.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 2000)),
    ]);
    check(died === false, 'S2-9 打字之后的单击 Ctrl+C 不退出(预备已解除)');
  } finally {
    p.kill();
  }
}

/**
 * 场景 3(切片 S3):**日志一个字节都不许进终端**,但日志文件里要有。
 *
 * ## 为什么先跑一条正对照
 *
 * "终端上找不到那句话" 有两种成因:改道生效了(想要的),或者**这条 lane 根本就看不见 pino**
 * (oracle 坏了 / 子进程压根没打日志)。后者会让这条闸永远绿 —— 本仓最贵的那一族。
 * 所以先在同一个 PTY、同一个 NODE_ENV 下让 logger 打一句,**证明它本来是看得见的**,
 * 再去断言 TUI 那句看不见。
 *
 * ## 为什么钉死 NODE_ENV=development
 *
 * 那是 `loadEnv()` 的**默认值**,也正是原先的死路:dev 模式下 pino-pretty 走 worker transport
 * 写死 fd 2,`setLoggerDestination` 对它无效。不钉死这个值,CI 上换个 NODE_ENV 就绕开了病灶。
 */
async function scenarioLogRedirect() {
  const DEV = { NODE_ENV: 'development' };
  const MARK = '日志改道生效';

  // ── 正对照:不改道时,pino 在这条 lane 上**是看得见的** ──
  const control = startPty(BUN, ['-e', `const m = await import(${JSON.stringify(join(ROOT, 'src/logger.ts'))}); m.logger.warn('OMD-PTY-LOG-CONTROL');`], { env: DEV });
  try {
    check(
      await waitFor(control, (t) => t.includes('OMD-PTY-LOG-CONTROL'), 20000),
      'S3-0 正对照: 未改道的 pino 在 PTY 里看得见(否则下面两条是假闸)',
      control.text().slice(0, 200),
    );
  } finally {
    control.kill();
  }

  // ── 真判据:TUI 起来之后,那句启动日志在屏上找不到,在文件里找得到 ──
  // cwd 用临时目录: 日志文件写进 <cwd>/.omd/logs/, 不许拿仓库当草稿纸。
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-pty-'));
  const p = startTui({ cwd, env: DEV });
  try {
    check(await waitFor(p, (t) => t.includes('omd tui')), 'S3-1 (场景3) TUI 起来', p.text().slice(0, 200));
    check(p.text().includes(MARK) === false, 'S3-2 ★ 启动日志不在终端上(改道生效)', p.text().slice(0, 400));

    p.write('\x03');
    await waitFor(p, (t) => t.includes('再按一次'));
    p.write('\x03');
    const code = await Promise.race([p.exitedP, new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))]);
    check(code === 0, 'S3-3 (场景3) 干净退出', `实得 ${code}`);

    const logDir = join(cwd, '.omd', 'logs');
    let files = [];
    let readErr = null;
    try {
      files = readdirSync(logDir);
    } catch (err) {
      readErr = err.message; // 吞异常可以, 吞证据不行 —— 原文进判词。
    }
    check(
      files.length === 1,
      'S3-4 ★ 日志文件恰好建出一个',
      readErr ? `读 ${logDir} 失败: ${readErr}` : `实得 ${JSON.stringify(files)}`,
    );
    const body = files.map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
    check(body.includes(MARK), 'S3-5 ★ 那句日志确实写进了文件(不是被丢了)', body.slice(0, 300) || '(没有可读内容)');
  } finally {
    p.kill();
  }
}

selfTestOracle();
await scenarioHappyPath();
await scenarioArmReset();
await scenarioLogRedirect();

if (failures.length) {
  console.error(`\n✗ L3 PTY: ${failures.length} 条不过 —— ${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n✓ L3 PTY 全过');
process.exit(0);
