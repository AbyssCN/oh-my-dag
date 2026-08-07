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
    // ⚠ 工具现在是**一行原地更新**(2026-08-07): start 画 `· name`, end 改成 `✓ name`。
    //   此前是 start/end 各追加一条 notice —— 一轮十次调用二十行噪音。
    check(
      await waitFor(p, (t) => t.includes('✓ fixture_tool')),
      'S10-1 ★ 工具跑完的那一行标记变了(一个工具一行, 不是两条)',
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

/**
 * 场景 4(切片 S12):`/seat` —— 列座位视图 + 真改 `.omd/config.json`。
 *
 * `OMD_CONFIG_PATH` 指到临时文件:这条 lane **绝不许**去动真机的 config。
 */
async function scenarioSeat() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-seat-'));
  const cfg = join(cwd, 'omd-config.json');
  const p = startTui({ cwd, env: { OMD_CONFIG_PATH: cfg } });
  try {
    check(await waitFor(p, (t) => t.includes('omd tui')), 'S12-0 (场景4) 启动');

    p.write('/seat\r');
    check(
      await waitFor(p, (t) => t.includes('可调座位') && t.includes('.omd/config.json')),
      'S12-1 /seat 列出座位视图(说清改的是哪个文件)',
      p.text().slice(0, 700),
    );
    // ★ 列的是**座位视图**不是裸模型列表: 职责那一行来自座位登记表。
    check(p.text().includes('职责:'), 'S12-2 ★ 列的是座位视图(带职责/建议), 不是裸模型名');

    // ⚠ 裸 `/seat` 现在会**开选择器**(2026-08-07 加的对话框)。它拿走焦点, 不 Esc 的话
    //   后面所有输入都进框里 —— 第一次跑就是这么红的 (SESS-1/2 收不到任何东西)。
    check(
      await waitFor(p, (t) => t.includes('改哪个座位')),
      'S12-2b ★ 裸 /seat 开出座位选择器',
      p.text().slice(0, 900),
    );
    // ⚠ 判据不能写成"Esc 之后那句话消失" —— 这条 lane 的 oracle 是**累积缓冲**不是屏幕快照,
    //   打印过的字永远在 `p.text()` 里。要证明框关了, 得证明**输入回到了编辑器**。
    // ⚠ Esc 之后**必须留间隔**再发下一个字符: 终端的序列解析器会把 `\x1b` + `b` 读成
    //   `Alt+b` **一个**序列, 于是 Esc 根本没到。真人按键之间天然有间隔, 脚本里得补上。
    //   (第一次跑就是这么红的: 框画出来了、Esc 发了、什么都没发生。)
    p.write('\x1b');
    await new Promise((r) => setTimeout(r, 200));
    p.write('backhome');
    check(
      await waitFor(p, (t) => t.includes('backhome'), 10000),
      'S12-2c ★ Esc 之后输入回到编辑器(框真的关了)',
      p.text().slice(-400),
    );
    // 清掉刚打的那几个字, 免得跟着下一条命令一起提交。
    for (let i = 0; i < 8; i++) p.write('\x7f');

    // /session: 列会话 + 新开(fixture 后端也实现了 listSessions/loadHistory)。
    p.write('/session\r');
    check(
      await waitFor(p, (t) => t.includes('会话') && t.includes('/session <id> 切换')),
      'SESS-1 /session 列出会话(标出当前那条)',
      p.text().slice(0, 800),
    );
    p.write('\x1b'); // /session 也开选择器 —— 同样 Esc 出来再继续(间隔同上)
    await new Promise((r) => setTimeout(r, 300));
    p.write('/session new mysess\r');
    check(
      await waitFor(p, (t) => t.includes('已新开会话 mysess')),
      'SESS-2 ★ 新开会话有回执',
      p.text().slice(0, 800),
    );
    p.write('/session ../逃逸\r');
    check(
      await waitFor(p, (t) => t.includes('会话 id 非法')),
      'SESS-3 ★ 非法 id 给人话, 不是抛一个栈',
      p.text().slice(0, 800),
    );

    // /settings: owner 指出"设置完全没有"。面板 + 选择器, 只读项标出来。
    p.write('/settings\r');
    check(
      await waitFor(p, (t) => t.includes('座位 conductor') && t.includes('字形白名单')),
      'SET-1 ★ /settings 列出真有数的项(座位/会话/上下文/配色字形/扩展)',
      p.text().slice(0, 1100),
    );
    check(
      await waitFor(p, (t) => t.includes('改哪一项')),
      'SET-2 设置选择器开出来了',
      p.text().slice(-500),
    );
    check(p.text().includes('(只读)'), 'SET-3 ★ 只读项标出来(选中它什么都不做, 这是刻意的)');
    p.write('\x1b');
    await new Promise((r) => setTimeout(r, 300));

    // ★ 斜杠补全: owner 截图抓到的 bug —— 打 /se 弹出来的必须是**命令**不是文件名。
    // ⚠ 判据必须挑一个**此前从未打印过**的串 —— oracle 是累积缓冲, 用 `/seat` 之类
    //   会被前面设置面板打印过的同名文字满足。实跑证伪时它纹丝不动(第二次踩同一个坑)。
    //   `<runId>` 是 `/resume` 的 argumentHint, 只有命令补全弹窗会画出来。
    p.write('/res');
    check(
      await waitFor(p, (t) => t.includes('<runId>'), 8000),
      'SET-4 ★ 斜杠开头补的是**命令**不是文件名(owner 截图里那个 bug)',
      p.text().slice(-600),
    );
    for (let i = 0; i < 4; i++) p.write('\x7f');
    await new Promise((r) => setTimeout(r, 200));

    // /help: 四条命令得发现得了 —— 启动提示提到它, 它列出全部。
    p.write('/help\r');
    check(
      await waitFor(p, (t) => t.includes('/seat') && t.includes('/runs') && t.includes('/skill')),
      'HELP-1 ★ /help 列出全部命令(否则四条命令发现不了)',
      p.text().slice(0, 800),
    );
    // ⚠ 提示里 `/help` 带反引号, 归一化后仍在 —— 断言别把反引号漏掉 (初版就漏了)。
    check(p.text().includes('看命令'), 'HELP-2 启动提示指向 /help', p.text().slice(0, 300));

    // S15 (A7): /skill 列出包内那批方法论 skill, 唤起后挂到**下一句**上。
    p.write('/skill\r');
    // S-6 umbrella: `/skill` 出的是**分组总览**(一组一行), 不再是那面 21 条的墙。
    // 判据同时钉两件事: 组入口画出来了 + "只管本轮"那句还在(它最容易在改版里丢)。
    check(
      await waitFor(p, (t) => t.includes('/omd') && t.includes('本轮')),
      'S15-1 /skill 出分组总览(组入口 + 说清只管本轮)',
      p.text().slice(-800),
    );
    // ★ 组命令本身:`/omd` 列成员, 且成员名**去掉组前缀**(每行重复一遍 omd- 只是噪音)。
    p.write('/omd\r');
    check(
      await waitFor(p, (t) => t.includes('council') && t.includes('用法: /omd')),
      'S15-1b ★ /omd 是一条真命令, 列出组成员',
      p.text().slice(-800),
    );
    p.write('/skill omd-council 审这批座位\r');
    check(
      await waitFor(p, (t) => t.includes('已挂上 skill')),
      'S15-2 ★ 唤起 = 挂到下一句上, 不是立刻跑一轮',
      p.text().slice(0, 800),
    );
    p.write('/skill 根本没有这条\r');
    check(
      await waitFor(p, (t) => t.includes('没有这条 skill')),
      'S15-3 ★ 找不到就说没有(不静默注入空块)',
      p.text().slice(0, 800),
    );

    // S14: fixture 后端**没有** run 能力 —— 键不出现, 而不是点了没反应。
    p.write('/runs\r');
    check(
      await waitFor(p, (t) => t.includes('没有 listRuns 能力')),
      'S14-1 ★ 后端没有 run 能力时说出缺的是什么(能力探测面, 不是假入口)',
      p.text().slice(0, 700),
    );

    p.write('/seat conductor omdtest:model-x\r');
    check(
      await waitFor(p, (t) => t.includes('座位已改')),
      'S12-3 切座位有回执',
      p.text().slice(0, 700),
    );
    // ★ 真改了文件 —— 屏幕上说改了不算数。
    let body = '';
    const wrote = await waitFor(
      { text: () => '' },
      () => {
        try {
          body = readFileSync(cfg, 'utf-8');
          return body.includes('omdtest:model-x');
        } catch {
          return false;
        }
      },
      8000,
    );
    check(wrote, 'S12-4 ★ .omd/config.json 真被改了(屏幕上说改了不算数)', `实得: ${body.slice(0, 200)}`);
  } finally {
    p.kill();
  }
}

/**
 * 场景 5:**真后端起得来**(2026-08-07 补的盲区)。
 *
 * ## 为什么这条非补不可
 *
 * 前面所有场景跑的都是 `OMD_TUI_BACKEND=fixture` —— 那是**刻意**的(L3 不许打真模型)。
 * 但代价是:**生产那条启动路径从来没进过闸**。而它做的事比 fixture 多得多 ——
 * `bootstrapModelRuntime` / `assembleOmdMcpTools` / `ChatStore` / `createOmdMemory` /
 * codegraph 探测 / 扩展加载,任何一处在启动时抛都会让 `omd tui` 打不开,
 * 而 fixture lane 一条都不碰。owner 报"起不来"的那一刻我才发现这个洞。
 *
 * ## 它只验"起得来 + 退得掉",**一个模型请求都不发**
 *
 * 装配与探测都是本地的;真正花钱的只有 `sendChat`,而这条场景**不按回车**。
 */
async function scenarioRealBackendBoots() {
  // ⚠ 不设 OMD_TUI_BACKEND —— 这正是与其它场景的唯一区别, 也是这条的全部意义。
  const p = startPty(BUN, ['run', CLI, 'tui'], { env: { OMD_TUI_BACKEND: '' } });
  try {
    check(
      await waitFor(p, (t) => t.includes('omd tui'), 40000),
      'REAL-1 ★ 真后端(不是 fixture)也起得来',
      p.text().slice(0, 600),
    );
    // footer 必须是 embedded:// —— 是 fixture:// 的话说明环境变量没清干净, 这条就白测了。
    check(
      /\[embedded:\/\/[^\]]+\]/.test(p.text()),
      'REAL-2 ★ footer 是 embedded://<座位>(证明真走了生产装配, 不是 fixture)',
      p.text().slice(-300),
    );
    p.write('\x03');
    await waitFor(p, (t) => t.includes('再按一次'));
    p.write('\x03');
    const code = await Promise.race([p.exitedP, new Promise((r) => setTimeout(() => r('TIMEOUT'), 20000))]);
    check(code === 0, 'REAL-3 真后端下 Ctrl+C 两次也干净退出', `实得 ${code}`);
  } finally {
    p.kill();
  }
}

selfTestOracle();
await scenarioHappyPath();
await scenarioArmReset();
await scenarioLogRedirect();
await scenarioSeat();
await scenarioRealBackendBoots();

if (failures.length) {
  console.error(`\n✗ L3 PTY: ${failures.length} 条不过 —— ${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n✓ L3 PTY 全过');
process.exit(0);
