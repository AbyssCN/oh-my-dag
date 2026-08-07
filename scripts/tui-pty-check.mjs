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
 * 证明:UI 循环起得来 · 真 pi-tui 渲染出东西 · 按键收得到 · Ctrl+C 两次**干净退出**。
 * **不证明**:引擎行为、真模型、会话持久化、DAG 执行 —— 这一片的后端是 stub,
 * 它自己写着 `stub://engine-not-wired`。拿这条 lane 声称别的,就是本仓 S-1 那一族。
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src/harness/cli.ts');
const BUN = process.env.BUN_PATH ?? 'bun';

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

function startTui() {
  const pty = spawn(BUN, ['run', CLI, 'tui'], {
    name: 'xterm-256color',
    // 尺寸锁死:不锁的话不同机器折行位置不同, 断言就成了碰运气 (SDD §9「锁死环境」)。
    cols: 100,
    rows: 30,
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', OMD_INSTALL_SKILLS: '0' },
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
    // stub 串是刻意断言的: 它一旦变成别的, 说明有人在 S10 之前偷偷接了个假后端。
    check(p.text().includes('stub://engine-not-wired'), 'S2-2 footer 说出自己没接引擎(断链说明卡, 零假数据)');

    p.write('hej');
    check(await waitFor(p, (t) => t.includes('> hej')), 'S2-3 按键有回显', p.text().slice(0, 200));

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
    p.write('x');
    check(await waitFor(p, (t) => t.includes('> x')), 'S2-8 打字解除预备并回显');
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

selfTestOracle();
await scenarioHappyPath();
await scenarioArmReset();

if (failures.length) {
  console.error(`\n✗ L3 PTY: ${failures.length} 条不过 —— ${failures.join(' / ')}`);
  process.exit(1);
}
console.log('\n✓ L3 PTY 全过');
process.exit(0);
