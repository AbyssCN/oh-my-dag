/**
 * `withPipefail` —— 管道退出码旋钮(2026-08-16,#145 附录)。**默认关**,这是一次可对照的实验。
 *
 * 现场:run D 的 `final_review` 发现 `cmd 2>&1 | tail -5` 之后 `$?` 拿到的是 `tail` 的退出码 ——
 * 一条失败的验证命令看起来是绿的。**退出码错了会直接造成假绿,让"闸通过"本身不可信。**
 *
 * ⚠ 但它是**行为翻转**不是补漏(`cmd | head -3` 在 pipefail 下会因 SIGPIPE 变红,而那是假红),
 * 所以先做成旋钮让两臂可跑,不改默认。判据与四要素写在 `withPipefail` 的注里。
 */
import { describe, expect, test } from 'bun:test';
import { withPipefail } from './agent-tools';

describe('withPipefail', () => {
  test('★ 默认关 → 命令逐字不变(零回归)', () => {
    // 怎么让它红: 把 early return 删掉 → 每条命令都被包一层, 默认行为当场变。
    expect(withPipefail('bun test', {})).toBe('bun test');
    expect(withPipefail('bun test', { OMD_BASH_PIPEFAIL: '0' })).toBe('bun test');
    expect(withPipefail('bun test', { OMD_BASH_PIPEFAIL: 'true' })).toBe('bun test'); // 只认 '1'
  });

  test('开了才包, 且原命令原样在尾', () => {
    const out = withPipefail('tsc --noEmit | tail -5', { OMD_BASH_PIPEFAIL: '1' });
    expect(out).toEndWith('tsc --noEmit | tail -5');
    expect(out).toContain('set -o pipefail');
  });

  test('★ 探测必须 fail-open —— shell 不支持 pipefail 也不许把命令弄坏', () => {
    // 命令串最终落到 pi 的 env.exec, **用的是哪个 shell 我们不掌握**(dash 不支持 pipefail,
    // 它会报错并返回非 0)。怎么让它红: 去掉 `2>/dev/null || true` → dash 上整条命令当场失败。
    const out = withPipefail('echo hi', { OMD_BASH_PIPEFAIL: '1' });
    expect(out).toContain('2>/dev/null');
    expect(out).toContain('|| true');
  });

  test('★ 用 `{ }` 不用 `( )` —— 子 shell 里设的选项传不到正文', () => {
    // 怎么让它红: 把 `{ }` 换成 `( )` → 语法仍合法、测试仍绿, 但 pipefail 对正文**毫无作用**,
    // 于是整个旋钮变成一个安静的空转。这条钉的就是那种"看起来接上了"的失效。
    const out = withPipefail('a | b', { OMD_BASH_PIPEFAIL: '1' });
    expect(out.startsWith('{ ')).toBe(true);
    expect(out.startsWith('( ')).toBe(false);
  });
});
