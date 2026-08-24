/**
 * S-50 的**跨实现一致性闸** —— 「同一条判据在仓里有两处实现,只有不判生死的那处被修对了」。
 *
 * ## 为什么是源码结构闸而不是行为测试
 *
 * S-50 的病灶不是某个函数算错了, 是**同一个语义落了多处实现**, 而它们只在**非默认路径**上分叉
 * (隔离 worktree + 主干绝对路径)。行为测试只能证明"今天这几处是对的", 证明不了"明天没人再内联一处"。
 * 而再内联一处的代价是: 默认路径全绿, 分叉只在 `branchStrategy:'branch'` 下发生 ——
 * 那正是覆盖最薄的一条路。
 *
 * 图鉴里那条抓法原文是「修一处路径解析时, 先 grep 同一语义的其他实现点」。**grep 是人做的动作,
 * 会忘。** 这份把它变成一条会红的断言。
 *
 * ## 判据(刻意窄)
 *
 * `engine.ts` 里 `hashArtifact(` 的实参**不许**是内联的 `x.startsWith('/') ? … : …` 三元 ——
 * 绝对路径怎么锚回 run 产物根, 只许走 `resolveArtifactPath`。
 *
 * 窄在哪(写明, 免得它被当成万能闸):
 * - 只管 `hashArtifact` 这一个消费者。`existsSync` / `readFileSync` 那几处**不在射程内** ——
 *   图鉴逐条核过, `:806`(读文件那处)的失败方向是安全的: 读不到会如实写进视图, 不是悄悄跳过。
 * - 只扫 `engine.ts`。别的文件真需要时另开一条, 不在这里装一个扫全仓的大网。
 * - 正则判的是**文本形状**不是 AST。有人把三元拆成两行 if 就绕过去了 —— 那时这条闸失效而不报,
 *   属于它自己的已知上限。写在这儿,不假装它是完备的。
 *
 * ## 反向自检
 *
 * 把 `engine.ts` 里任一处 `hashArtifact(resolveArtifactPath(...))` 改回内联三元 → 本条必红。
 * 同时配一个**该绿时不红**的样本: 当前盘上的 `engine.ts` 必须是绿的。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ENGINE = join(import.meta.dir, 'engine.ts');

/** 取出所有 `hashArtifact(` 的实参文本(到配平的右括号为止)。 */
export function hashArtifactArgs(src: string): { line: number; arg: string }[] {
  const out: { line: number; arg: string }[] = [];
  const needle = 'hashArtifact(';
  let i = src.indexOf(needle);
  while (i !== -1) {
    // 跳过 import / 定义本身
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const lineHead = src.slice(lineStart, i);
    if (!/^\s*(import|export function|\*)/.test(lineHead)) {
      let depth = 1;
      let j = i + needle.length;
      while (j < src.length && depth > 0) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      out.push({ line: src.slice(0, i).split('\n').length, arg: src.slice(i + needle.length, j - 1) });
    }
    i = src.indexOf(needle, i + needle.length);
  }
  return out;
}

/** 实参里是不是内联了「绝对路径判断」—— 这正是 S-50 那三处的形状。 */
export function hasInlineAbsBranch(arg: string): boolean {
  return /startsWith\(\s*['"]\/['"]\s*\)\s*\?/.test(arg);
}

describe('S-50 跨实现一致性: 产物路径解析只许一处实现', () => {
  const src = readFileSync(ENGINE, 'utf8');

  test('该绿时不红: 当前 engine.ts 里没有一处 hashArtifact 内联绝对路径三元', () => {
    const offenders = hashArtifactArgs(src).filter((a) => hasInlineAbsBranch(a.arg));
    expect(
      offenders.map((o) => `engine.ts:${o.line} → hashArtifact(${o.arg.slice(0, 80)})`),
    ).toEqual([]);
  });

  test('确实扫到了东西 —— "0 个违规"要能和"0 个调用点"分开 (仓规坑①)', () => {
    // 扫不到调用点时上一条也会绿, 那是一条永远绿的闸。这里钉住分母。
    expect(hashArtifactArgs(src).length).toBeGreaterThanOrEqual(5);
  });

  test('会红: 把实参改回内联三元 → 判据当场命中', () => {
    const injected = `const h = hashArtifact(p.startsWith('/') ? p : join(root, p));`;
    const found = hashArtifactArgs(injected).filter((a) => hasInlineAbsBranch(a.arg));
    expect(found).toHaveLength(1);
  });

  test('该绿时不红: 走 helper 的同形样本不命中', () => {
    const ok = `const h = hashArtifact(resolveArtifactPath(p, { root, repoRoot }));`;
    expect(hashArtifactArgs(ok).filter((a) => hasInlineAbsBranch(a.arg))).toEqual([]);
  });

  test('嵌套括号不截断实参 —— 否则内联三元藏在内层调用里会被漏掉', () => {
    const nested = `hashArtifact(join(a, b.startsWith('/') ? b : c))`;
    const args = hashArtifactArgs(nested);
    expect(args).toHaveLength(1);
    expect(hasInlineAbsBranch(args[0]!.arg)).toBe(true);
  });
});
