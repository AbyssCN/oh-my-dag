/**
 * noun-gate grounding 实装测试 —— **第三个来源(仓内文件内容)+ D-4 文件名简称后缀段匹配**
 *
 * 这条闸(S-49)的两个洞:
 *   - 已知集只覆盖 `material` + `git ls-files` 路径,**不读文件内容**;
 *     于是 `MiniMax` 这类只活在 doc/源码里的「产品名/符号」全部进 novelNouns。
 *   - 文件名简称(`next-session.md` vs 真名 `2026-08-22-next-session.md`)
 *     走精确归一化也匹配不上,直接躺平判编造。
 *
 * ## 反向自检(S-49 第二问 · 承重那一位)
 *
 * 承重的是「已知集包不包含仓内内容」,不是正则抽得准不准。自检必须验证:
 *
 *   1. 把 ③ 那一跳换成「永远返回未命中」→ `credentialTmpfsArgs` 那条用例**必须变红**
 *      (这里用的方式是:传一个**非 git** 的 repoRoot,让所有 ③ 调用都失败 →
 *      contentLookupsFailed 被填充 → 候选被 fail-open 当 novel)。
 *   2. 把 D-4 后缀匹配去掉 → `next-session.md` 那条**必须变红**
 *      (覆盖方法: `isFilenameShape` 永远返回 false)
 *      — 我手工跑了一遍这个假设:返回 false 后 `next-session.md` 重新出现在 novel。
 *   3. 「它红的时候是因为什么?」答案里不许出现闸自己算出来的中间量 —— 只准是
 *      「这个词在仓里真的有 / 真的没有」的反向叙述。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkNouns, MAX_GREP_CANDIDATES } from './noun-gate';

const REPO = process.cwd();

/**
 * 局部 check 助手,但**不**把 `undefined` 当默认值 —— 改用 `null` / 不传区分。
 * 默认值(`process.cwd()`)只在显式传入 `false` 时启用;这样 §repoRoot 缺省测试
 * 能精确断言「真的没走 ②③」。
 */
function check(
  text: string,
  opts: {
    material?: string;
    repoRoot?: string;
    useDefaultRepo?: boolean;
    maxNovel?: number;
    annotate?: boolean;
  } = {},
) {
  // 三档:
  //   opts.useDefaultRepo === false → 用 opts.repoRoot(可能是非 git 目录)
  //   opts.useDefaultRepo === true(显式开)→ 退回 REPO(process.cwd())
  //   未提供 useDefaultRepo → 也退回 REPO(legacy 兼容)
  const repoRoot: string | undefined =
    opts.useDefaultRepo === false ? opts.repoRoot ?? undefined : REPO;
  return checkNouns({
    text,
    material: opts.material ?? '',
    repoRoot,
    maxNovel: opts.maxNovel ?? 3,
    annotate: opts.annotate ?? false,
  });
}

describe('noun-gate · 来源 ③ (仓内文件内容)', () => {
  test('★ credentialTmpfsArgs 在仓内容里有,material 无,非文件名 → 不判 novel', () => {
    // 现场见 S-49 §现场:被错判为「编造」的六个词之一,在 src/harness/hooks/shell-sandbox.ts。
    // 让它红的反向自检:repoRoot 传一个非 git 目录(同时阻断 ② 与 ③)→ fail-open 把这条当 novel,
    // 仍报 novelNouns 含 credentialTmpfsArgs。
    const r = check('实装在 src/harness/hooks/shell-sandbox.ts,导出 credentialTmpfsArgs。');
    expect(r.novelNouns).not.toContain('credentialTmpfsArgs');
  });

  test('★ 运行时随机生成一个 camelCase 词(仓内不可能存在) → 仍判 novel', () => {
    // ⚠ 反例词必须运行时生成 —— 写进测试文件就污染仓,`git grep` 永远命中,这条用例恒绿,
    // 恒绿的闸不是闸。2026-08-22 预验时踩过 (`frobnicateWidgetPool`)。
    //
    // ⚠ 数字进 camelCase 会让 `extractCandidateNouns` 的 camelRe 失明(它要求
    // `[a-z]+[A-Z]` 之间不能有数字),所以这里把数字 map 成字母 —— 提一句是因为
    // SDD 里的字面形式 `zz${randomUUID().slice(0,8)}Pool` 本身就是「仓内不存在 +
    // 不被抽出」的盲组合,恒绿(本调用方:本闸不判它 novel,因为它根本没进候选列表)。
    // 这条用例的真值是「**保证被抽出来 + 仓内真的没有**」的反向叙述。
    // 用 randomUUID 的 hex 字母部分(过滤掉 0-9),保证 camelRe `[a-z]+[A-Z]` 能抽出。
    const id = randomUUID()
      .replace(/-/g, '')
      .split('')
      .filter((c) => c >= 'a' && c <= 'f')
      .slice(0, 8)
      .join('');
    const fakeNoun = `zz${id}Pool`;
    // 反向自检:把 ③ 替换成永远命中 → fakeNoun 也不会被判 novel(测试变红),印证 ③ 在起作用。
    const r = check(`测试引入新符号 ${fakeNoun} 用于某个未实现的特性。`);
    expect(r.novelNouns).toContain(fakeNoun);
  });

  test('★ sourcesChecked 把实际查过的三个来源都列出来', () => {
    // 满足 C-3 INV-9:判词要能让人看出「这次确实查了内容」;同时也方便 audit log 区分
    // 「这次没给 material」与「给了但为空」。
    const r = check('查看 credentialTmpfsArgs 的定义。', {
      material: '上下文里提过 credentialTmpfsArgs。',
    });
    expect(r.sourcesChecked).toBeDefined();
    expect(r.sourcesChecked).toContain('material');
    expect(r.sourcesChecked).toContain('repo-file-tree');
    expect(r.sourcesChecked).toContain('repo-file-contents');
  });

  test('★ 没传 material 时 sourcesChecked 仍能区分(只列实际查的)', () => {
    // 不写 material:「材料查过未命中」是误导;必须如实说没查。
    const r = check('查看 credentialTmpfsArgs 的定义。', { material: '' });
    expect(r.sourcesChecked).toBeDefined();
    expect(r.sourcesChecked).not.toContain('material');
    expect(r.sourcesChecked).toContain('repo-file-tree');
    expect(r.sourcesChecked).toContain('repo-file-contents');
  });
});

describe('noun-gate · D-4 文件名简称后缀段匹配', () => {
  test('★ next-session.md 简称 — 真名是 2026-08-22-next-session.md → 不判 novel', () => {
    // 真名带日期前缀,精确归一化不等 → 老路必然判编造。D-4 救场:basename
    // `2026-08-22-next-session.md` 末尾是 `-next-session`(= stem),命中。
    //
    // 反向自检:把 isFilenameShape 永远返回 false → D-4 短路 → next-session.md
    // 重返 novel(我手验过,fail mode 下 novelNouns 含它)。
    const r = check('详见 docs/plan/2026-08-22-next-session.md。', {
      material: '今天写 docs/plan 下的下一程工作文件。',
    });
    expect(r.novelNouns).not.toContain('next-session.md');
  });

  test('★ 后缀匹配只对文件名形状生效(camelCase 形如 getSessionBar 不被通融)', () => {
    // getSessionBar 不是文件名形状(包含大写字母)→ 走精确归一化 → 仓内没有 = novel。
    // 这条是 D-4 的「不放松符号类」的护栏。
    //
    // 反向自检:把 isFilenameShape 改成「恒 true」会让这条红(getSessionBar 被任意
    // suffix 命中),印证形状检查在起作用。
    const r = check('调用 getSessionBar 这个函数。');
    expect(r.novelNouns).toContain('getSessionBar');
  });
});

describe('noun-gate · fail-open 与判词诚实', () => {
  test('★ repoRoot 不传(INV-5) → 行为与今天逐字相同', () => {
    // 没有 repoRoot 时,② 与 ③ 都跳过 → known 只来自 material。等价于「今天」的逻辑。
    // 用 `useDefaultRepo: false` 显式表达「不要 fallback 到 cwd」。
    const text = '提及 credentialTmpfsArgs 与 next-session.md。';
    const a = checkNouns({ text, material: '', maxNovel: 3, annotate: false });
    // 没 repoRoot → sourcesChecked 应是空(本次「什么都没查」就该如实说)。
    expect(a.sourcesChecked ?? []).toEqual([]);
    // credentialTmpfsArgs 与 next-session.md 都没 material(仓内容没看、文件树没看)→ 应被判 novel。
    // 这条不是行为变化的证伪,而是证明「没 repoRoot 就真的没查」不是失效,是显式选择。
    expect(a.novelNouns).toContain('credentialTmpfsArgs');
    expect(a.novelNouns).toContain('next-session.md');
  });

  test('★ repoRoot 是非 git 目录 → ③ fail-open + 留证,不因此多判任何 novel 的「真」', () => {
    // 核心 D-3:闸不该因为工具坏了就误杀。
    //
    // 反向自检:把 ③ 换成「抛错」或「加进 novel」都会让本条用例红 → 现版本行为(留证 + 不
    // 误杀)被钉住。
    //
    // 选词:这是一个**真的**在仓里有的词(shell-sandbox.ts 的 credentialTmpfsArgs),
    //      若 fail-open → 该词**不应**出现在 novelNouns;
    //      而 contentLookupsFailed 里应有它的条目 + 失败原因。
    const tmp = mkdtempSync(join(tmpdir(), 'noun-gate-non-git-'));
    try {
      const r = check('credentialTmpfsArgs 是这次要改的入口。', { repoRoot: tmp, useDefaultRepo: false });
      expect(r.novelNouns).not.toContain('credentialTmpfsArgs');
      // 留证:contentLookupsFailed 至少有一条记录。
      expect(r.contentLookupsFailed && r.contentLookupsFailed.length > 0).toBe(true);
      // sourcesChecked 仍显式包含三个 —— 这次确实「查过」,只是 git 不肯答。
      expect(r.sourcesChecked).toContain('repo-file-contents');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('noun-gate · 封顶 40', () => {
  test('★ MAX_GREP_CANDIDATES = 40(具名常量,不埋在字面量里)', () => {
    // D-2:病态输入不能让闸变成全仓 N 次扫描 → 封顶是契约的一部分。
    // 直接 import 看值,避免字符串搜索「40」造成的脆弱断言。
    expect(MAX_GREP_CANDIDATES).toBe(40);
  });
});

describe('noun-gate · 2026-08-22 六个真词回放', () => {
  // 验收判据 #3:六个全部不再判 novel。
  // 这六个就是 writer.log 8bfaebca 里被闸错杀的全部。
  test('★ session 8bfaebca 被判「编造」的六个词全部回放不判 novel', () => {
    const text = [
      '查 pty-check.mjs 的逻辑。',
      '同步 config.json 的改动。',
      'next-session.md 里写了计划。',
      '编辑器方法 deleteToLineEnd 触发。',
      '另一定界符 deleteWordForward / deleteWordBackward 一起。',
      'MiniMax 是底模名。',
    ].join(' ');
    const r = check(text);
    const novel = new Set(r.novelNouns);
    // 全部六词都不该再被判编造。`pty-check.mjs` 走 D-4(真文件多有 `-pty-check.mjs` / `pty-check.mjs.ts`)
    // 以及 ② 路径段精确匹配;`next-session.md` 走 D-4;其余四个走 ③ `git grep -F`。
    for (const w of [
      'pty-check.mjs',
      'config.json',
      'next-session.md',
      'deleteToLineEnd',
      'deleteWordForward',
      'deleteWordBackward',
      'MiniMax',
    ]) {
      expect(novel.has(w)).toBe(false);
    }
  });
});

