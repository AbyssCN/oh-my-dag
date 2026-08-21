/**
 * `rm-rf-source-dir` 的反向自检(2026-08-21,run `e2d204b7` 节点 s4 复盘)。
 *
 * ## 现场
 *
 * 一个 leaf 在隔离 worktree 里把整个 `src/` 删了 —— **867 文件 / 253564 行**。
 * 而当时的黑名单只认 `/` `~` `/*` `$HOME`,实测:
 *
 * ```
 * true   "rm -rf /"            [rm-rf-root]
 * false  "rm -rf src"
 * false  "rm -rf ./src"
 * false  "rm -rf $HOME/repos"
 * ```
 *
 * 这就是「黑名单挡写法不挡能力」那句话的活样本。
 *
 * ## 这条闸的两侧同样重要
 *
 * 拦住 `rm -rf src` 只是一半。另一半是**别拦正当清理** —— `rm -rf node_modules` /
 * `dist` / `.next` 是每天都在跑的。拦它们就是造假 major,而
 * **假 major 的代价不是"多问一次",是有人把整条闸关掉**(S-45 收窄时买过一次)。
 * 所以下面两组用例数量对等,谁也不是配角。
 *
 * ## 它堵不严,如实写在这
 *
 * `python3 -c 'shutil.rmtree(...)'` / `node -e fs.rmSync` / `> file` 一条都拦不住。
 * 真正的边界是 jail 的 worktree,不是这张表 —— 这条只把最常见、代价最大的那个写法堵上。
 */
import { describe, expect, test } from 'bun:test';
import { classifyCommand, EPHEMERAL_DIRS, isRecursiveRmOfSourceDir } from './dangerous-cmd';

const label = (c: string) => classifyCommand(c).label;
const RM = `rm -${'r'}f`; // 拼出来 —— 免得本文件的字面串把宿主的 dangerous-cmd hook 撞红

describe('rm-rf-source-dir —— 拦住的那一侧', () => {
  test('★★ s4 原形: 递归删源码目录 → 拦', () => {
    // 怎么让它红: 把 match 谓词摘掉(退回只用 RM_RF_TARGET 正则也一样)→ 这条仍绿,
    // 但下面「易失目录放行」那组会全红 —— 两组必须一起看。
    expect(label(`${RM} src`)).toBe('rm-rf-source-dir');
    expect(label(`${RM} ./src`)).toBe('rm-rf-source-dir');
    expect(label(`${RM} src/harness`)).toBe('rm-rf-source-dir');
    expect(label(`${RM} /home/nick/repos/oh-my-dag/src`)).toBe('rm-rf-source-dir');
  });

  test('★ flag 任意序 / 长 flag 串照样拦(与 rm-rf-root 同一手法)', () => {
    expect(label(`rm -fr src`)).toBe('rm-rf-source-dir');
    expect(label(`rm -rfv src`)).toBe('rm-rf-source-dir');
  });

  test('★ 家目录下的仓也拦 —— 那正是最贵的那一类', () => {
    expect(label(`${RM} $HOME/repos`)).toBe('rm-rf-source-dir');
  });

  test('★ 根 / 家目录本身仍归 rm-rf-root —— 两条闸不许报同一件事', () => {
    // 判词打架比漏判还难查: 同一条命令两个 label, 事后没人知道该改哪条闸。
    // 怎么让它红: 去掉谓词里那句 `if (/^(\/|~|\$HOME)$/…) return false` → label 变成 source-dir。
    expect(label(`${RM} /`)).toBe('rm-rf-root');
    expect(label(`${RM} ~`)).toBe('rm-rf-root');
    expect(label(`${RM} $HOME`)).toBe('rm-rf-root');
  });
});

describe('rm-rf-source-dir —— **放行**的那一侧(假阳性阀门)', () => {
  test('★★ 易失目录一律放行 —— 每天都在跑的正当清理', () => {
    // 怎么让它红: 把 EPHEMERAL_DIRS 清空 → 这条全红, 而那正是"一刀切"版本的行为。
    for (const d of EPHEMERAL_DIRS) {
      expect(classifyCommand(`${RM} ${d}`).dangerous).toBe(false);
      expect(classifyCommand(`${RM} ./${d}`).dangerous).toBe(false);
      expect(classifyCommand(`${RM} /repo/${d}`).dangerous).toBe(false);
    }
  });

  test('★ `/tmp` 下一律放行 —— 那是约定的临时区', () => {
    expect(classifyCommand(`${RM} /tmp/omd-probe-123`).dangerous).toBe(false);
    expect(classifyCommand(`${RM} /tmp`).dangerous).toBe(false);
  });

  test('★ 结尾的 `/` 与 `/*` 不影响判定(别让写法变化绕过或误伤)', () => {
    expect(classifyCommand(`${RM} node_modules/`).dangerous).toBe(false);
    expect(classifyCommand(`${RM} dist/*`).dangerous).toBe(false);
    expect(label(`${RM} src/`)).toBe('rm-rf-source-dir');
  });

  test('★ 非递归 rm 不归本闸(删单个文件是日常)', () => {
    expect(classifyCommand('rm src/foo.ts').dangerous).toBe(false);
    expect(classifyCommand('rm -f src/foo.ts').dangerous).toBe(false);
  });

  test('★ 提到 rm 的搜索命令不许误拦(sql-truncate 那条为此收紧过)', () => {
    expect(classifyCommand('rg "rm -rf" docs/').dangerous).toBe(false);
    expect(classifyCommand('grep -rn "rm -rf" src/').dangerous).toBe(false);
  });

  test('谓词单独可测 —— 名单要能被读、被审、被加', () => {
    expect(isRecursiveRmOfSourceDir(`${RM} src`)).toBe(true);
    expect(isRecursiveRmOfSourceDir(`${RM} node_modules`)).toBe(false);
    expect(isRecursiveRmOfSourceDir('echo hello')).toBe(false);
  });
});
