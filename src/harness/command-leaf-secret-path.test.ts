/**
 * 凭证文件路径拒 —— 白名单管「哪个 bin」, 这张表管「读的是什么」。
 *
 * 为什么单立一个测试文件: 这条闸的判据不在 bin 上, 一旦被后来人当成"白名单的一个特例"
 * 合并回去就会跟着白名单一起被放宽。它的失效方式是**静默的**(密钥照读, 没有红) ——
 * 所以要有一个直接问"`cat .env` 过不过闸"的用例站在这儿。
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_COMMAND_ALLOWLIST, commandBlockReason, secretPathInCommand } from './command-leaf';

const blocked = (cmd: string): string | null => commandBlockReason(cmd, DEFAULT_COMMAND_ALLOWLIST);

describe('凭证文件拒 — 放行 cat 不等于放行 cat .env', () => {
  test('仓根 .env 读不出来 (今天里面有 6 个 provider key + 一个 OAuth token)', () => {
    expect(blocked('cat .env')).toContain('blocked secret-file');
    expect(blocked('cat ./.env')).toContain('blocked secret-file');
    expect(blocked('grep -n DEEPSEEK_API_KEY .env')).toContain('blocked secret-file');
    expect(blocked('cat .env.local')).toContain('blocked secret-file');
  });

  test('凭证落点与 pi/claude 的凭证文件同样拒 (判据是 basename, 不是写法)', () => {
    expect(blocked('cat /home/nick/.config/omd/secrets.json')).toContain('blocked secret-file');
    expect(blocked('jq . ~/.pi/agent/auth.json')).toContain('blocked secret-file');
    expect(blocked('cat ../../.claude/.credentials.json')).toContain('blocked secret-file');
  });

  test('&& 链上的任何一环都算 (fail-closed: 合法头环不能给尾环带路)', () => {
    expect(blocked('ls -la && cat .env')).toContain('blocked secret-file');
  });

  test('样例/模板放行 —— 它们生来就是给人读的, 拒了只会让验证叶白挂', () => {
    expect(blocked('cat .env.example')).toBeNull();
    expect(blocked('cat .env.sample')).toBeNull();
  });

  test('不误伤同名近似物 (判据要窄到只咬凭证文件)', () => {
    expect(blocked('cat src/model/env.ts')).toBeNull();
    expect(blocked('cat docs/environment.md')).toBeNull();
    expect(blocked('cat package.json')).toBeNull();
    // 首 token 本身不参与匹配 —— 它是 bin, 由白名单管。
    expect(secretPathInCommand('.env')).toBeNull();
  });

  test('拒因指名道姓说出是哪个文件 (拒因说的是哪一层, 不许让人猜)', () => {
    expect(blocked('cat .env')).toContain('.env');
    expect(secretPathInCommand('cat foo/.env')).toBe('foo/.env');
  });
});
