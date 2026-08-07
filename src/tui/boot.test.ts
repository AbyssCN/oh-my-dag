/**
 * 启动失败翻译层的判据(S-4b)。
 *
 * ⚠ 这几条钉的是"用户在新仓里见到的第一屏"。实测撞过:接上手之后在空仓里跑,
 * 屏幕是 `role-models.ts:433` 的行号和 `^` 指针 —— 抛得对,但那不是给人看的。
 */
import { describe, expect, test } from 'bun:test';
import { classifyBootFailure, formatBootFailure } from './boot';

class SeatUnresolvedError extends Error {
  override name = 'SeatUnresolvedError';
}

describe('启动失败的分类', () => {
  test('按 name 认得出座位未配', () => {
    expect(classifyBootFailure(new SeatUnresolvedError('随便什么话'))).toBe('seat-unresolved');
  });

  // ★ 错误跨了动态 import 边界之后 instanceof / name 未必还在 —— 只认一种的话,
  //   换个抛法这一层就静默退化成 unknown, 而症状是"又开始吐堆栈了"。
  test('★ name 丢了也要按 message 认出来', () => {
    expect(classifyBootFailure(new Error("[omd/model] 座位 'conductor' 未配模型 —— 无 config.models"))).toBe('seat-unresolved');
  });

  test('认不出的就说认不出, 不猜', () => {
    expect(classifyBootFailure(new Error('ECONNREFUSED'))).toBe('unknown');
    expect(classifyBootFailure('一个裸字符串')).toBe('unknown');
  });
});

describe('给用户的那几行', () => {
  // 反向自检 (实跑): 把 formatBootFailure 里的 raw 拼接删掉 → 这条当场红。
  test('★ 引擎原话一字不改地带着 —— fail-open 可以吞异常, 不许吞证据', () => {
    const raw = "[omd/model] 座位 'conductor' 未配模型 —— 无 config.models['conductor']";
    expect(formatBootFailure(new SeatUnresolvedError(raw), '/tmp/x')).toContain(raw);
    expect(formatBootFailure(new Error('ECONNREFUSED'), '/tmp/x')).toContain('ECONNREFUSED');
  });

  test('★ 说出是哪个仓 —— 座位逐仓配, 不说仓等于没说', () => {
    expect(formatBootFailure(new SeatUnresolvedError('x'), '/tmp/some-repo')).toContain('/tmp/some-repo');
  });

  test('★ 给的是能直接敲的命令, 不是"请配置一下"', () => {
    const out = formatBootFailure(new SeatUnresolvedError('x'), '/tmp/x');
    expect(out).toContain('omd init');
    expect(out).toContain('omd models auto');
  });

  test('认不出的失败不硬套座位那套话术', () => {
    const out = formatBootFailure(new Error('ECONNREFUSED'), '/tmp/x');
    expect(out).not.toContain('omd models auto');
  });
});
