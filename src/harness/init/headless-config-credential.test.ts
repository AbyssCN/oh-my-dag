/**
 * `hasCredential` 与 model 层 `providerCredentialed` 的**判据一致性**闸。
 *
 * ## 这条闸是被一次假告警咬出来的
 *
 * 2026-08-12 `omd_config_status` 同一份输出里自相矛盾:
 *
 * - 座位自检:`conductor claude-code:claude-opus-5 ✓`,「16 座, 0 个不可用」
 * - 同一份的告警:`角色 conductor → claude-code 无凭证 (call 时会抛)`
 *
 * 真调用探针给的定论是**能用**(`claude-code:claude-opus-5` 5864ms 成功)。
 * 即那条告警是假阳性,而它指着的是最贵的两个座位 (conductor / verifier)。
 *
 * ## 根因: 同一个 bug 修过一次, 只修了两份判据里的一份
 *
 * claude-code 是订阅通道 —— 凭证由 Agent SDK 自理 (`~/.claude/.credentials.json` 或
 * `CLAUDE_CODE_OAUTH_TOKEN`), **两个源都不在 `getProvider` / `piHasCredential` 的可见面上**。
 * `model/role-fallback.ts` 的 `credentialed` 为此在 2026-08-10 (issue #6 根因修) 加了
 * `claudeSdkCredentialed` 分支; 而 `harness/init/headless-config.ts` 的 `hasCredential`
 * 是**另一份拷贝**, 没跟着改 —— 同一个盲点原样活着, 只是这次表现为假告警而不是静默降档。
 *
 * ## 反向自检
 *
 * 把 `hasCredential` 里那句 `providerCredentialed(...)` 委派删掉 (回到只查
 * registry / native key / custom key / pi) → ★① ★② ★④ 当场红。
 * ★③「两向」那条**不会**变 —— 它钉的是「没有凭证源时确实报没有」, 修不修都该绿,
 * 故意留着当对照: 没有它, 上面三条可以靠「恒返 true」作弊通过。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasCredential } from './headless-config';
import { providerCredentialed } from '../../model/role-fallback';

const CLAUDE = 'claude-code';

/** 一个只含 `.credentials.json` 的临时 CLAUDE_CONFIG_DIR (SDK 官方 env, 见 role-fallback 注)。 */
function dirWithCreds(): string {
  const d = mkdtempSync(join(tmpdir(), 'claude-cfg-'));
  writeFileSync(join(d, '.credentials.json'), '{}');
  return d;
}

/** 空目录 = 没有任何凭证源 (且不回落到真 homedir)。 */
const emptyDir = (): string => mkdtempSync(join(tmpdir(), 'claude-empty-'));

describe('claude-code 订阅通道的凭证判据: 两处必须说同一句话', () => {
  test('★ `.credentials.json` 在 → hasCredential 认它 (今天红: 只查 registry/env key)', () => {
    const env = { CLAUDE_CONFIG_DIR: dirWithCreds() };
    expect(hasCredential(CLAUDE, env)).toBe(true);
  });

  test('★ CLAUDE_CODE_OAUTH_TOKEN 在 → 同样认 (SDK 的第二个凭证源)', () => {
    const env = { CLAUDE_CONFIG_DIR: emptyDir(), CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
    expect(hasCredential(CLAUDE, env)).toBe(true);
  });

  test('对照 (修不修都该绿): 两个源都没有 → 确实报没有', () => {
    const env = { CLAUDE_CONFIG_DIR: emptyDir() };
    expect(hasCredential(CLAUDE, env)).toBe(false);
  });

  test('★ 一致性: 两份判据在同一个 env 上结论必须相同 (防「再修一份漏另一份」)', () => {
    for (const env of [
      { CLAUDE_CONFIG_DIR: dirWithCreds() },
      { CLAUDE_CONFIG_DIR: emptyDir() },
      { CLAUDE_CONFIG_DIR: emptyDir(), CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    ]) {
      expect(hasCredential(CLAUDE, env)).toBe(providerCredentialed(CLAUDE, env));
    }
  });
});
