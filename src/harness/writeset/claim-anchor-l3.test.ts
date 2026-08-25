/**
 * #265 L3 白名单收敛 —— 负样本语料 + 真阳性回归。
 *
 * 病根:旧 L3 把反引号里**任何**反引号内容当「文件里应该有的串」比对,
 * 简报散文 / markdown 表格 / 测试读数 / 纯标点 全被判红 —— 真值不在文件里
 * 不等于「说错了」(可能是描述改之前 / 应当避免的写法)。
 *
 * INV-W265-1:白名单制,只验可机械证伪的字面(可 grep -F);
 * 8 条 #265 误报原状入负样本断言零 finding,2 条真阳性断言仍被抓。
 *
 * 证伪(自检):把 `isMechanicalLiteral` 拿掉 → 8 条负样本条条红;
 * 把 `if (... && isMechanicalLiteral(...))` 那条改掉 → 真阳性丢失。
 */
import { describe, expect, test } from 'bun:test';
import { checkClaimAnchors } from './claim-anchor';

const ROOT = '/repo';
const files: Record<string, string> = {
  // 文件里**不**放 `#1d3a72` —— 这是正样本:声称里有,文件里没有, L3 必须抓。
  // 标识符 `realIdentifier` 留在文件里,负样本不会撞它。
  '/repo/src/x.ts': ['const realIdentifier = 1;', 'const color = "rgb(...)";'].join('\n'),
};
const read = (p: string): string | null => files[p] ?? null;

describe('L3 负样本 —— #265 误报原状,新白名单下零 finding', () => {
  test('1. 单字符纯标点「、」(纯标点 · 长度 < 3)', () => {
    // 怎么让它红:把 `isMechanicalLiteral` 拿掉 → 「、` 不在文件 → L3 红。
    expect(
      checkClaimAnchors('见 src/x.ts:1 后那个 `、` 别漏', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('2. 含空白的散文前缀 ` 新建:`', () => {
    // 证伪:` 新建:` 长度 4 但含 space,负向命中 → 跳 L3;拿掉 whitespace 检查就红。
    expect(
      checkClaimAnchors('据 src/x.ts:1 ` 新建:` 那段', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('3. 测试读数 `) green: 26 + 30 = 56 pass / 0 fail.`', () => {
    // 散文 + 数字 + 标点 + 含空白;纯粹是输出日志, 不是文件字面。
    expect(
      checkClaimAnchors(
        '读数 src/x.ts:1 `) green: 26 + 30 = 56 pass / 0 fail.`',
        { root: ROOT, readFile: read },
      ),
    ).toEqual([]);
  });

  test('4. 带首尾空格括号不配对的散文段', () => {
    // 散文段 —— 括号里挖出来的非代码短语,验证即误报。
    expect(
      checkClaimAnchors('看 src/x.ts:1 这段 `( 未配对 paren` 段', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('5. markdown 表格单元碎片 ` | **新建** (≈230 行): `', () => {
    // 表格 cell —— 含 `|` `*` 空格 `(` `)` `≈`, 整段是 markdown 渲染出来的列文本。
    expect(
      checkClaimAnchors('表里 src/x.ts:1 ` | **新建** (≈230 行): ` 一行', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('6. markdown 表格单元碎片 ` | 增 `', () => {
    // 表格 cell 两字短词,前面有 `|`, 后空格。
    expect(
      checkClaimAnchors('src/x.ts:1 ` | 增 ` 一行', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('7. 长度 < 3 的 `ab`(短短语)', () => {
    // 长度负向命中。
    expect(
      checkClaimAnchors('src/x.ts:1 `ab` 短了', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });

  test('8. 纯标点 `!`(长度 < 3 且无 alnum)', () => {
    // 双重负向:长度 < 3 且无 alnum —— 任何一边漏掉都会红。
    expect(
      checkClaimAnchors('src/x.ts:1 `!` 一个叹号', { root: ROOT, readFile: read }),
    ).toEqual([]);
  });
});

describe('L3 真阳性 —— 收敛不许把闸收死(INV-W265-3)', () => {
  test('★ 红样本:编造标识符 `notInFile` 在 src/x.ts 不存在', () => {
    // 怎么让它红:把 L3 整段删掉 / 把白名单写过头连这个也挡 → 本条零 finding, 红。
    const v = checkClaimAnchors('src/x.ts:1 里有 `notInFile`', { root: ROOT, readFile: read });
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L3-literal');
    expect(v[0]!.literal).toBe('notInFile');
    expect(v[0]!.path).toBe('src/x.ts');
    expect(v[0]!.line).toBe(1);
  });

  test('★ 真阳性 #1d3a72(hex 在文件里但被字面串找,文件里没)—— 旧红样本在新白名单下仍走 L3', () => {
    // INV-W265-3 的另一面:白名单不能把「#hex」「短路径」这种**可 grep -F 的字面**也挡掉。
    // 既有红样本 #1d3a72 在这里重钉一次,免得后续误把 hex 也划入负向集。
    const v = checkClaimAnchors(
      'src/x.ts:2 里有 `#1d3a72` —— 而文件里没有',
      { root: ROOT, readFile: read },
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L3-literal');
    expect(v[0]!.literal).toBe('#1d3a72');
  });

  test('★ 红:行号越界仍走 L2(L1/L2 不动,这里再钉一次)', () => {
    // L2 零误报,与 L3 收敛无关 —— 但本单要确认白名单修改没顺带破坏 L2 路径。
    const v = checkClaimAnchors('见 src/x.ts:99 那段', { root: ROOT, readFile: read });
    expect(v).toHaveLength(1);
    expect(v[0]!.level).toBe('L2-line');
    expect(v[0]!.message).toContain('只有 2 行');
  });
});