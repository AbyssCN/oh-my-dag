/**
 * noun-gate 的**假阳性**回归(2026-08-21,交接 checkpoint 被机械降级版覆盖两次之后补)。
 *
 * ## 现场
 *
 * writer.log 里三次判词:
 * ```
 * 验真闸 fail (attempt 1): 编造名词(材料与 repo 文件树均未出现,超容差 3):
 *   proc.pid, child_process.spawn, parsed.error, hostProbe, staleSince, rollbackAt
 * 验真闸 fail (attempt 2): 编造名词(...):
 *   omd_runs.error, accept.status, isolation.worktr, first.messag, continuity.repo, omd_runs.conver
 * ```
 *
 * `isolation.worktr` / `first.messag` / `omd_runs.conver` 这几个串**在世界上任何地方都不存在** ——
 * 它们是正则自己截出来的:扩展名写的是 `[a-z]{1,6}`,于是任何属性名 ≥7 个小写字母的
 * `对象.属性` 都被砍成 6 个字符当"文件名"抽走,而截出来的东西**必然**匹配不上 →
 * **必然**判成编造。这是一个按构造产生假阳性的判据。
 *
 * 另一半是误分类:`proc.pid` / `parsed.error` / `verdict.reason` 是属性访问,不是文件名。
 * 本闸问的是「有没有编造**文件**」。
 *
 * ## 为什么这条闸的假阳性比漏判贵
 *
 * 闸红 → writer 回喂重写 1 次 → 再红 → **机械降级**,而降级版的 §1–§9 全是「(无)」,
 * 且原实装会拿它**覆盖**已有的 checkpoint。所以误伤的代价不是"少拦一次",是**把真东西删了**。
 * (覆盖那一半在 writer.ts 一并修了,见那边的注。)
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkNouns } from './noun-gate';

const check = (text: string, material = '') =>
  checkNouns({ text, material, repoRoot: process.cwd(), maxNovel: 3, annotate: false });

describe('noun-gate 假阳性回归 —— 属性访问不是文件名', () => {
  test('★ 长属性名不再被截成"文件名"(first.message 曾变成 first.messag)', () => {
    // 怎么让它红: 把 fileRe 的扩展名改回 `[a-z]{1,6}` → 这几个被截断的串重新出现在 novel 里。
    const r = check('判词取 first.message 而丢了 first.path; 账本读 omd_runs.converged; 执行锚是 continuity.repoRoot。');
    expect(r.novelNouns.join(' ')).not.toContain('messag');
    expect(r.novelNouns.join(' ')).not.toContain('conver');
    expect(r.novelNouns.join(' ')).not.toContain('repoRoot'); // 整段也不该以"文件名"身份进 novel
  });

  test('★ proc.pid / parsed.error / verdict.reason 这类属性访问不当文件名', () => {
    // 它们不含任何已知扩展名 —— 本闸只认文件。
    const r = check('worker 记 proc.pid; zod 的 parsed.error 被丢弃; verdict.reason 进判词。');
    for (const bad of ['proc.pid', 'parsed.error', 'verdict.reason']) {
      expect(r.novelNouns).not.toContain(bad);
    }
  });

  test('★ 真的编造一个文件名 → 仍然抓得住(闸没被改废)', () => {
    // 这条是"修假阳性"的护栏: 别为了不误伤把闸调成永远绿。
    // 怎么让它红: 把 fileRe 整条删掉 → 编造的文件名不再进 novel, 这条红。
    //
    // ⚠ **样本必须运行时生成, 不许写死** (2026-08-22 改, 原先写死的是
    // `another-invented-file.ts`)。已知集加了来源③「按需 `git grep` 查仓内文件内容」之后,
    // 任何写死在仓里的"编造"样本都会**命中它自己所在的这个测试文件** → grounded → 本条恒红。
    // 那不是闸被改废, 是样本失效了 —— **断言一个字没动, 只换夹具**。
    // 反过来说: 恒绿的闸不是闸, 而一个因自指而恒红的用例同样不是闸。
    const invented = `zz${randomUUID().replace(/-/g, '').slice(0, 12)}-invented.ts`;
    const r = check(`见 src/harness/totally-made-up-module.ts 与 ${invented} 的实装。`);
    expect(r.novelNouns.some((n) => n.includes(invented.replace('.ts', '')))).toBe(true);
  });

  test('★ 真实存在的文件名不算编造(正控)', () => {
    const r = check('判据在 noun-gate.ts, 消费者是 writer.ts。');
    expect(r.novelNouns).not.toContain('noun-gate.ts');
    expect(r.novelNouns).not.toContain('writer.ts');
  });

  test('★ 材料里逐字出现过的外部文件名不算编造(闸的本意是防编造, 不是防外部引用)', () => {
    const r = check('照 vendor/some-external-thing.py 的做法。', '…上下文里提过 vendor/some-external-thing.py…');
    expect(r.novelNouns).not.toContain('some-external-thing.py');
  });
});
