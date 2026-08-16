/**
 * 「简报照假想状态写」的判据(#145 附录 §9.5)。
 *
 * 红样本取自真实现场:`VoiceCommandScreen.tsx` 的代码早已换成 token,而同文件的文件头简报
 * 仍写着裸 hex —— 终审验了**代码**干净,没交叉核**声称**。
 *
 * 三级分开测,因为它们**出口不同**:L1/L2 判红(零误报),L3 只报不判(会误报)。
 */
import { describe, expect, test } from 'bun:test';
import { checkClaimAnchors, isBlockingLevel, L3_REVIEW_AFTER } from './claim-anchor';

const ROOT = '/repo';
const files: Record<string, string> = {
  '/repo/src/VoiceCommandScreen.tsx': ['import x;', 'const a = light.primarySoft;', 'const b = dark.primary;'].join('\n'),
};
const read = (p: string): string | null => files[p] ?? null;

describe('L1 路径存在 / L2 行号 —— 判红那两级', () => {
  test('★ L1: 点名的路径不在盘上', () => {
    // 怎么让它红: 把 L1 那段 push 删掉 → 声称一个不存在的文件也不报。
    const v = checkClaimAnchors('详见 `src/nope/Missing.tsx:12`', { root: ROOT, readFile: read });
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L1-path');
  });

  test('★ L2: 行号指到文件之外(纯算术, 不可能误报)', () => {
    const v = checkClaimAnchors('见 src/VoiceCommandScreen.tsx:999 那段', { root: ROOT, readFile: read });
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L2-line');
    expect(v[0]!.message).toContain('只有 3 行');
  });

  test('绿: 行号在范围内 → 不报', () => {
    expect(checkClaimAnchors('见 src/VoiceCommandScreen.tsx:2', { root: ROOT, readFile: read })).toEqual([]);
  });
});

describe('L3 字面量 —— 只报不判那一级', () => {
  test('★ 红样本 = 真实现场: 简报说裸 hex, 而文件里已经是 token', () => {
    // 怎么让它红: 把 L3 那段删掉 → 简报与文件对不上这件事重新变得不可见。
    const v = checkClaimAnchors(
      '屏底 navy 渐变见 src/VoiceCommandScreen.tsx:2 —— 此为屏内唯一允许的裸 hex `#1d3a72`',
      { root: ROOT, readFile: read },
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L3-literal');
    expect(v[0]!.literal).toBe('#1d3a72');
  });

  test('绿: 字面量真在文件里', () => {
    const v = checkClaimAnchors('见 src/VoiceCommandScreen.tsx:2 的 `light.primarySoft`', { root: ROOT, readFile: read });
    expect(v).toEqual([]);
  });

  test('★ L3 不判红 —— 它会误报(简报可能在描述"改之前")', () => {
    // 这一条钉的是**出口**不是判据。怎么让它红: 把 L3 也算进判红级 → 一句"改之前是 #xxx"
    // 的诚实说明会把节点判失败, 而那正是假阳性闸被人关掉的开始。
    expect(isBlockingLevel('L1-path')).toBe(true);
    expect(isBlockingLevel('L2-line')).toBe(true);
    expect(isBlockingLevel('L3-literal')).toBe(false);
  });

  test('★ L3 有结案条件 —— 不许变成第二笔无人认领的账', () => {
    // §8.5 那条 no-op 指标的注写着「得先有分布」, 然后攒了一年没人回来结案。
    // 这个常量存在的全部意义就是让"回来结案"这件事有一个可查的触发点。
    expect(L3_REVIEW_AFTER).toBeGreaterThan(0);
  });
});

describe('收敛面 —— 拿不准一律不报', () => {
  test('绝对路径 / URL / 不含斜杠的裸文件名不判', () => {
    // 判据故意窄: 散在散文里的引用不判, 这是把 L3 误报面砍掉大半的地方。
    // 怎么让它红: 去掉 isAbsolute / '://' 那两个 continue → 引用外部 URL 也开始报。
    expect(checkClaimAnchors('见 /etc/passwd:1', { root: ROOT, readFile: read })).toEqual([]);
    expect(checkClaimAnchors('见 https://x.com/a.js:3', { root: ROOT, readFile: read })).toEqual([]);
    expect(checkClaimAnchors('改了 README.md 那段', { root: ROOT, readFile: read })).toEqual([]);
  });

  test('同一条声称只报一次(一份报告里同一句会重复出现)', () => {
    const t = '见 src/nope/M.tsx:1 …… 再看 src/nope/M.tsx:1';
    expect(checkClaimAnchors(t, { root: ROOT, readFile: read })).toHaveLength(1);
  });
});
