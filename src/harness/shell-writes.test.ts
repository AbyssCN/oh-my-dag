/**
 * shell 写目标识别的闸(2026-08-05)。
 *
 * 它服务的是产物闸的**救援**路径:agent 用 bash 写文件时 `filesTouched` 是空的,
 * 闸判 `empty-artifact` 失败 —— 两次真跑两次中招,而活是干完了的。
 *
 * ⚠ **这份网的重点在"不许多认"那一半**。漏认的后果只是照旧判失败(与补这条之前一样);
 * 而多认一个,配上落盘核实仍可能救回一个本该失败的节点 —— 那是把闸拆了。
 * 所以下面负例比正例多,且都是真实命令形状。
 */
import { describe, expect, test } from 'bun:test';
import { shellWriteTargets } from './shell-writes';

const t = (cmd: string): string[] => shellWriteTargets(cmd).sort();

describe('认得出的写形状', () => {
  test('重定向:> / >> / 1> / 2>> / &>', () => {
    expect(t('echo hi > docs/a.md')).toEqual(['docs/a.md']);
    expect(t('cat foo >> docs/b.md')).toEqual(['docs/b.md']);
    expect(t('build 2>> logs/err.txt')).toEqual(['logs/err.txt']);
    expect(t('run &> out.log')).toEqual(['out.log']);
  });

  test('heredoc 写文件(本质还是重定向)', () => {
    expect(t("cat > docs/x.md <<'EOF'\n正文\nEOF")).toEqual(['docs/x.md']);
  });

  test('tee(含 -a)、sed -i、cp/mv、touch', () => {
    expect(t('bun test | tee logs/run.txt')).toEqual(['logs/run.txt']);
    expect(t('echo x | tee -a notes.md')).toEqual(['notes.md']);
    expect(t("sed -i 's/a/b/' src/x.ts")).toEqual(['src/x.ts']);
    expect(t('cp a.md docs/b.md')).toEqual(['docs/b.md']);
    expect(t('mv old.md docs/new.md')).toEqual(['docs/new.md']);
    expect(t('touch docs/c.md')).toEqual(['docs/c.md']);
  });

  test('多段命令逐段认(一条命令可以写好几处)', () => {
    expect(t('echo a > one.md && echo b > two.md')).toEqual(['one.md', 'two.md']);
  });

  test('引号包裹的路径去引号', () => {
    expect(t('echo hi > "docs/with space.md"')).toEqual(['docs/with space.md']);
  });
});

describe('★ 不许多认(多认一个 = 可能救回一个本该失败的节点)', () => {
  test('读不是写:`<` 与管道左边一律不算', () => {
    expect(t('cat < docs/a.md')).toEqual([]);
    expect(t('grep foo docs/a.md | head')).toEqual([]);
    expect(t('bun test | tee logs/x.txt').includes('docs/a.md')).toBe(false);
  });

  test('丢弃到 /dev/null 之类不是产物', () => {
    expect(t('bun test > /dev/null')).toEqual([]);
    expect(t('cmd 2> /dev/null')).toEqual([]);
  });

  test('变量展开 / 通配 → 不猜(展开后才知道)', () => {
    expect(t('echo x > "$OUT"')).toEqual([]);
    expect(t('cat a > out/*.md')).toEqual([]);
  });

  test('选项不是路径', () => {
    expect(t('sed -i -e s/a/b/ --posix src/x.ts')).toEqual(['src/x.ts']);
    expect(t('touch -m')).toEqual([]);
  });

  test('cp/mv 少于两个操作数时不认(单参数不是"复制到")', () => {
    expect(t('cp -v')).toEqual([]);
  });

  test('★ 纯读命令一个都不认(最常见的一类)', () => {
    for (const cmd of ['ls -la src', 'cat README.md', 'git status', 'bun test', 'grep -rn foo src/']) {
      expect(t(cmd), cmd).toEqual([]);
    }
  });
});

describe('已知盲点(明写的边界, 不是漏)', () => {
  test('脚本内部的写认不出 —— 后果是照旧判失败, 不产生新盲点', () => {
    // 这是 agent 最常用的写法之一, 也是这条通道最大的漏口。明写在 SHELL_WRITE_BLIND_SPOTS。
    expect(t("python3 - <<'PY'\nopen('docs/x.md','w').write('hi')\nPY")).toEqual([]);
  });

  test('打补丁认不出(目标在补丁内容里)', () => {
    expect(t('git apply /tmp/p.diff')).toEqual([]);
  });
});
