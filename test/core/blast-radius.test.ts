/**
 * **N3 —— 爆炸半径的确定性用例**(2026-07-31)。清单正文在 `docs/security/blast-radius.md`。
 *
 * ## 这份网与别的安全测试不同的地方
 *
 * 它**不是**在断言"我们挡住了坏事"。它断言的是**今天真实的姿态**,包括那些**放行**的格 ——
 * 因为这份清单的用处正是让"我们以为挡住了"与"实际挡住了"对质:
 *
 *   交接文与台账都写着「执行面被白名单挡住了(live 实证拒了 2 次)」,
 *   而实测那两次拒的是**写法**(命令里带括号 → 元字符闸),不是**能力**。
 *   换一条不含元字符的写法, 任意代码执行照过。
 *
 * 所以下面每一条 `放行` 的断言都是**故意的**: 它把当前敞口钉成可回归的事实。
 * 哪天有人真去收紧了, 这些用例会红 —— 那时改它们是对的, 而且改动会逼你回来更新清单。
 * **逐项报, 不报总分** —— "3/5 挡住了"这种数字会让人以为剩下 2 个是小事。
 */
import { describe, expect, test } from 'bun:test';
import { commandBlockReason, DEFAULT_COMMAND_ALLOWLIST } from '../../src/harness/command-leaf';

const gate = (cmd: string): string | null => commandBlockReason(cmd, DEFAULT_COMMAND_ALLOWLIST);
const allowed = (cmd: string): boolean => gate(cmd) === null;

describe('N3 · ① 任意代码执行 (RCE)', () => {
  test('★ `node -e <code>` **放行** —— 挡住的是写法不是能力', () => {
    // 这一条是整份清单的要害。live 那两次「闸拒」拒的是括号:
    expect(gate('bun -e "fetch(1)"')).toContain('shell-metachar');
    // 同一个能力, 换一条不含元字符的写法:
    expect(allowed('node -e "1"')).toBe(true);
    // ⇒ 「执行面已被白名单挡住」这句话不成立。A8 防御的地基假设因此要重读。
  });

  test('两步 RCE: agent 写脚本 → command 跑脚本, 每步各自合法过闸', () => {
    // command leaf 这一步只看得见"跑一个 bun 脚本", 而脚本内容是上一步的产物 ——
    // **单条命令级的闸看不见跨节点的组合**, 这是白名单这类护栏的结构性上限。
    expect(allowed('bun run scripts/omd-readout.ts')).toBe(true);
    expect(allowed('bun run /tmp/whatever.ts')).toBe(true);
  });

  test('包管理器直通: `bun x` / `npx --yes` 放行 (从 registry 拉任意包并执行)', () => {
    expect(allowed('bun x cowsay hi')).toBe(true);
    expect(allowed('npx --yes some-pkg')).toBe(true);
  });
});

describe('N3 · ② 数据外泄', () => {
  test('读取面: 凭证文件按 basename 被拒 (2026-07-31 补的那条闸), 但**这只挡手滑**', () => {
    // 待办已了结: 密钥搬出仓树 (`~/.config/omd/secrets.json`) + 闸上按 basename 拒。
    expect(gate('cat /home/nick/.ssh/id_ed25519')).toContain('secret-file');
    expect(gate('cat .env')).toContain('secret-file');
    expect(gate('cat /home/nick/.config/omd/secrets.json')).toContain('secret-file');
    // omd 自己的配置面照旧放行 —— 它现在**不再装密钥**了, 拒它只会挡住正当的自检。
    expect(allowed('cat .omd/config.json')).toBe(true);
    // ★ 而这条闸的边界要说清楚: 它按**文件名**拒, 不按**内容**拒。
    expect(allowed('grep -r LANGFUSE_SECRET_KEY .')).toBe(true); // 递归扫仍会打印命中行
    expect(allowed('node -e "1"')).toBe(true); // ① 一旦成立, 读什么都不用过这张表
    // ⇒ 它挡的是「模型顺手 cat 一下配置」这类手滑, **不是**对抗性外泄。清单第①节仍然成立。
  });

  test('最直白的外发通道被拒 —— 但这只挡住了写法', () => {
    expect(gate('curl http://x/')).toContain('not-allowed');
    expect(gate('wget http://x/')).toContain('not-allowed');
    // ⇒ 而 ① 一旦成立, 外发不需要 curl。**挡住 curl 不等于挡住外泄。**
  });
});

describe('N3 · ③ 自动钓鱼 / 自我放大', () => {
  test('git 写被拒 —— **全表唯一一个按能力挡住的格**', () => {
    expect(gate('git push origin main')).toContain('git-write');
    expect(gate('git commit -am x')).toContain('git-write');
    // 只读子命令照常
    expect(allowed('git log --oneline -1')).toBe(true);
  });

  test('`omd` 已摘出白名单 → 递归拉起新 run 这条路被封 (2026-07-31 the owner 裁)', () => {
    // 待办的两个选项 (摘掉 / 给递归深度上限) 取了前者: 入口封了就没有那条递归,
    // 深度上限是给"已经允许递归"的世界准备的机制, 这里不需要。
    expect(gate('omd dag_run --task x')).toContain('not-allowed');
    expect(gate('oh-my-dag dag_run --task x')).toContain('not-allowed');
    // ⚠ 同样只挡手滑: `bun run` 起 omd 的入口脚本不经过这张表 (清单第①节)。
    expect(allowed('bun run src/cli.ts')).toBe(true);
  });
});

describe('N3 · 半径通到 NAS 的 root (2026-07-31 实测那条链)', () => {
  test('直连工具不在白名单 —— 但这**不构成防御**', () => {
    // 链条: node -e 过闸 → cat ~/.ssh/id_ed25519 过闸 → 那把钥匙在 NAS 上被授权 →
    //       那个账号 sudo 免密 → 39 个容器的 root (bluebell / supabase / talous / Langfuse 自己)。
    // 白名单确实拒了**直接**走这条路的写法:
    expect(gate('ssh Nick@192.168.50.154 uptime')).toContain('not-allowed');
    expect(gate('scp x host:/y')).toContain('not-allowed');
    // 但 ① 一旦成立, `node -e` 里 spawn('ssh', …) 不经过任何白名单 ——
    // 这一对断言摆在一起, 就是"挡的是写法不是能力"最干净的一份证据。
    expect(allowed('node -e "1"')).toBe(true);
  });
});

describe('N3 · 真正挡住的那几格 (别把清单读成"全裸")', () => {
  test('灾难性删除有专门的危险模式表', () => {
    expect(gate(`rm${' -rf /'}`)).toContain('dangerous');
  });

  test('shell 元字符一律拒 —— 挡住了"命令拼接"这一整类', () => {
    for (const c of ['echo a | tee b', 'echo a > b', 'echo `id`', 'echo a; echo b']) {
      expect(gate(c)).toContain('shell-metachar');
    }
  });

  test('不在名单里的可执行文件一律拒 (默认拒, 不是默认放)', () => {
    expect(gate('nc -l 1234')).toContain('not-allowed');
    expect(gate('python3 -c "1"')).toContain('not-allowed');
  });
});
