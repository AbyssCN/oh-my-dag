/**
 * 臂可见题面的**泄题闸**(2026-08-05)。
 *
 * ## 它钉的是一条已经发生过的事
 *
 * `*-task.md` 里混着给人看的夹具注记(答案清单在哪个文件 / 参考答案的 commit hash /
 * 防泄题登记),而 harness 是整份读进去当 prompt 的 —— 于是注记逐字进了臂的视野。
 * **四份题面全中**,其中 f1 那条最难看:它把参考答案的 40 位 git 对象 id 连同
 * 「**不许给臂看**」这句话一起交给了臂。记忆里记着实测后果:有跑真去 `cat` 了被点名的清单。
 *
 * 「跨对互读答案」那条通道 2026-08-04 已堵(答案移出仓树),这条是**同一形态的另一条** ——
 * 只堵一条等于没堵。所以这份网不是查"我这次改对没有",是**守住往后每一次新题面**。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armVisibleTaskText, readArmVisibleTask, HARNESS_NOTE_SENTINEL, LEAK_PATTERNS } from './task-text';

const DIR = join(import.meta.dir);
const TASKS = readdirSync(DIR).filter((f) => f.endsWith('-task.md'));

describe('切法本身', () => {
  test('哨兵之后的内容全部切掉(含哨兵那一行)', () => {
    const raw = `题面第一行\n\n${HARNESS_NOTE_SENTINEL}\n> 答案在 x-checklist.ts`;
    expect(armVisibleTaskText(raw)).toBe('题面第一行');
  });

  test('没有哨兵 → 整份都给臂(老题面照常工作)', () => {
    expect(armVisibleTaskText('就是一道题')).toBe('就是一道题');
  });

  test('哨兵在首行 → 臂可见为空(不抛)', () => {
    expect(armVisibleTaskText(`${HARNESS_NOTE_SENTINEL}\n注记`)).toBe('');
  });
});

describe('★ 每一份题面的臂可见部分都不许泄题', () => {
  test(`共 ${TASKS.length} 份题面`, () => {
    expect(TASKS.length).toBeGreaterThan(0); // 一份都没扫到 = 这条闸是空转的
  });

  for (const f of TASKS) {
    test(`${f} 臂可见部分干净`, () => {
      const visible = readArmVisibleTask(join(DIR, f));
      const hits = LEAK_PATTERNS.filter((p) => p.re.test(visible)).map((p) => p.name);
      expect(hits, `${f} 臂可见文本命中泄题词表: ${hits.join(', ')}`).toEqual([]);
    });
  }

  for (const f of TASKS) {
    test(`⚠ ${f} 的防泄题登记还在(是**切掉**了,不是删没了)`, () => {
      // 切法若退化成"整份返回", 上面那条会红; 但若有人图省事**把注记直接删掉**, 上面也会绿 ——
      // 而那丢掉的是防泄题登记本身。所以反过来查原文, 且**逐份查**:
      // ⚠ 第一版写成"至少有一份带注记就算过", 实测删掉 f2 那份**照样全绿** —— 一条太松的
      //   反向自检, 与没有反向自检的区别只是让人更放心。
      const raw = readFileSync(join(DIR, f), 'utf8');
      expect(raw, `${f} 没有夹具注记段 —— 新题面也要显式登记"答案键在哪、臂不许看什么"`).toContain(
        HARNESS_NOTE_SENTINEL,
      );
      const noteBlock = raw.slice(raw.indexOf(HARNESS_NOTE_SENTINEL) + HARNESS_NOTE_SENTINEL.length);
      expect(noteBlock.trim().length, `${f} 哨兵之后是空的`).toBeGreaterThan(0);
    });
  }
});

describe('词表本身认得出它当初漏掉的那几种', () => {
  const leaks = (s: string): string[] => LEAK_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name);

  test('评分件名 / git 对象 id / 自指注记', () => {
    expect(leaks('核实清单预制于 f2-checklist.ts')).toContain('scoring-artifact');
    expect(leaks('预埋失效点清单在 g2-registry.ts')).toContain('scoring-artifact');
    expect(leaks('快照 = `428dd3e044857f644ca95839d0b6ecfe28d49c0c`')).toContain('git-object-id');
    expect(leaks('参考答案, **不许给臂看**')).toContain('self-referential-note');
  });

  test('正常题面不误伤', () => {
    expect(leaks('阅读 docs/reference/ 下的 10 篇论文全文, 每题一句话并给出处。')).toEqual([]);
    expect(leaks('输出格式: 每行 `qN: <一句话回答> (来源: <文件名>)`。')).toEqual([]);
  });
});
