/**
 * shell 写目标识别的闸(2026-08-05)。
 *
 * 它服务的是产物闸的**救援**路径:agent 用 bash 写文件时 `filesTouched` 是空的,
 * 闸判 `empty-artifact` 失败 —— 两次真跑两次中招,而活是干完了的。
 *
 * ⚠ **这份网的重点在"不许多认"那一半**。漏认的后果只是照旧判失败(与补这条之前一样);
 * 而多认一个,配上磁盘核实仍可能救回一个本该失败的节点 —— 那是把闸拆了。
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

// ── ⑥ 脚本内部的写 (2026-08-05: 从"已知盲点"收窄成"认得出") ─────────────────────
//
// 这曾是这条通道最大的漏口: agent 最常用的写法之一, 写完了却被判 empty-artifact (真误杀,
// 不是判词问题)。收窄的前提是**安全性质一个字没放宽** —— 产的仍只是候选, 调用方仍要求
// 盘上存在 + mtime 在本节点窗口内。
//
// 证伪 (立闸时跑过): 拿掉 INLINE_SCRIPT_WRITES 那个循环 → 下面 ★ 那四条当场红;
// 把 python 那条的模式串判据 `[wax]` 去掉 → 「只读的 open 不认」当场红 (那条才是真正
// 守住"不多认"的闸 —— 反例形状必须落在 open() 上, 不能拿 `cat` 之类根本不产候选的命令充数)。
describe('⑥ 脚本内部的写 —— 认得出, 但只认带写指示器的', () => {
  test('★ python heredoc: open(f, "w")', () => {
    expect(t("python3 - <<'PY'\nopen('docs/x.md','w').write('hi')\nPY")).toEqual(['docs/x.md']);
  });

  test('★ python: Path(f).write_text / 追加模式 / 二进制模式', () => {
    expect(t('python3 -c "from pathlib import Path; Path(\'out/a.md\').write_text(x)"')).toEqual(['out/a.md']);
    expect(t("python3 - <<'PY'\nopen('log/b.txt','a').write('x')\nPY")).toEqual(['log/b.txt']);
    expect(t("python3 - <<'PY'\nopen('bin/c.dat','wb').write(b'')\nPY")).toEqual(['bin/c.dat']);
  });

  test('★ node/bun: writeFileSync / Bun.write / 反引号字面量', () => {
    expect(t('bun -e "writeFileSync(\'src/gen.ts\', code)"')).toEqual(['src/gen.ts']);
    expect(t('bun -e "await Bun.write(`docs/y.md`, s)"')).toEqual(['docs/y.md']);
  });

  test('★ **只读的 open 不认** —— 判据挂在模式串上, 不挂在"引号里像路径"上', () => {
    // 这条是"不多认"那一半的闸。多认一个读路径的后果: 并发扇出下另一个 leaf 恰好写过它,
    // 就会把一个 empty-done 洗成成功 —— 那正是这道闸唯一要拦的东西。
    expect(t("python3 - <<'PY'\ndata = open('docs/src.md').read()\nPY")).toEqual([]);
    expect(t("python3 - <<'PY'\nopen('docs/src.md','r').read()\nPY")).toEqual([]);
    expect(t("python3 - <<'PY'\nopen('docs/src.md','rb').read()\nPY")).toEqual([]);
  });

  test('读一个写一个 —— 只认写的那个', () => {
    expect(t("python3 - <<'PY'\ns = open('a.md').read()\nopen('b.md','w').write(s)\nPY")).toEqual(['b.md']);
  });

  test('变量/模板展开仍然不猜(与 ①~⑤ 同一条口径)', () => {
    expect(t('bun -e "writeFileSync(`${dir}/x.md`, s)"')).toEqual([]);
    expect(t("python3 - <<'PY'\nopen(target,'w').write('x')\nPY")).toEqual([]); // 非字面量, 不匹配
  });
});

describe('已知盲点(明写的边界, 不是漏)', () => {
  test('没覆盖到的脚本写调用仍认不出 —— 后果是照旧判失败, 不产生新盲点', () => {
    // 收窄 ≠ 消失: 只列了四种最常用的调用, shutil / os.rename 之类照旧认不出。
    expect(t("python3 - <<'PY'\nimport shutil; shutil.copy('a.md','b.md')\nPY")).toEqual([]);
  });

  test('打补丁认不出(目标在补丁内容里)', () => {
    expect(t('git apply /tmp/p.diff')).toEqual([]);
  });
});
