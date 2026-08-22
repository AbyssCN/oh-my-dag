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
import {
  createParseFeedback,
  isParseable,
  parseContent,
  parseWrittenFiles,
  renderParseFailures,
  renderParseNudge,
} from './write-parse-gate';

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

describe('createParseFeedback —— L0 会话内自愈 (只提醒不判定)', () => {
  /** 每条用例一棵干净的树 —— 状态机跨用例串味会让"重新上膛"那条恒绿。 */
  function tree(): { root: string; write: (rel: string, body: string) => void } {
    const root = mkdtempSync(join(tmpdir(), 'omd-parse-fb-'));
    return { root, write: (rel, body) => writeFileSync(join(root, rel), body) };
  }

  test('★ 红: 写坏了就注一条, 且带得出解析器原话', () => {
    // 证伪方式: 把 note() 里的 `pending.push(failure)` 删掉 → 这条红 = 这一层哑了。
    const { root, write } = tree();
    const fb = createParseFeedback();
    write('routes.tsx', BROKEN_DANGLING_COMMENT);
    fb.note(['routes.tsx'], root);
    const text = fb.takeInjection();
    expect(text).toContain('routes.tsx');
    expect(fb.nudges()).toBe(1);
    expect(text).toContain('读全文 → 重写全文');
    // 分刀改是这一层唯一的正当误报形态 —— 必须明写, 否则模型会为迎合判词去动对的代码。
    expect(text).toContain('分两刀改');
  });

  test('绿: 写得好一条都不注 (这一层不许有基础噪声)', () => {
    const { root, write } = tree();
    const fb = createParseFeedback();
    write('ok.tsx', GOOD_TSX);
    fb.note(['ok.tsx'], root);
    expect(fb.takeInjection()).toBeNull();
    expect(fb.nudges()).toBe(0);
  });

  test('★ 边沿触发: 同一条错不重复注 (「一直坏着」= 一条, 不是每写一次一条)', () => {
    // 这是与"每写必判"最本质的区别。证伪方式: 把 `reported.get(f) === failure.error` 那句
    // continue 删掉 → 一个改十刀的节点会被灌十条同样的提醒, 而那正是 prompt 噪声的来源。
    const { root, write } = tree();
    const fb = createParseFeedback();
    write('a.tsx', BROKEN_STMT_IN_ARGS);
    fb.note(['a.tsx'], root);
    expect(fb.takeInjection()).toBeTruthy();
    fb.note(['a.tsx'], root); // 还是坏的, 还是同一条错
    fb.note(['a.tsx'], root);
    expect(fb.takeInjection()).toBeNull();
    expect(fb.nudges()).toBe(1);
  });

  test('★ 修好了要**重新上膛** —— 后来再写坏必须还能注得出来', () => {
    // 证伪方式: 把 `reported.delete(f)` 删掉 → 一个文件一辈子只提醒一次,
    // 于是"改好了又改坏"这条最常见的返修形态整个静默 (而它正是 F1 那三次的形状)。
    // ⚠ 两次必须坏成**同一条错**。第一版这条用例第二次换了另一种坏法, 于是靠"错不同"
    // 就绕过了去重 —— 删掉 `reported.delete` 它照样绿。**那是一条不会红的测试**,
    // 按仓规当场证伪时抓出来的 (证伪 2 不红 = 用例本身是空的)。
    const { root, write } = tree();
    const fb = createParseFeedback();
    write('a.tsx', BROKEN_JSX_BOTH_VERSIONS);
    fb.note(['a.tsx'], root);
    expect(fb.takeInjection()).toBeTruthy();
    write('a.tsx', GOOD_TSX); // 它按提醒修好了
    fb.note(['a.tsx'], root);
    expect(fb.takeInjection()).toBeNull();
    write('a.tsx', BROKEN_JSX_BOTH_VERSIONS); // 后来又坏回同一个样子
    fb.note(['a.tsx'], root);
    expect(fb.takeInjection()).toBeTruthy();
    expect(fb.nudges()).toBe(2);
  });

  test('★ 有上限: 注到第 4 条就闭嘴, 交给节点末硬闸', () => {
    // 修不动的会话继续灌字只是在烧 token。证伪方式: 把 MAX_NUDGES_PER_LEAF 那道门删掉 →
    // 一个反复改坏五个文件的 leaf 会被注五条, 上限就名存实亡了。
    const { root, write } = tree();
    const fb = createParseFeedback();
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      write(`${n}.tsx`, BROKEN_STMT_IN_ARGS);
      fb.note([`${n}.tsx`], root);
      fb.takeInjection();
    }
    expect(fb.nudges()).toBe(3);
  });

  test('认不出的扩展名 / 读不到的路径 一律不注 (同硬闸的口径)', () => {
    const { root, write } = tree();
    const fb = createParseFeedback();
    write('notes.md', '# 标题\n<不闭合');
    fb.note(['notes.md', 'nope.tsx'], root);
    expect(fb.takeInjection()).toBeNull();
  });

  test('★ 提醒的时态与处置**不同于**事后判词 —— 两个读者不许共用一份文本', () => {
    // 事后那份是写给下一个冷启动 leaf / 重规划轮的; 这份是写给还活着的这个 leaf 的。
    // 证伪方式: 让 renderParseNudge 直接 return renderParseFailures(...) → 这条红。
    const f = [{ path: 'a.tsx', error: 'Unexpected token' }];
    expect(renderParseNudge(f)).not.toBe(renderParseFailures(f));
    expect(renderParseNudge(f)).toContain('忽略本条'); // 提醒可以被无视, 判词不行
    expect(renderParseFailures(f)).not.toContain('忽略本条');
  });
});
