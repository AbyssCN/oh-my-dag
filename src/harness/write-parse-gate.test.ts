/**
 * 写后即验的反向自检(仓规:一条永远绿的闸不是闸)。
 *
 * **红样本不是编的** —— 三条坏样本逐条对应 plana M3.5 实战里那三次编辑损坏的形态
 * (交接报告 F1):重复声明 + 悬空注释体 / 语句被塞进参数表 / 新旧两版并存。
 * 绿样本钉住不许误伤的那几类:正常 TSX、JSX、认不出的扩展名、读不到的路径。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isParseable, parseContent, parseWrittenFiles, renderParseFailures } from './write-parse-gate';

/** F1 #1: `routes.tsx` —— 类型联合后接没有 `/**` 开头的悬空注释体, 随后重复声明。 */
const BROKEN_DANGLING_COMMENT = `export type FeatureTab = 'a' | 'b';
 * 这一段是注释体, 但上面那行 /** 没了 —— hashline 补丁把开头吃掉了
 */
export type FeatureTab = 'a' | 'b' | 'c';
`;

/** F1 #2: 两条 const 被塞进函数调用的参数表内部, 右括号错位。 */
const BROKEN_STMT_IN_ARGS = `const label = i18nOrFallback(key,
  const a = 1;
  const b = 2;
  'fallback');
`;

/** F1 #3: JSX 新旧两版并存 —— 旧的没删, 标签不闭合。 */
const BROKEN_JSX_BOTH_VERSIONS = `export const S = () => (
  <View style={old}>
  <View style={next}>
    <Text>hi</Text>
  </View>
);
`;

const GOOD_TSX = `import { View } from 'react-native';
export const S = (): JSX.Element => (
  <View>
    <Text>hi</Text>
  </View>
);
`;

describe('parseContent —— 判据本体', () => {
  test('★ 红: 三种"部分写入"形态各自被抓住 (F1 逐条)', () => {
    // 证伪方式: 把 parseContent 的 transformSync 那行删掉 (直接 return null) → 三条全绿 = 闸哑了。
    expect(parseContent('routes.tsx', BROKEN_DANGLING_COMMENT)).toBeTruthy();
    expect(parseContent('SolveScreen.tsx', BROKEN_STMT_IN_ARGS)).toBeTruthy();
    expect(parseContent('SolveScreen.tsx', BROKEN_JSX_BOTH_VERSIONS)).toBeTruthy();
  });

  test('绿: 正常 TSX 不误伤', () => {
    expect(parseContent('ok.tsx', GOOD_TSX)).toBeNull();
  });

  test('★ .tsx 必须用 tsx loader —— 用 ts loader 的话正常 JSX 会被判成语法错', () => {
    // 这是 loader 表存在的全部理由。证伪方式: 把 JS_LOADERS 里 '.tsx' 改成 'ts' → 这条红,
    // 而且是最坏的一种红 (闸开始误杀正常交付, 下一步就是被人关掉)。
    expect(parseContent('ok.tsx', GOOD_TSX)).toBeNull();
    expect(parseContent('ok.jsx', 'export const A = () => <div>x</div>;')).toBeNull();
  });

  test('JSON 走 JSON.parse, 坏 JSON 抓得住', () => {
    expect(parseContent('a.json', '{"a":1}')).toBeNull();
    expect(parseContent('a.json', '{ not json')).toBeTruthy();
  });

  test('★ 认不出的扩展名**不判**, 不是判它对', () => {
    // 拿不准一律不报 (同 static-lint / g1)。证伪方式: 给 isParseable 加 `.md` → 任何含
    // markdown 语法的文档都会被当成语法错, 闸恒红。
    expect(isParseable('a.md')).toBe(false);
    expect(isParseable('a.py')).toBe(false);
    expect(isParseable('a.png')).toBe(false);
    expect(isParseable('a.tsx')).toBe(true);
    expect(isParseable('a.json')).toBe(true);
    expect(parseContent('README.md', '# 标题\n<未闭合')).toBeNull();
  });
});

describe('parseWrittenFiles —— 走盘的那一层', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omd-write-parse-'));
    mkdirSync(join(dir, 'features'), { recursive: true });
    writeFileSync(join(dir, 'features', 'routes.tsx'), BROKEN_DANGLING_COMMENT);
    writeFileSync(join(dir, 'features', 'ok.tsx'), GOOD_TSX);
    writeFileSync(join(dir, 'notes.md'), '# 随便写\n<不闭合');
    return dir;
  }

  test('★ 只报坏的那个, 相对路径按 root 解', () => {
    const root = fixture();
    const out = parseWrittenFiles(['features/routes.tsx', 'features/ok.tsx', 'notes.md'], root);
    expect(out.map((f) => f.path)).toEqual(['features/routes.tsx']);
    expect(out[0]!.error.length).toBeGreaterThan(0); // 判词带解析器原话, 不是"出错了"
  });

  test('★ 读不到的路径**跳过**, 不冒充产物闸', () => {
    // 「产物不在盘上」是 empty-artifact 那道闸的活。两道闸各报各的 —— 一道闸兼职两件事,
    // 出错时读的人分不清是没写还是写坏了。证伪方式: 把 catch 里的 continue 改成 push → 这条红。
    const root = fixture();
    expect(parseWrittenFiles(['features/nope.tsx'], root)).toEqual([]);
  });

  test('判词点名文件 + 给整段重写的处置 (不是"再试一次")', () => {
    const t = renderParseFailures([{ path: 'a.tsx', error: 'Unexpected token' }]);
    expect(t).toContain('a.tsx');
    expect(t).toContain('Unexpected token');
    expect(t).toContain('整段重写'); // run C 实测有效的那一刀; 打补丁正是损坏的来源
  });
});
