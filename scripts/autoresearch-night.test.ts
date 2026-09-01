/**
 * scripts/autoresearch-night.test.ts —— t-gate-inmigrate 切片 3:night.sh 变薄的守恒闸。
 *
 * NIGHT_DRYRUN_KEPT —— C-5:闸 0/1/2 的 bash 实现删除后,--dry-run 仍报告点火闸判定
 * (语义不回归,位置从 bash 挪进引擎 ignitionPreflight)。
 *
 * 反向自检(判据力):
 *  · 把 night.sh 里的探针段删掉 → 「dry-run 报告闸判定」用例红(输出不含探针行);
 *  · 把 bash 旧闸加回去(if grep -q '草案…)→ 「零 bash 闸实现」用例红。
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'autoresearch-night.sh');

describe('autoresearch-night 变薄守恒 (NIGHT_DRYRUN_KEPT)', () => {
  test('bash 语法有效', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  test('零 bash 闸实现:旧闸 0/1/2 的判定代码已删', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    // 闸 1 的 bash 判定(grep 草案标记后 die)不在了 —— 标记串只许出现在声明 JSON 里
    expect(text).not.toMatch(/if grep -q '草案/);
    // 闸 2 的 bash 判定(config dump 逐座位比对 + verify-seats 调用)不在了
    expect(text).not.toContain('verify-seats');
    expect(text).not.toContain('conductor 座位不对');
    // 闸 0 的锁判定(kill -0 后 die 5)不在了
    expect(text).not.toContain('已有夜跑在进行');
  });

  test('引擎闸声明与探针在场:preflight.json 生成段 + ignitionPreflight 调用', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('.omd/preflight.json');
    expect(text).toContain('ignitionPreflight');
    expect(text).toContain('seatExpectations');
  });

  test('dry-run 报告点火闸判定(语义不回归;不点火)', () => {
    // 真跑 --dry-run:探针走真引擎件。断言两件事:
    //  ① 输出报告了闸判定(绿或红都算「报告了」—— 语义在场);
    //  ② 退出码 ∈ {0, 2, 4}(0 全绿 / 2 闸红 / 4 阶梯待人),绝不点火(无「已点火」行)。
    const r = spawnSync('bash', [SCRIPT, '--dry-run'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/点火闸探针绿|点火闸红/);
    expect([0, 2, 4]).toContain(r.status ?? -1);
    expect(out).not.toContain('已点火 pid');
  });
});
