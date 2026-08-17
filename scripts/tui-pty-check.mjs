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
 * ⇒ 真 node 宿主继续用 `@lydell/node-pty`;PATH 把 `node` 指到 bun shim 时,脚本改由 util-linux
 * `script` 托管同一批交互(仍是真 PTY,仍跑全部断言),不再落进原生模块的零字节死路。
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
import { spawn as spawnNodePty } from '@lydell/node-pty';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/harness/cli.ts');
const BUN = process.env.BUN_PATH ?? 'bun';
// 与 `src/tui/backend-fixture.ts` 的 FIXTURE_CHUNKS 逐字一致 —— 这条 lane 是 node 跑的,
// 不 import TS 源;两处不一致时 S10-2/S10-3 会红,而那正是想要的信号。
const FIXTURE_REPLY = ['Got it.', 'This is the fixture backend, nothing was sent to any model.'];

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

/** bun 的 node shim 下避开 node-pty 原生回调缺陷,由 util-linux script 持有真 PTY。 */
function startScriptPty(file, args, opts, env) {
  const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const command = `stty cols ${opts.cols ?? 100} rows 30; exec ${[file, ...args].map(quote).join(' ')}`;
  const child = spawnChild('script', ['-q', '-e', '-f', '-c', command, '/dev/null'], {
    cwd: opts.cwd ?? ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let exited = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  child.on('error', (err) => { buf += `\n${String(err)}\n`; });
  // pipe → script 会合并同一 tick 的相邻 write;留出事件边界,模拟 node-pty 每次直写 master。
  let nextWriteAt = 0;
  const write = (s) => {
    const now = Date.now();
    const at = Math.max(now, nextWriteAt);
    nextWriteAt = at + 50;
    setTimeout(() => child.stdin.write(s), at - now);
  };
  const exitedP = new Promise((resolve) => {
    child.on('close', (code) => {
      exited = code;
      resolve(code);
    });
  });
  return {
    text: () => visibleText(buf),
    write,
    exitedP,
    exitCode: () => exited,
    kill: () => child.kill(),
  };
}

/** 起一个 PTY 子进程并收全部输出。`startTui` 与日志正对照都走它,免得两处各写一份收流逻辑。 */
function startPty(file, args, opts = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    OMD_INSTALL_SKILLS: '0',
    OMD_TUI_BACKEND: 'fixture',
    OMD_TUI_USAGE_DIR: mkdtempSync(join(tmpdir(), 'omd-pty-usage-')),
    ...(opts.env ?? {}),
  };
  if (typeof Bun !== 'undefined') return startScriptPty(file, args, opts, env);

  const pty = spawnNodePty(file, args, {
    name: 'xterm-256color',
    // 尺寸锁死:不锁的话不同机器折行位置不同, 断言就成了碰运气 (SDD §9「锁死环境」)。
    // 窄终端场景经 opts.cols 显式给 (切片③: 侧栏自动收起的判据要在 80 列下量)。
    cols: opts.cols ?? 100,
    rows: 30,
    cwd: opts.cwd ?? ROOT,
    env,
  });
  let buf = '';
  let exited = null;
  pty.onData((d) => { buf += d; });
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

/**
 * **壳起来了**的探针。
 *
 * ⚠ 2026-08-08 换过一次判据,记下为什么:原来等的是底栏那句静态
 * `omd tui · /help 看命令 · Ctrl+C 两次退出`。P3 件6 轮3 的盲比 6 跑里 5 跑把
 * 「底部叠了 3 行」指成我方最大缺口,于是那一行**常态收掉了**(只在预备退出时出现)——
 * 而它当时正兼着 10 条「启动」判据的启动信号,一收就是 10 条同时红。
 *
 * 现在等的是欢迎屏那张表的 `引擎` 标签(`CHROME.welcomeBody`)。它比底栏那句更该当这个信号:
 * 它证明的是**首屏画出来了**,而不是"某句装饰文案在"。
 * ⚠ 别换成刚加的输入框提示符 —— 那一行会因为终端太窄而**故意不画**,
 * 拿它当启动信号会在窄终端场景(DG-10)偶发红。
 */
function bootReady(t) {
  return t.includes('engine');
}

/** 场景 1:起得来 → 有回显 → Ctrl+C 两次干净退出。 */
async function scenarioHappyPath() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'S2-1 启动后 TUI 壳出现', p.text().slice(0, 200));
    // 这条 lane 用的是 fixture 后端, footer 上必须**自报家门** ——
    // 一旦这里变成 embedded://, 说明 L3 在打真模型 (要钱, 且读数不再稳定)。
    // ⚠ 2026-08-08:后端坐标从 footer 挪走了(P1 密度), 现在由**行①** 自报。标签跟着改 ——
    //   标签与实际锚点对不上的闸, 红的时候会把人指向错的地方。
    check(p.text().includes('fixture://l3-test'), 'S2-2 行①自报 fixture 后端(L3 不打真模型)');

    /**
     * ⚠ **S4-1 / S4-2 于 2026-08-13 撤除** —— 它们量的东西已经不存在了。
     *
     * 那两条钉的是「装配到的 harness 份数不为 0」与「项目那份 `.claude/CLAUDE.md`
     * 真的装进来了」,来源是 SDD §5.1 实测到的洞(两份 harness 一个字都没进过 system prompt)。
     * 本日 owner 让 omd 自己改 system prompt,**刻意去掉了 `contextFiles` 注入** ——
     * 连带 `src/tui/context.ts`、`formatContextLine` 与屏上那行 `harness N files` 一起删。
     *
     * 于是这两条断言的**对象**没了。留着它们只有两种结局:恒红(现在这样),
     * 或者有人为了让它绿而把一个已被裁掉的行为加回来 —— 后者更糟。
     * 撤除不是"放松判据":那个行为被裁掉是一次显式决定,判据跟着走才是对的。
     *
     * ⇒ 要是将来重新引入 harness 注入,这两条照抄回来即可(git 里有原文)。
     */

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
      await waitFor(p, (t) => t.includes('This is the fixture backend')),
      'S10-2 流式回复装配进对话记录',
      p.text().slice(0, 500),
    );
    // S11: HUD 吃到了 DAG 节点事件 —— 逐节点变 + 角色关系行 (owner 裁决 ③)。
    // ⚠ 切片③起左栏树默认开, 有 run 时它顶掉底部那张表 (同一份 DAG 不画两遍) ——
    //   这里先 /hud 关掉侧栏, 底部表回来, S11 的角色行/模型列断言才看得见。
    p.write('/hud\r');
    check(await waitFor(p, (t) => t.includes('DAG sidebar: off')), 'S11-0 /hud 能关掉侧栏(底部表回来)', p.text().slice(-300));
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

    // ── 切片② G-2: 跑一轮后底栏有真数(与 backend-fixture.ts 的 FIXTURE_USAGE 逐字对应)。──
    // ⚠ 2026-08-09 底栏**从两行减到一行**, 判据跟着改:`in/out/cache` 三个词换成 `↑↓`,
    //   绝对 cache 数不画了(与命中率重复)⇒ 现在钉 `↑3.1k ↓184 缓存88%`。
    //   数还是那三个(3120/184/2760 → 88%), 变的是词元数不是信息。
    check(
      await waitFor(p, (t) => t.includes('↑3.1k ↓184 cache88%')),
      'SB-1 ★ 底栏: token 与命中率非零且与账本一致(3120/184/2760 → 88%)',
      p.text().slice(-500),
    );
    // fixture:model 不在价表 → unpriced → `$0.00+`(下界标注), **不是** 0% 也不是编一个百分比。
    // ⚠ 判据随底栏减法改了三处(2026-08-09), 每处的**语义没放松**:
    //   · `5h $0.00+ · 1 次` → `$0.00+ 1次`:会话与 5h 相同时只画一个数(fixture 里两者都是 0),
    //     `+` 后缀(未计价的下界标注)照旧钉住 —— 那才是这条闸的要点。
    //   · provider 逐项拆分**只在 ≥2 个按量 provider 时才画** ⇒ 单 provider 的 fixture 下
    //     那一段本来就不该在, 原来的 SB-3 从这一版起判**它不出现**(不是删掉这条闸)。
    //   · `oh-my-dag · main` 的分隔点去掉了(省一个词元)⇒ 正则改成 `oh-my-dag \S+`。
    check(p.text().includes('$0.00+ 1x'), 'SB-2 ★ 底栏: 窗口段有真计数, 未计价带 + 标注', p.text().slice(-500));
    check(!p.text().includes('fixture $0.00+'), 'SB-3 ★ 单 provider 时不画逐项拆分(与座位坐标重复)', p.text().slice(-500));
    // 工作区段: 这条 lane 的 cwd 就是 omd 仓 → 仓名与分支该在。
    check(/oh-my-dag \S+/.test(p.text()), 'SB-4 底栏: git 仓名+分支段', p.text().slice(-500));
    /**
     * ★ **SB-5:`ctx` 段端到端有闸**(2026-08-09 新加)。
     *
     * 在这之前它**一条闸都没有** —— fixture 后端不发 `pressure`, 所以 L3 永远看不到这一段;
     * 真机上它只在"live 采帧且这一轮刚好在 grab 前定稿"时出现。本程就吃过这个:
     * 两张 live 帧都缺 ctx, 而我一时分不清是时序还是我把它改坏了。
     * fixture 现在发一组写死的读数(`FIXTURE_PRESSURE` = 12k/200k = **6%**)。
     */
    // 2026-08-17 判据换锚: 仪表 ctx 条在场时平文 `ctx 6%` 段撤下 (同屏两个 ctx 是重复读数, 帧实测) —— 锚改条形 + 真百分比两半合读。
    check(await waitFor(p, (t) => t.includes('ctx #') && t.includes(' 6%')), 'SB-5 ★ 底栏: ctx 条形段有真百分比(12k/200k = 6%)', p.text().slice(-400));

    // ── 切片⑦: 会话树 —— fork 一条、切回去、两条互不污染 (G 判据逐字)。──
    // ⚠ 2026-08-09: 默认会话 id 不再是写死的 `tui`(写死会让多开的两个窗口写同一条会话),
    //   ⇒ 下面四条断言**从欢迎屏把本进程的 id 读回来**, 不再拿字面 `tui` 拼。
    const sessionId = (p.text().match(/session\s+(s-\d+-\d+)/) ?? [])[1];
    check(
      Boolean(sessionId),
      'SESS-0 ★ 欢迎屏写的是本进程自己的会话 id(`s-<秒>-<pid>`, 不是写死的 tui)',
      p.text().slice(0, 700),
    );
    p.write('/session fork\r');
    check(
      await waitFor(p, (t) => t.includes(`forked`) && t.includes(`from ${sessionId}`) && t.includes('switched to the branch')),
      'SF-1 ★ fork 有回执且已切进分支',
      p.text().slice(-500),
    );
    p.write('branch-only\r'); // 分支里多说一句 —— 污染探针
    check(await waitFor(p, (t) => t.includes('> branch-only')), 'SF-2 分支里的新消息进了分支');
    p.write(`/session ${sessionId}\r`);
    check(
      await waitFor(p, (t) => t.includes(`Switched to session ${sessionId} (replayed 1 `)),
      'SF-3 ★ 切回原会话: 回放数不含分支消息(互不污染)',
      p.text().slice(-500),
    );
    p.write('/session\r');
    check(
      await waitFor(p, (t) => t.includes(`<- forked from ${sessionId}`)),
      'SF-4 会话列表画出 lineage(树的边是数据)',
      p.text().slice(-600),
    );
    p.write('\x1b'); // 关掉会话选择器
    await new Promise((r) => setTimeout(r, 300));

    p.write('\x03');
    check(await waitFor(p, (t) => t.includes('press Ctrl+C again')), 'S2-4 第一次 Ctrl+C 只预备, 不退');

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
    check(await waitFor(p, (t) => bootReady(t)), 'S2-6 (场景2) 启动');
    p.write('\x03');
    check(await waitFor(p, (t) => t.includes('press Ctrl+C again')), 'S2-7 (场景2) 进入预备');
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
    check(await waitFor(p, (t) => bootReady(t)), 'S3-1 (场景3) TUI 起来', p.text().slice(0, 200));
    check(p.text().includes(MARK) === false, 'S3-2 ★ 启动日志不在终端上(改道生效)', p.text().slice(0, 400));

    p.write('\x03');
    await waitFor(p, (t) => t.includes('press Ctrl+C again'));
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
    check(await waitFor(p, (t) => bootReady(t)), 'S12-0 (场景4) 启动');

    p.write('/seat\r');
    check(
      await waitFor(p, (t) => t.includes('tunable seats') && t.includes('.omd/config.json')),
      'S12-1 /seat 列出座位视图(说清改的是哪个文件)',
      p.text().slice(0, 700),
    );
    // ★ 列的是**座位视图**不是裸模型列表: 职责那一行来自座位登记表。
    check(p.text().includes('does:'), 'S12-2 ★ 列的是座位视图(带职责/建议), 不是裸模型名');

    // ⚠ 裸 `/seat` 现在会**开选择器**(2026-08-07 加的对话框)。它拿走焦点, 不 Esc 的话
    //   后面所有输入都进框里 —— 第一次跑就是这么红的 (SESS-1/2 收不到任何东西)。
    check(
      await waitFor(p, (t) => t.includes('Which seat?')),
      'S12-2b ★ 裸 /seat 开出座位面板',
      p.text().slice(0, 900),
    );
    /**
     * ★★ **P2 IA 收敛(2026-08-08):`/seat` 与 `/settings` 现在是同一个组件。**
     *
     * 老路三层:`改哪个座位?` 列表 →(Enter)→ 模型选单 →(Esc)→ 靠 `for(;;)` 重开父层。
     * 新路两层:面板里**每行就是一个座位**, Enter **直接**开模型子层。
     *
     * ⚠ 判据锚 `lastIndexOf` 的**先后**, 不锚子串 —— oracle 是累积缓冲,
     * `改哪个座位` 前面早就打印过, `includes` 无论收没收敛都是真(本文件头那一族假绿)。
     */
    const seatPanelAt = p.text().lastIndexOf('改哪个座位');
    p.write('\r');
    check(
      await waitFor(p, (t) => Math.max(t.lastIndexOf('换成哪个模型'), t.lastIndexOf('换成哪个坐标')) > seatPanelAt),
      'S12-2b2 ★★ /seat 里 Enter **直接**开模型子层(中间那层没了 = 与 /settings 同一个组件)',
      p.text().slice(-900),
    );
    p.write('\x1b');
    await new Promise((r) => setTimeout(r, 200));
    check(
      await waitFor(p, (t) => t.lastIndexOf('Which seat?') > Math.max(t.lastIndexOf('to which model?'), t.lastIndexOf('Which coordinate'))),
      'S12-2b3 ★ 子层 Esc → 回**座位面板**(退一级, 与设置页同一套行为)',
      p.text().slice(-900),
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

    /**
     * ★★ **P2 verify 的第三条:三个入口进的是同一个子页**(plan §3 P2 原话
     * 「三个入口进的是同一个子页(PTY 断言同一屏)」)。
     *
     * `/settings` 与 `/seat` 两条已由 SET-8 / S12-2b2 各自钉过, **`/models` 此前一条断言都没有** ——
     * 而它正是那三个入口里最容易漂开的一个(它走的是一次性 Promise, 不是面板子层)。
     *
     * 判据锚**同一个标题串**:三处都由 `seatModelOpts()` 生成, 所以标题逐字相同才叫"同一个子页";
     * 任何一处自己拼标题(= 又养了一套实现)这条就红。
     * ⚠ 仍锚 `lastIndexOf` 的先后 —— 累积缓冲里这个串前面已经出现过两次。
     * ⚠ **位置很重要**:必须等座位面板真的关掉、输入回到编辑器之后再发 ——
     *   第一版插在面板还开着的地方, `/models` 被面板当按键吃掉了, 于是闸红。
     *   **那次红是我的时序错, 不是产品缺陷**(隔离探针证明它进的就是同一个子页)。
     */
    // ⚠ S12-2c 往编辑器里打了 `backhome` 且没回车 —— **先清干净**, 否则发出去的是
    //   `backhome/models`(第二版就是这么红的, 还顺带把后面的 HELP-1 带红了)。
    for (let i = 0; i < 10; i++) p.write('\x7f');
    await new Promise((r) => setTimeout(r, 200));
    // ⚠ **两种标题都要认** —— 这条 lane 的 cwd 里座位没配、模型目录为空, 三个入口都会
    //   退回手输框(`换成哪个坐标`)。兄弟闸 SET-8 / S12-2b2 早就是这么写的;
    //   第三版只认 `换成哪个模型` 所以红 —— **那是我的判据挑食, 不是产品缺陷**。
    //   ⚠ 代价说清楚:目录为空时这条只能证明"进的是同形状的子页", 分不出是哪一个 ——
    //   与那两条兄弟闸同一个标准, 不更强也不更弱。
    const titleAt = (t) => Math.max(t.lastIndexOf('conductor 换成哪个模型'), t.lastIndexOf('conductor 换成哪个坐标'));
    const beforeModels = titleAt(p.text());
    p.write('/models\r');
    check(
      await waitFor(p, (t) => titleAt(t) > beforeModels),
      'S12-2d ★★ /models 进的是**同一个子页**(与 /seat、/settings 逐字同一个标题 = 一份实现三个入口)',
      p.text().slice(-700),
    );
    p.write('\x1b');
    await new Promise((r) => setTimeout(r, 250));

    // 清掉刚打的那几个字, 免得跟着下一条命令一起提交。
    for (let i = 0; i < 8; i++) p.write('\x7f');

    // /session: 列会话 + 新开(fixture 后端也实现了 listSessions/loadHistory)。
    p.write('/session\r');
    check(
      await waitFor(p, (t) => t.includes('/session <id> to switch') && t.includes('/session new [id]')),
      'SESS-1 /session 列出会话(标出当前那条)',
      p.text().slice(0, 800),
    );
    p.write('\x1b'); // /session 也开选择器 —— 同样 Esc 出来再继续(间隔同上)
    await new Promise((r) => setTimeout(r, 300));
    p.write('/session new mysess\r');
    check(
      await waitFor(p, (t) => t.includes('New session mysess')),
      'SESS-2 ★ 新开会话有回执',
      p.text().slice(0, 800),
    );
    p.write('/session ../逃逸\r');
    check(
      await waitFor(p, (t) => t.includes('Invalid session id')),
      'SESS-3 ★ 非法 id 给人话, 不是抛一个栈',
      p.text().slice(0, 800),
    );

    // /settings: owner 指出"设置完全没有"。面板 + 选择器, 只读项标出来。
    p.write('/settings\r');
    check(
      await waitFor(p, (t) => t.includes('seat conductor') && t.includes('glyph whitelist')),
      'SET-1 ★ /settings 列出真有数的项(座位/会话/上下文/配色字形/扩展)',
      p.text().slice(0, 1100),
    );
    check(
      await waitFor(p, (t) => t.includes('Which setting?')),
      'SET-2 设置选择器开出来了',
      p.text().slice(-500),
    );
    check(p.text().includes('(read-only)'), 'SET-3 ★ 只读项标出来(选中它什么都不做, 这是刻意的)');
    /**
     * ★ **标题只许出现一次** —— 2026-08-08 帧上抓到的:面板自己画框之后,宿主那边又套了
     * 一层 `DialogBox`,于是**双层框 + 标题印两遍**。
     *
     * ⚠ 单测抓不到这一条:它量的是面板自己的 `render()`,外面套的那层不在它视野里。
     *
     * ⚠ 判据必须是**否定式**:oracle 是累积缓冲,`改哪一项` 每次重绘都进一次,
     * 数它出现几次没有意义。所以锚的是嵌套**独有的那个形状** ——
     * 外框的竖线紧接着内框的左上角(`│ ┌─ 改哪一项`)。它一次都不该出现。
     * 证伪方式:把宿主那层 `DialogBox` 加回去 → 当场红(2026-08-08 实跑过)。
     */
    check(!/│ ┌─ Which setting/.test(p.text()), 'SET-2b ★ 设置页没有嵌套框(标题不印两遍)', p.text().slice(-900));
    // 切片⑥: 可改组进了面板 (界面/沙箱/provider)。
    check(p.text().includes('DAG sidebar default'), 'SET-5 ★ 界面组在面板里(写 tui.ui)', p.text().slice(-900));
    check(p.text().includes('shell sandbox'), 'SET-6 ★ 沙箱现状在面板里(2026-08-13 替掉审批组; 只读行)', p.text().slice(-900));
    check(p.text().includes('provider credentials'), 'SET-7 provider 组在面板里(只显示配没配)', p.text().slice(-900));

    /**
     * ★ **SET-8/9/10/11:Esc 退一级,不是退到底**(2026-08-08,owner 点名的那条)。
     *
     * ⚠ **2026-08-08 键路径变了**(P1-3:设置页迁到 pi-tui `SettingsList`)。
     * 老路是三层:设置页 →(Enter)→ 座位列表 →(Enter)→ 模型选择器,中间那层
     * `改哪个座位` 是"父层套 for(;;) 重开"那个做法的产物。现在设置页里每个座位**自己就是一行**,
     * Enter 直接开子层 ⇒ **只剩两层**,中间那层在这条路径上不再出现
     * (`/seat` 命令那条路仍有它 —— 那是另一个入口,见 P2 的 IA 收敛)。
     *
     * ⚠ 判据的**语义一个字都没放松**:仍然锚 `lastIndexOf` 的**先后**,不锚子串 ——
     * oracle 是累积缓冲,`改哪一项` / `审批 token TTL` 在前面早就出现过,
     * `includes` 无论修没修都是真(本文件头记的那一族假绿)。
     */
    const panelAt = p.text().lastIndexOf('改哪一项');
    p.write('\r'); // 选中第一行(座位 conductor)→ **直接**开模型选单
    check(
      await waitFor(p, (t) => Math.max(t.lastIndexOf('换成哪个模型'), t.lastIndexOf('换成哪个坐标')) > panelAt),
      'SET-8 ★ 设置页 Enter 座位行 → 直接开模型子层(SettingsList.submenu; 中间那层没了)',
      p.text().slice(-900),
    );
    p.write('\x1b'); // ← 这一下就是 owner 报的那一下
    check(
      await waitFor(p, (t) => t.lastIndexOf('Which setting?') > Math.max(t.lastIndexOf('to which model?'), t.lastIndexOf('Which coordinate'))),
      'SET-9 ★ 子层 Esc → 回**设置页主表**(不是退出整个设置)',
      p.text().slice(-900),
    );

    /**
     * ★★ **SET-10/11:选中行不丢** —— 这是 `SettingsList.submenu` 换掉"重开父层"真正买到的东西。
     *
     * 走到 `seat leaf` 那一行(不是第一行 —— 第一行退回来也在第一行,那条判据是空的),
     * 开子层再退回来,焦点该还钉在那一行。
     *
     * ⚠ **2026-08-13 换了锚行**:原来锚的是 `审批 token TTL`(文本子层),
     * 而审批那一行随审批层一起删了。现在唯一的子层是座位 ⇒ 锚 `seat leaf`(第 2 行)。
     * 判据的语义一个字没放松:仍是"不是第一行 + 开子层 + 退回来还在原行"。
     *
     * ⚠ 焦点靠**光标字形** `→ ` 认。判据是 `lastIndexOf('→ seat leaf')` 排在子层标题之后 ——
     * 光标在开子层**之前**也停在那一行,所以 `includes` 是假绿。
     */
    let onLeaf = false;
    for (let i = 0; i < 16 && !onLeaf; i++) {
      p.write('\x1b[B');
      await new Promise((r) => setTimeout(r, 80));
      onLeaf = p.text().includes('→ seat leaf');
    }
    check(onLeaf, 'SET-10 ↓ 走得到「seat leaf」那一行(光标钉在它上面)', p.text().slice(-900));
    p.write('\r'); // 开座位子层
    check(
      await waitFor(p, (t) => t.lastIndexOf('leaf 换成哪个模型?') > t.lastIndexOf('→ seat leaf')),
      'SET-11 座位子层开出来了(不是第一行那个 conductor 的)',
      p.text().slice(-900),
    );
    const subAt = p.text().lastIndexOf('leaf 换成哪个模型?');
    p.write('\x1b');
    check(
      await waitFor(p, (t) => t.lastIndexOf('→ seat leaf') > subAt),
      'SET-12 ★★ 退回来**选中行没丢** —— 光标还钉在原来那一行(老做法会回到第一行)',
      p.text().slice(-900),
    );

    p.write('\x1b'); // 主表这一层的 Esc 才真收工
    await new Promise((r) => setTimeout(r, 300));

    // 切片⑥: /login 开得出 provider 选择器; Esc 什么都不改 (真落 key 的路径走 headless-config 的单测)。
    // 2026-08-10 全目录化 (owner 点名照 pi): 标题带 (N/M configured) 计数, 列表是 pi 目录 38 家
    // ∪ 探到的 ∪ claude-code —— 任何机器上都必有未配的家, 所以 `unconfigured` 恒可见。
    p.write('/login\r');
    check(
      await waitFor(p, (t) => t.includes('Configure which provider?')),
      'LOGIN-1 ★ /login 开出 provider 选择器(全目录, 标题带配置计数)',
      p.text().slice(-500),
    );
    check(
      await waitFor(p, (t) => t.includes('unconfigured')),
      'LOGIN-1b ★ 已配/未配状态标在行上(pi 形: `id · unconfigured`)',
      p.text().slice(-500),
    );
    p.write('\x1b');
    await new Promise((r) => setTimeout(r, 300));
    check(p.text().includes('Key written to') === false, 'LOGIN-2 ★ Esc 取消后什么都没写');

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
      // ★ 锚在**尾部**命令 (2026-08-10 slash 面补齐后表长 17 行): 30 行终端首绘只画得下
      //   表尾, 头部行经 PgUp 可达 —— 完整性由 commands.test 的 formatHelp 单测保
      //   (全部命令必在字符串里), 这里量的是"表真的画上屏了"。/export /quit 是表尾两条。
      await waitFor(p, (t) => t.includes('/export') && t.includes('/quit') && t.includes('/compact')),
      'HELP-1 ★ /help 列出命令表(尾部可见, 头部 PgUp 可达, 完整性走单测)',
      p.text().slice(0, 800),
    );
    // ⚠ 提示里 `/help` 带反引号, 归一化后仍在 —— 断言别把反引号漏掉 (初版就漏了)。
    check(p.text().includes('for commands'), 'HELP-2 启动提示指向 /help', p.text().slice(0, 300));

    // S15 (A7): /skill 列出包内那批方法论 skill, 唤起后挂到**下一句**上。
    p.write('/skill\r');
    // S-6 umbrella: `/skill` 出的是**分组总览**(一组一行), 不再是那面 21 条的墙。
    // 判据同时钉两件事: 组入口画出来了 + "只管本轮"那句还在(它最容易在改版里丢)。
    check(
      await waitFor(p, (t) => t.includes('/omd') && t.includes('this turn')),
      'S15-1 /skill 出分组总览(组入口 + 说清只管本轮)',
      p.text().slice(-800),
    );
    // ★ 组命令本身:`/omd` 列成员, 且成员名**去掉组前缀**(每行重复一遍 omd- 只是噪音)。
    p.write('/omd\r');
    check(
      await waitFor(p, (t) => t.includes('council') && t.includes('Usage: /omd')),
      'S15-1b ★ /omd 是一条真命令, 列出组成员',
      p.text().slice(-800),
    );
    p.write('/skill omd-council 审这批座位\r');
    check(
      await waitFor(p, (t) => t.includes('armed')),
      'S15-2 ★ 唤起 = 挂到下一句上, 不是立刻跑一轮',
      p.text().slice(0, 800),
    );
    p.write('/skill 根本没有这条\r');
    check(
      await waitFor(p, (t) => t.includes('No such skill')),
      'S15-3 ★ 找不到就说没有(不静默注入空块)',
      p.text().slice(0, 800),
    );

    // S14: fixture 后端**没有** run 能力 —— 键不出现, 而不是点了没反应。
    p.write('/runs\r');
    check(
      await waitFor(p, (t) => t.includes('no listRuns capability')),
      'S14-1 ★ 后端没有 run 能力时说出缺的是什么(能力探测面, 不是假入口)',
      p.text().slice(0, 700),
    );

    p.write('/seat conductor omdtest:model-x\r');
    check(
      await waitFor(p, (t) => t.includes('Seat changed')),
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
 * 场景 4.8:**skill 补全三段式**(切片④,G-4)。
 *
 * `/` 只出组(S15/SET-4 已覆盖命令层)→ 这里验后两段:`/omd-` 出全名成员;
 * `/omd ` 出**不带前缀**的成员(判据用 `[^-]council` —— 全名 `omd-council` 里
 * `council` 前面是连字符,匹配不上;裸名前面是空格,匹配得上)。
 */
async function scenarioSkillComplete() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'SKC-0 (场景4.8) 启动');
    p.write('/omd-');
    check(
      await waitFor(p, (t) => t.includes('omd-council'), 8000),
      'SKC-1 ★ /omd- 展开全名成员(omd-council 出现在补全里)',
      p.text().slice(-500),
    );
    for (let i = 0; i < 5; i++) p.write('\x7f'); // 退掉 /omd-
    await new Promise((r) => setTimeout(r, 200));
    p.write('/omd c');
    check(
      await waitFor(p, (t) => /[^-]council/.test(t), 8000),
      'SKC-2 ★ /omd + 空格出**不带前缀**的成员(裸名 council)',
      p.text().slice(-500),
    );
    for (let i = 0; i < 6; i++) p.write('\x7f'); // 清掉 /omd c
    await new Promise((r) => setTimeout(r, 200));

    // ── 切片⑤: 上下文健康度一行 (顺在同一场景里: 计数属于同一条会话)。
    check(p.text().includes('Context health') === false, 'CH-1 ★ 平时不占位(触发前那一行不存在)');
    p.write('fixture:reads\r');
    check(
      await waitFor(p, (t) => t.includes('Context health') && t.includes('3x already')),
      'CH-2 ★ 同一文件 read 3 次 → 健康度一行亮, 带路径与次数',
      p.text().slice(-500),
    );
    // 新开会话 → 计数清零, 一行摘掉 (状态跟会话走)。屏上历史里那句还在 —— 判据用**当前可见帧**
    // 不好取, 退而断言回执出现 (reset 逻辑由 health.test.ts 钉)。
    p.write('/session new\r');
    check(await waitFor(p, (t) => t.includes('New session')), 'CH-3 换会话有回执(计数清零走 L1 闸)');
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.9:**pathfinder 地图切换**(切片⑧,主 C 副 B)。
 *
 * 判据逐字对 v5 切片表: 图列得出 · 切得动 · 票与 run 的关系看得见;
 * 加 owner 裁决: C 雾退线默认, Tab 切 B 三角洲, 票 Enter 出动作弹窗。
 *
 * ## ★ 2026-08-13:改成 **fixture 图 + 临时 cwd**,不再吃真仓状态
 *
 * 原来这条 lane 的 cwd 是 omd 仓、读 `docs/plan/pathfinder/` 里的真图。
 * commit `933481f`「md 图挪进 archive」之后那个目录只剩 `archive/` ——
 * 于是 PF-1..PF-5 **五条全红**,屏上是 `No pathfinder map yet (…is empty)`。
 * 那不是 UI 坏了,是判据的前提被别的改动搬走了。
 *
 * 这五条量的是**交互链**(Ctrl+P → 全屏 → Tab 换画法 → Enter 出弹窗),
 * 跟图从哪来无关。所以照这条 lane 其它场景的惯例改成临时 cwd + 自带一张图:
 * 判据从此只依赖这个文件,不依赖今天仓里恰好还剩几张图。
 *
 * 图用的是仓里已有的 `fog-acceptance.fixture.md`(fog 单测的同一份)——
 * **不另抄一份**:两份必漂,而漂掉的那份会让 PTY 绿着而单测红。
 */
async function scenarioPathfinder() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-path-'));
  const mapDir = join(cwd, 'docs', 'plan', 'pathfinder');
  mkdirSync(mapDir, { recursive: true });
  // 只有**一张**图 ⇒ Ctrl+P「一张直接进」那一支(PF-1 的两支都认)。
  writeFileSync(join(mapDir, 'fog-acceptance.md'), readFileSync(join(ROOT, 'src/harness/pathfinder/fog-acceptance.fixture.md'), 'utf8'));
  const p = startTui({ cwd });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'PF-0 (场景4.9) 启动');
    p.write('\x10'); // Ctrl+P
    check(
      await waitFor(p, (t) => t.includes('Switch to which map?') || t.includes('fog line')),
      'PF-1 ★ Ctrl+P 列得出地图(多张出选择器, 一张直接进)',
      p.text().slice(-600),
    );
    if (p.text().includes('Switch to which map?')) {
      p.write('session'); // 搜索: 挑 session-continuity-port (它有前沿票)
      await new Promise((r) => setTimeout(r, 400));
      p.write('\r');
    }
    check(
      await waitFor(p, (t) => t.includes('fog line') && t.includes('settled')),
      'PF-2 ★ 切得动 —— 进了那张图的全屏雾退线 (画法 C 默认)',
      p.text().slice(-800),
    );
    check(/· \d+ runs|· no runs/.test(p.text()), 'PF-3 ★ 票与 run 的关系看得见(头行的 run 计数段)', p.text().slice(-600));
    p.write('\t');
    check(await waitFor(p, (t) => t.includes('delta')), 'PF-4 ★ Tab 切到画法 B 三角洲', p.text().slice(-600));
    p.write('\t');
    await new Promise((r) => setTimeout(r, 300));
    p.write('\r'); // Enter: 选中票的动作弹窗
    check(
      await waitFor(p, (t) => t.includes('g grill') && t.includes('research')),
      'PF-5 ★ 票的动作弹窗 (g/d/c/r 四动作)',
      p.text().slice(-600),
    );
    p.write('\x1b'); // Esc 返回
    await new Promise((r) => setTimeout(r, 300));
    p.write('\x10'); // Ctrl+P 退出全屏
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    p.kill();
  }
}

/**
 * 场景 S5:**决策地图票看板**(切片 S5, D-12 ①③)。
 *
 * 欢迎屏侧栏画 `ticket board` 块 —— 数据只读盘上 PathMap (resolveBackend(cwd).readMap),
 * 复用 pathHud.refresh() 的时机, 渲染路径零写。
 *
 * ⚠ 判据为什么选看板独有前缀 `ticket board`:**证伪已当场做过** —— 接线前整跑一遍本脚本
 * (全绿)且全仓 grep 该串只命中 `components/ticket-board.ts`(未挂进 tui.ts 时到不了屏),
 * 即它只有新行为才产得出;若误选 `Got it.`(旧行为也产出)会假绿。反向: 删掉 tui.ts 的接线,
 * TB-1 当场红。
 *
 * ⚠ TB-2 不是摆设: 读盘失败行 (`ticket board could not be read: …`) **也含** `ticket board`
 * 子串 —— 没有 TB-2, TB-1 会在看板实际坏掉时照样绿。两者合读才等于"头在且不是错行"。
 */
/**
 * 播一张最小 PathMap 到 `cwd` —— **经 `saveMap` 真写,不在这里手抄盘上格式**
 * (抄一份必漂,而漂了不报错)。本 lane 是 node 跑的,所以借 `bun -e` 动态 import TS 源,
 * 同 `scenarioLogging` 里那条 control 的办法。
 */
function seedTicketMap(cwd) {
  const store = JSON.stringify(join(ROOT, 'src/harness/pathfinder/map-store.ts'));
  const map = JSON.stringify({
    destination: 'PTY 夹具图',
    slug: 'pty-fixture',
    decisionsLog: [],
    tickets: [{ id: 't1', type: 'task', title: '夹具票', blockedBy: [], status: 'open' }],
  });
  execFileSync(BUN, ['-e', `const m = await import(${store}); m.saveMap(${map}, ${JSON.stringify(cwd)});`], { stdio: 'pipe' });
}

async function scenarioTicketBoard() {
  // ⚠ **自带夹具, 不读"盘上恰好有没有图"**(2026-08-14 修)。原来 startTui() 用仓根当 cwd,
  //   于是判据实际量的是「这台机器的仓里有没有一张非空 PathMap」——主仓有所以一直绿,
  //   而任何 worktree 的 `.omd/` 是 gitignored ⇒ 空 ⇒ TB-1 恒红, 红的理由与它守的东西无关。
  //   同 S-36 那条注释骂过的形状:去读真机 /proc/mounts 的闸, 量的是那台机器不是这段代码。
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-map-'));
  seedTicketMap(cwd);
  const p = startTui({ cwd });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'TB-0 (场景 S5) 启动');
    // 2026-08-17 判据换锚 (facelift 去重): 表头 `ticket board ·` 不再上屏 (map 标题唯一归
    // PathHud 的 `map <destination>`), 票行成了看板**独有**产出 (PathHud 收缩后不再画票)。
    // 证伪同原款: 夹具票标题 `夹具票` 全仓只有 seedTicketMap 产得出, 空图连行都没有。
    check(
      await waitFor(p, (t) => t.includes('map PTY 夹具图') && t.includes('夹具票')),
      'TB-1 ★ 欢迎屏画出 map 标题 (PathHud) + 票行 (看板) —— 各自唯一, 合读 = 两件都在且不重复',
      p.text().slice(-600),
    );
    check(
      !p.text().includes('ticket board could not be read'),
      'TB-2 ★ 看板不是读盘失败错行冒充的 (错行也含 ticket board, 必须区分)',
      p.text().slice(-600),
    );
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.6:**左栏 DAG + 三画法**(切片③,G-3)。
 *
 * `fixture:dag` 暗号发一个带 map 分裂的 run(planned 无 deps · expanded 带 parent+deps,
 * 形状与引擎逐字一致)。判据:侧栏树画出 ├─ └─;Ctrl+G 全屏后 Tab 在 树/甘特/分层 间切;
 * 80 列窄终端下侧栏自动收起、底部表顶上。
 */
async function scenarioDagViews() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'DG-0 (场景4.6) 启动');
    p.write('fixture:dag\r');
    check(await waitFor(p, (t) => t.includes('fan-out demo graph sent')), 'DG-1 fan-out 演示 run 发完', p.text().slice(-400));
    check(
      await waitFor(p, (t) => t.includes('├─') && t.includes('└─')),
      'DG-2 ★ 侧栏树画出分裂(├─ └─ 都在)',
      p.text().slice(-600),
    );
    check(p.text().includes('DAG fixture-fanout'), 'DG-3 树头行带 run id', p.text().slice(-600));

    // ── C-6 画法 (SDD 2026-08-11, S3 切片): fixture 的演示 run 现在带
    //    durationMs/failReason/progress/verdict —— 树要把这四件事画出来。 ──
    // ② failed 节点下一行缩进画 failReason。归一化文本没有"行", 钉**顺序**: 节点行先于原因。
    //    证伪: 注释掉 dag-tree render 里的 failReason 子行 → `assertion failed` 不出现, 红。
    check(
      await waitFor(p, (t) => t.includes('assertion failed') && t.indexOf('shard-2 agent') < t.indexOf('assertion failed')),
      'DG-14 ★ C-6② 失败原因画在失败节点下一行(failReason 来自 settle, 不是编的)',
      p.text().slice(-600),
    );
    // ③ 审核判决画子行: ✗/✓ <gate> r<N>: <reason>。fixture 给了 pass + fail 各一条。
    //    ⚠ 侧栏只有 34 列, reason 尾巴会被 fitLine 截掉 —— 这里钉 `✗ verifier r1` (形状),
    //    完整 `<reason>` 由 dag-tree.test.ts 在宽行上钉。
    //    证伪: 注释掉 dag-tree render 里的 verdict 子行 → `verifier r1` 不出现, 红。
    check(
      await waitFor(p, (t) => t.includes('✗ verifier r1')),
      'DG-15 ★ C-6③ fail 判决子行(✗ verifier r1: reason)',
      p.text().slice(-600),
    );
    check(p.text().includes('✓ judge r1'), 'DG-16 ★ C-6③ pass 判决子行(✓ judge r1)', p.text().slice(-600));
    // ① running 节点活秒数随 render tick 递增。shard-3 只 start 不 settle —— 永远在跑;
    //    缓冲累积所有帧, 取 shard-3 行出现过的最大秒数, 走到 ≥2s 说明 ticker 真的在刷。
    //    证伪: 摘掉 tui.ts 的 syncDagTicker 接线 → 秒数停在第一帧, 本闸红。
    const liveSecs = () =>
      Math.max(0, ...[...p.text().matchAll(/shard-3.{0,80}?(\d+(?:\.\d+)?)s/g)].map((m) => Number(m[1])));
    check(
      await waitFor(p, () => liveSecs() >= 2, 8000),
      'DG-17 ★ C-6① running 节点行活秒数随 render tick 递增(≥2s)',
      p.text().slice(-400),
    );

    p.write('\x07'); // Ctrl+G → 全屏 (画法 0 = 树)
    check(await waitFor(p, (t) => t.includes('now: tree')), 'DG-4 ★ Ctrl+G 进全屏(画法提示可见)', p.text().slice(-400));
    p.write('\t');
    check(await waitFor(p, (t) => t.includes('swimlane gantt')), 'DG-5 ★ Tab 切到泳道甘特', p.text().slice(-600));
    check(p.text().includes('running'), 'DG-6 甘特上有在跑的条(shard-3 没 settle)', p.text().slice(-600));
    p.write('\t');
    check(
      await waitFor(p, (t) => t.includes('layered deps') && t.includes('L0')),
      'DG-7 ★ Tab 再切到分层依赖(L0 层可见)',
      p.text().slice(-600),
    );
    check(p.text().includes('[fan-in]'), 'DG-8 fan-in 汇聚点标出来(shard-3 deps 2 条)', p.text().slice(-600));

    /**
     * ★★ **G-C 的第三句:节点失败看得出是**哪一条**。**
     *
     * goal 契约 `docs/plan/2026-08-07-omd-tui-daily-driver-goal.md` §0 的 G-C 是三句话:
     * 「`/hud` 开左栏 · fan-out 时逐节点变 · **节点失败看得出是哪条**」。
     * 前两句早有闸(DG-2 / S11-3), **第三句一直没有** —— 2026-08-08 复核 G-A…G-G 时发现的。
     *
     * fixture 的演示 run 里 `shard-2` 本来就是 `status:'failed'`(`backend-fixture.ts:140`),
     * 缺的只是断言。
     *
     * ⚠ 判据要的是**指得出是哪一条**, 不是"屏上有个失败字样":
     * ① 失败标记 `✗` 与 `shard-2` 出现在**同一行**;
     * ② **同一行里不许是 `✓`** —— 否则"失败画得和成功一样"照样能过。
     * ⚠ 逐行找而不是整屏 `includes`:整屏两个字符串都在, 而它们**可能分属两行**,
     * 那正是"看不出是哪条"的样子。
     */
    {
      /**
       * ⚠ **这个 oracle 没有"行"**:`visibleText` 把 `\s+` 折叠成一个空格
       * (本文件头写着「剥 ANSI → 折叠空白 → 找子串」)⇒ 按行/按段切都切不出东西,
       * 整块缓冲会当成一段, 于是 `includes` 两个串**都真**而它们可能隔了半屏。
       * **第一版和第二版都栽在这**(第二版的 DG-9c 在证伪注入下照样绿 —— 本仓图鉴 S-26)。
       */
      const t = p.text();
      /**
       * ⚠ 窗口不能开大:折叠之后**相邻行是紧挨着的**, ±24 字符会把邻行 `shard-1` 的 `✓`
       * 收进来(实测:`p ├─✓ shard-1 agent ├─✗ shard-2 agent`)。第三版就栽在这。
       * ⇒ 只看**紧贴在 `shard-2` 前面的 6 个字符** —— 树里是 `├─✗ shard-2`,
       * 底部表里是 `0.0s ✗ shard-2`, 两处标记都落在这 6 个字符内。
       */
      const marks = [];
      for (let k = t.indexOf('shard-2'); k >= 0; k = t.indexOf('shard-2', k + 1)) {
        marks.push(t.slice(Math.max(0, k - 6), k));
      }
      check(
        marks.length > 0 && marks.some((m) => m.includes('✗')),
        'DG-9b ★★ 失败节点指得出是**哪一条**(紧贴 `shard-2` 前面就是 `✗`;G-C 第三句)',
        JSON.stringify(marks.slice(0, 4)),
      );
      check(
        marks.length > 0 && marks.every((m) => !m.includes('✓')),
        'DG-9c ★ 失败那条**没被画成成功**(紧贴它前面不许是 `✓`)',
        JSON.stringify(marks.slice(0, 4)),
      );
    }
    p.write('\t');
    check(await waitFor(p, (t) => t.includes('now: tree')), 'DG-9 Tab 循环回到树');
    p.write('\x07'); // 退出全屏
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    p.kill();
  }
}

/** 场景 4.7:窄终端(80 列)—— 侧栏自动收起,底部表顶上(G-3 后半)。 */
async function scenarioDagNarrow() {
  const p = startTui({ cols: 80 });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'DG-10 (场景4.7) 80 列启动');
    p.write('fixture:dag\r');
    check(await waitFor(p, (t) => t.includes('fan-out demo graph sent')), 'DG-11 演示 run 发完');
    // 底部那张表要回来 (它列节点行) —— 等它先出现, 再断言树没画。
    check(await waitFor(p, (t) => t.includes('shard-1')), 'DG-12 底部表在画节点', p.text().slice(-500));
    check(p.text().includes('├─') === false, 'DG-13 ★ 80 列下侧栏自动收起(树的分支符不出现)', p.text().slice(-500));
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.10:新 slash 命令面 —— `/compact`(6 命令之一, 只测回执形状)。
 *
 * fixture 后端有假压缩 (FIXTURE_COMPACT = 12,000 → 2,400, **不发真 model call**)——
 * 这条 lane 只证明「命令线接得上、回执带压缩前后**两个** token 数」; 压缩行为本身
 * (compactChatMessages / appendCompaction)由 embedded 的 L1 单测钉。
 */
async function scenarioCompact() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'CMP-0 (场景4.10) 启动');
    // 先跑一轮让会话有历史 —— fixture 的假压缩对空会话返回 null(与生产同语义), 回执会走 nothing 分支。
    // 种子消息用普通 `hej` 不用 `fixture:reads`: 后者走的是健康度演示, 回复不是那句 fixture 标准话。
    p.write('hej\r');
    check(
      await waitFor(p, (t) => t.includes('This is the fixture backend')),
      'CMP-0b 一轮跑完(会话有历史, 压缩才有东西可压)',
      p.text().slice(0, 400),
    );
    p.write('/compact\r');
    // 锚 `Compacted` 是**全新串** —— 欢迎屏/底栏/任何 chrome 都没打印过(累积缓冲假绿坑, SET-4 同族)。
    // 判据钉回执**形状**: 会话 id + `~<before> -> ~<after> tokens`, 前后两个数都写。
    // ⚠ 箭头认 ASCII `->` 也认 `→`(实跑: 回执打的是 `~12000 -> ~2400`, 不是契约草稿里的 →);
    //   钉的是「两个数都写」, 不是箭头字形。
    // 不钉具体数值(humanTokens 的 k 格式是渲染细节, L1 钉)。
    // 证伪: 注释掉 tui.ts 的 /compact 分发 → `Compacted` 不出现, 本条红;
    //       回执只写一个数 → 第二个 `~` 匹配不上, 红。
    check(
      await waitFor(p, (t) => /Compacted s-\S+: ~\S+ (?:->|→) ~\S+ tokens/.test(t), 10000),
      'CMP-1 ★ /compact 有回执, 压缩前后两个 token 数都写(来自 backend.compact, 不是屏上编的)',
      p.text().slice(-500),
    );
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.11:新 slash 命令面 —— `/logout`(只测 Esc 取消路径, 零副作用)。
 *
 * ⚠ 真删键走 headless-config 的单测(tmpdir 隔离); 这条 lane **不碰真凭证**。
 * cwd 用临时目录 + env 里一把**假** DEEPSEEK_API_KEY —— 于是 fixture lane 里 deepseek 是已配的,
 * 裸 /logout 必开选单(只列已配); 不设的话选单可能空开, 取消回执打不打印就看实现心情了。
 * 假 key 只活在 PTY env 里, 不落任何盘。
 */
async function scenarioLogout() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-logout-'));
  const p = startTui({ cwd, env: { DEEPSEEK_API_KEY: 'sk-pty-logout-fake' } });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'OUT-0 (场景4.11) 启动');
    p.write('/logout\r');
    // 选单渲染要一拍 —— 不给它时间, Esc 会打在输入框里(SESS-1 的 Esc 同族坑)。
    await new Promise((r) => setTimeout(r, 800));
    p.write('\x1b');
    // 锚 `logout cancelled` / `nothing removed` 都是**全新串**(本仓 chrome 从未打印)。
    // 回执本身就是零副作用证明: 它只在「选单开了 → Esc 取消」这条路上出现。
    // 证伪: 删掉 handleLogout 的 Esc 取消分支(或 Esc 后直接删键) → 回执不出现, 本条红。
    check(
      await waitFor(p, (t) => t.includes('logout cancelled') && t.includes('nothing removed'), 10000),
      'OUT-1 ★ /logout 选单 Esc 取消, 零副作用回执(nothing removed)',
      p.text().slice(-500),
    );
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.12:新 slash 命令面 —— `/status`(只读四行, 读不到写真话)。
 *
 * cwd 用临时目录 + OMD_CONFIG_PATH 指向不存在的文件: 座位未配是这条 lane 的**确定态** ——
 * 不隔离的话真机上的 ~/.omd/config.json 会把 `(no seat configured)` 这个锚变成碰运气
 * (config-discovery 的 repo 边界只护仓内, 护不住 tmpdir)。
 */
async function scenarioStatus() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-status-'));
  const cfg = join(cwd, 'omd-config.json'); // 只用来挡全局 config, 不写它
  const p = startTui({ cwd, env: { OMD_CONFIG_PATH: cfg } });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'ST-0 (场景4.12) 启动');
    const sessionId = (p.text().match(/session\s+(s-\d+-\d+)/) ?? [])[1];
    check(Boolean(sessionId), 'ST-1a 欢迎屏给出本进程会话 id(状态屏锚要用它)', p.text().slice(0, 700));
    p.write('/status\r');
    // 四个锚全是 status 屏**独有**的串: 欢迎屏那行是 `session s-…`(表列分隔是两空格, 无冒号),
    // 底栏压力是 `ctx 6%` —— `session: `(冒号形)、`conductor:`、`context:`、`usage today:`
    // 此前从未打印过(累积缓冲假绿坑, SET-4 同族)。
    // 证伪: 注释掉 handleStatus 接线 → 下面四条全红; 任一行的真话分支被删 → 对应锚红。
    check(
      await waitFor(p, (t) => t.includes('conductor: (no seat configured)'), 10000),
      'ST-1 ★ 座位行: 未配写真话, 不编坐标',
      p.text().slice(-500),
    );
    check(p.text().includes(`session: ${sessionId}`), 'ST-2 ★ 状态行带**当前**会话 id(冒号形, 与欢迎屏那句区分)', p.text().slice(-500));
    check(p.text().includes('context: no turn yet'), 'ST-3 ★ 没跑过轮写真话, 不画编的百分比', p.text().slice(-500));
    check(p.text().includes('usage today:'), 'ST-4 ★ 账本今日用量行在(读数口径走 L1 单测)', p.text().slice(-500));
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.13:新 slash 命令面 —— `/export`(transcript → markdown, 真落盘)。
 *
 * cwd 用临时目录: 缺省导出路径 `.omd/exports/<sessionId>-<ts>.md` 落在 tmpdir,
 * 不许拿仓当草稿纸(scenarioLogRedirect 同纪律)。
 */
async function scenarioExport() {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-tui-export-'));
  const p = startTui({ cwd });
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'EXP-0 (场景4.13) 启动');
    p.write('hej\r'); // 先跑一轮, 导出才有内容可导(种子同 CMP-0b: 普通消息才有 fixture 标准回复)
    check(
      await waitFor(p, (t) => t.includes('This is the fixture backend')),
      'EXP-0b 一轮跑完(transcript 有消息)',
      p.text().slice(0, 400),
    );
    p.write('/export\r');
    // 锚 `Exported` 是**全新串**; 判据钉回执形状: `Exported <n> messages -> /绝对路径`
    // (箭头同 CMP-1: 实跑是 ASCII `->`, `→` 也认)。
    // 证伪: 注释掉 handleExport 接线 → 回执不出现, 本条红。
    check(
      await waitFor(p, (t) => /Exported \d+ messages (?:->|→) \//.test(t), 10000),
      'EXP-1 ★ /export 回执带消息数 + **绝对**路径',
      p.text().slice(-500),
    );
    // ★ 屏幕上说写了不算数 —— 文件系统上真的要有那个 .md(AP-8 同族判据)。
    // 用 waitFor 轮询而不是立刻 readdir: 回执先印、写盘后落的话, 立刻读会竞态假红。
    // 证伪: 注释掉 handleExport 里写盘那一行(回执还在) → 文件闸红。
    let files = [];
    let readErr = null;
    const wrote = await waitFor(
      { text: () => '' },
      () => {
        try {
          files = readdirSync(join(cwd, '.omd', 'exports')).filter((f) => f.endsWith('.md'));
          return files.length >= 1;
        } catch (err) {
          readErr = err.message;
          return false;
        }
      },
      8000,
    );
    check(
      wrote,
      'EXP-2 ★ 导出文件真的落在 .omd/exports/(屏上回执不算数)',
      readErr ? `读 ${join(cwd, '.omd', 'exports')} 失败: ${readErr}` : `实得 ${JSON.stringify(files)}`,
    );
    const body = files.length ? readFileSync(join(cwd, '.omd', 'exports', files[0]), 'utf8') : '';
    check(body.startsWith('# Session '), 'EXP-3 ★ markdown 头是 `# Session <id>`(形状对)', body.slice(0, 60) || '(无文件可读)');
  } finally {
    p.kill();
  }
}
/**
 * 场景 4.5:**思维链上屏**(2026-08-13,owner 原话「思维链也看不到」)。
 *
 * 根因是 `backend-embedded.mapAgentEvent` 只映射了 `text_delta` —— pi 的
 * `thinking_delta` / `thinking_end` 被"转不过来的不发"那条注释顺手吞掉了。
 * fixture 的 `fixture:think` 暗号走**与生产同一条** `chat` 事件通道:
 * 两片 thinking → thinking_end → 一片正文。
 *
 * 判据有两半,少一半都不算修好:
 *   ① 思考真的上屏(此前一个字都没有);
 *   ② 思考与正文**分得开** —— `thinking_end` 收掉思考条目之后正文才另起一条。
 *      不收的话正文会续进思考区,屏上读成"模型把草稿当答案发了"。
 *
 * 反向自检(实跑):把 `mapAgentEvent` 里 `thinking_delta` 那个分支删掉 → TH-1 当场红;
 * 把 `tui.ts` 里 `thinking_end` 那个分支删掉 → TH-3 当场红(正文与思考同在一条)。
 */
async function scenarioThinking() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'TH-0 (场景4.5) 启动');
    p.write('fixture:think\r');
    check(
      await waitFor(p, (t) => t.includes('weighing option A')),
      'TH-1 ★ 思维链真的上屏(此前 thinking_delta 被整个丢掉)',
      p.text().slice(-600),
    );
    check(
      await waitFor(p, (t) => t.includes('against option B')),
      'TH-2 思考分片追加进同一条(两片都在)',
      p.text().slice(-600),
    );
    check(
      await waitFor(p, (t) => t.includes('answer: option B')),
      'TH-3 ★ 正文另起一条 —— thinking_end 收掉思考条目之后才画正文',
      p.text().slice(-600),
    );
    /**
     * ⚠ **「思考与正文分成两条」这条判据不在这一层** —— 这个 oracle 判不了它。
     *
     * `visibleText` 把 `\s+` 归一成单空格(本文件第 56 行),换行**不留痕** ——
     * 于是"在不在同一行"在累积缓冲里恒为真,写成断言只会量到尺子本身
     * (实跑验证过:整屏折叠成一行,横幅与底栏也在同一串里)。
     *
     * 那条判据的正确落点是 L1:`chat-log.test.ts` 的
     * 「思考与正文是**两条**」(`log.length === 2` + `lastText === 'answer'`)与
     * 「不收尾也不会串」。这一层只证明**两段都上了屏**、顺序对。
     */
  } finally {
    p.kill();
  }
}

/**
 * 场景 4.6:**等待指示器活满整轮**(2026-08-11,"你卡住了吗"那单的闸)。
 *
 * 旧行为在首片 delta 时就把指示器收了 —— 正文整段到达的通道(claude-code SDK)上,
 * 两段之间屏幕完全静止,owner 实测第一反应是打一句"你卡住了吗"。
 *
 * 判据用 `Working... <N>s`:这个串**只有**秒计时 ticker 在轮飞着的第 N 秒才会渲染 ——
 * PTY 的 oracle 是累积缓冲,"首片之后指示器还在"没法靠缓冲里有没有基态文案分辨
 * (基态从 submit 那一刻就进缓冲了),但 `Working...` 在旧行为下**永远不会出现**。
 * 反向自检(实跑):把 tui.ts submit 里的 waitTicker 那段注释掉 → WK-2 当场红。
 */
async function scenarioSlowTurnIndicator() {
  const p = startTui();
  try {
    check(await waitFor(p, (t) => bootReady(t)), 'WK-0 (场景4.6) 启动');
    p.write('fixture:slow\r');
    check(await waitFor(p, (t) => t.includes('slow chunk one')), 'WK-1 首片正文上屏', p.text().slice(-300));
    check(
      await waitFor(p, (t) => /Working\.\.\. \d+s/.test(t), 8000),
      'WK-2 ★ 首片之后指示器仍活着(Working... Ns 只在轮飞着的第 N 秒渲染)',
      p.text().slice(-400),
    );
    check(await waitFor(p, (t) => t.includes('slow done')), 'WK-3 慢轮收尾, 正文两片都在', p.text().slice(-300));
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
      await waitFor(p, (t) => bootReady(t), 40000),
      'REAL-1 ★ 真后端(不是 fixture)也起得来',
      p.text().slice(0, 600),
    );
    /**
     * 后端坐标必须是 `embedded://` —— 是 `fixture://` 的话说明环境变量没清干净, 这条就白测了。
     *
     * ⚠ **2026-08-08 判据换了锚点**:footer 不再带 `[后端坐标]`(P1 密度:同一屏 3 次 → 2 次),
     * 坐标现在只在**行①** 上。老判据锚的是 `[embedded://…]` 那个方括号形状,砍掉之后它会红 ——
     * 而这正是想要的:**它是一条真闸,不是随改动一起漂的装饰**。
     * ⚠ 换锚点时**不许顺手放宽**:仍然要求出现 `embedded://`,并**显式要求不出现** `fixture://`
     * (只查前者的话, 两个后端都挂着时它照样绿)。
     */
    check(
      /embedded:\/\/\S+/.test(p.text()) && !p.text().includes('fixture://'),
      'REAL-2 ★ 行①的后端坐标是 embedded://<座位>, 且全程没有 fixture://(证明真走了生产装配)',
      p.text().slice(-300),
    );
    p.write('\x03');
    await waitFor(p, (t) => t.includes('press Ctrl+C again'));
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
await scenarioSkillComplete();
await scenarioPathfinder();
await scenarioTicketBoard();
await scenarioDagViews();
await scenarioDagNarrow();
await scenarioCompact();
await scenarioLogout();
await scenarioStatus();
await scenarioExport();
await scenarioThinking();
await scenarioSlowTurnIndicator();
await scenarioRealBackendBoots();

if (failures.length) {
  console.error(`\n✗ L3 PTY: ${failures.length} 条不过 —— ${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n✓ L3 PTY 全过');
process.exit(0);
