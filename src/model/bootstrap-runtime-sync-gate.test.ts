/**
 * 模型运行时引导的**同步调用闸** (2026-08-03)。
 *
 * ## 它守的那一条(很窄,故意的)
 *
 * `bootstrapModelRuntime()` 是同步函数,返回注册成功的 provider 名数组。调用点不许把
 * `await` 直接写在它前面;那会把同步契约伪装成异步,也让后来读代码的人误判这里需要等待。
 *
 * 扫描面是 `scripts/` 与 `src/` 下递归找到的全部 TypeScript 源码,测试文件也在内。
 * 本闸自己不豁免:文件里的反向样例动态拼出,避免样例本身成为违规命中。
 *
 * ## 判据的诚实边界
 *
 * 查的是**文本源码形状**,不是语义分析。它只认 `await` 后仅隔空白就出现目标调用的形状;
 * 不解析 AST、不追踪别名,也不知道同名局部函数是不是本模块导出的实现。反过来,注释或字符串
 * 真写出同一形状也会被抓 —— 这是刻意保持的窄边界,不是对程序运行行为的完整证明。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');
const ROOTS = [join(REPO, 'scripts'), join(REPO, 'src')];
const BOOTSTRAP_NAME = ['bootstrap', 'ModelRuntime'].join('');
const AWAITED_BOOTSTRAP = new RegExp(String.raw`\bawait\s+${BOOTSTRAP_NAME}\s*\(`, 'g');

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsFiles(path, acc);
    else if (path.endsWith('.ts')) acc.push(path);
  }
  return acc;
}

function matchingLines(source: string): number[] {
  return [...source.matchAll(AWAITED_BOOTSTRAP)].map((match) => source.slice(0, match.index!).split('\n').length);
}

describe('模型运行时引导保持同步调用', () => {
  test('递归扫描 scripts/ 与 src/,同步引导调用前没有 await', () => {
    const files = ROOTS.flatMap((root) => tsFiles(root));
    expect(files.length).toBeGreaterThan(300); // 路径漂了不能静默空跑。

    const hits = files.flatMap((file) =>
      matchingLines(readFileSync(file, 'utf8')).map((line) => `${relative(REPO, file)}:${line}`),
    );
    expect(
      hits,
      `同步的 ${BOOTSTRAP_NAME}() 被 await 了:\n  ${hits.join('\n  ')}\n修法:删除调用前的 await。`,
    ).toEqual([]);
  });

  test('反向自检: matcher 接受等待调用,拒绝直接调用 (闸不是恒真式)', () => {
    const directCall = `${BOOTSTRAP_NAME}();`;
    const awaitedCall = ['await', directCall].join(' ');
    expect(matchingLines(awaitedCall)).toHaveLength(1);
    expect(matchingLines(directCall)).toHaveLength(0);
  });
});
