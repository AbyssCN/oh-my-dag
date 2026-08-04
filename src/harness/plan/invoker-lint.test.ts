/**
 * t4 (交接 18 §六.1) — invokedBy 声明质量闸 + BLOCKED fork 铸造契约。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintInvokerDeclarations } from './invocation-facts';

const withConfig = (invokedBy: Record<string, string>): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'inv-lint-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'config.json'), JSON.stringify({ invokedBy }));
  return cwd;
};

describe('lintInvokerDeclarations (声明糊了链就断)', () => {
  test('过短声明与无机制信号声明都被点名; 合格声明通过', () => {
    const cwd = withConfig({
      'scripts/report.ts': '会被执行', // 过短且零信息
      'src/mailer/': '这个模块的产物很重要, 大家都在用它没错', // 够长但无机制词
      'scripts/nightly.ts': '生产 crontab 每晚 02:00 执行 (root 的 crontab -l 可核)', // 合格
      'src/ci-gate.ts': 'CI workflow release.yml 在 tag push 时跑它', // 合格
    });
    const bad = lintInvokerDeclarations(cwd);
    expect(bad.map((b) => b.prefix).sort()).toEqual(['scripts/report.ts', 'src/mailer/']);
    expect(bad.find((b) => b.prefix === 'scripts/report.ts')!.problem).toContain('过短');
    expect(bad.find((b) => b.prefix === 'src/mailer/')!.problem).toContain('机制信号');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('无 config / 无 invokedBy 段 → 空 (不误报)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'inv-lint-'));
    expect(lintInvokerDeclarations(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});
