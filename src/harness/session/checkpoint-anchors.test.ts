/**
 * 交接代码锚(L3)。这一层的价值全在**「没有读数」与「读数是零」分得开** ——
 * 分不开的话,一份写于本机制之前的老交接会宣称"引用的文件全都没变",那是凭空捏出来的保证。
 *
 * 反向自检(实跑):
 *  - 让 `readCheckpointAnchors` 在 sidecar 缺席时返 `{changed:[],gone:[]}` 而不是 `null`
 *    ⇒ 「没有 sidecar → 不说话」当场红;
 *  - 把 `writeCheckpointAnchors` 的 `sha !== null` 判断去掉(连读不到的路径也锚)
 *    ⇒ 「只锚真实存在的路径」当场红;
 *  - 把 `extractRepoPaths` 的正则改窄(去掉 docs)⇒ 「提取器与写时闸同一份」当场红。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANCHORS_FILENAME,
  extractRepoPaths,
  readCheckpointAnchors,
  renderAnchorDrift,
  writeCheckpointAnchors,
} from './checkpoint-anchors';

let root: string;
let cpPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-cp-anchors-'));
  mkdirSync(join(root, 'src', 'harness'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'session'), { recursive: true });
  cpPath = join(root, 'session', 'checkpoint.md');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const MD = `## §1 Active intent
在改 \`src/harness/store.ts\` 与 docs/plan/x.md,顺带看了 src/harness/gone.ts。

## §2 Next
跑 test/core/a.test.ts。
`;

describe('提取器 — 与写时闸同一份', () => {
  test('认得 src/ docs/ test/ 三个前缀,去掉行号尾巴与标点', () => {
    const paths = extractRepoPaths('见 `src/a.ts:160`, docs/b.md, 还有 test/c.test.ts)。');
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('docs/b.md');
    expect(paths).toContain('test/c.test.ts');
  });

  test('去重 —— 同一路径提两次只算一个锚', () => {
    expect(extractRepoPaths('src/a.ts 和 src/a.ts').length).toBe(1);
  });
});

describe('写锚 — 只锚真实存在的', () => {
  test('★ md 引用了不存在的路径 → 不进锚(否则读侧一开局就一片假 missing)', () => {
    writeFileSync(join(root, 'src', 'harness', 'store.ts'), 'v1');
    mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan', 'x.md'), 'plan');
    // src/harness/gone.ts 与 test/core/a.test.ts 故意不建

    const n = writeCheckpointAnchors(cpPath, MD, root, 1000);
    expect(n).toBe(2);

    const raw = JSON.parse(readFileSync(join(root, 'session', ANCHORS_FILENAME), 'utf-8')) as {
      writtenAt: number;
      anchors: { path: string; sha: string }[];
    };
    expect(raw.writtenAt).toBe(1000);
    expect(raw.anchors.map((a) => a.path).sort()).toEqual(['docs/plan/x.md', 'src/harness/store.ts']);
    for (const a of raw.anchors) expect(a.sha).toMatch(/^[0-9a-f]{16}$/);
  });

  test('一个仓内路径都没提到 → 写出空锚(0),**不是**不写', () => {
    expect(writeCheckpointAnchors(cpPath, '## §1\n没提任何文件。\n', root, 1)).toBe(0);
    expect(existsSync(join(root, 'session', ANCHORS_FILENAME))).toBe(true);
  });

  test('写不出去 → -1(与 0 分得开:一个是挂了,一个是真没有)', () => {
    const bad = join(root, 'nonexistent-dir', 'checkpoint.md');
    expect(writeCheckpointAnchors(bad, MD, root, 1)).toBe(-1);
  });
});

describe('读锚 — NULL ≠ 0', () => {
  test('★ 没有 sidecar → null(**不是** 一条"零漂移"读数)', () => {
    expect(readCheckpointAnchors(cpPath, root)).toBeNull();
    // 这一条是本层的全部价值:老交接不许凭空宣称"文件都没变"。
    expect(renderAnchorDrift(readCheckpointAnchors(cpPath, root))).toBe('');
  });

  test('sidecar 是坏 JSON / 形状不对 → 同样 null(读不动 ≠ 没漂移)', () => {
    writeFileSync(join(root, 'session', ANCHORS_FILENAME), '{ 不是 json');
    expect(readCheckpointAnchors(cpPath, root)).toBeNull();
    writeFileSync(join(root, 'session', ANCHORS_FILENAME), '{"anchors": "不是数组"}');
    expect(readCheckpointAnchors(cpPath, root)).toBeNull();
  });

  test('★ 交接之后改了一个字节 → changed 里出现它', () => {
    const f = join(root, 'src', 'harness', 'store.ts');
    writeFileSync(f, 'v1');
    mkdirSync(join(root, 'docs', 'plan'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plan', 'x.md'), 'plan');
    writeCheckpointAnchors(cpPath, MD, root, 1000);

    expect(readCheckpointAnchors(cpPath, root)!.changed).toEqual([]);

    writeFileSync(f, 'v2');
    const d = readCheckpointAnchors(cpPath, root)!;
    expect(d.changed).toEqual(['src/harness/store.ts']);
    expect(d.gone).toEqual([]);
    expect(d.total).toBe(2);
    expect(d.writtenAt).toBe(1000);
  });

  test('★ 交接之后文件被删 → gone,不是 changed(处置不同:删了 vs 改了)', () => {
    const f = join(root, 'src', 'harness', 'store.ts');
    writeFileSync(f, 'v1');
    writeCheckpointAnchors(cpPath, 'ref src/harness/store.ts', root, 1);
    rmSync(f);
    const d = readCheckpointAnchors(cpPath, root)!;
    expect(d.gone).toEqual(['src/harness/store.ts']);
    expect(d.changed).toEqual([]);
  });
});

describe('渲染 — 三种输出各不相同', () => {
  test('没有读数 → 空串(沉默); 零漂移 → 明确说"都没变"; 有漂移 → 点名', () => {
    expect(renderAnchorDrift(null)).toBe('');
    expect(renderAnchorDrift({ writtenAt: 1, total: 3, changed: [], gone: [] })).toContain('都没变');
    const withDrift = renderAnchorDrift({
      writtenAt: 1,
      total: 3,
      changed: ['src/a.ts', 'src/b.ts'],
      gone: ['src/c.ts'],
    });
    expect(withDrift).toContain('2 个被改过');
    expect(withDrift).toContain('src/a.ts');
    expect(withDrift).toContain('1 个读不到');
    expect(withDrift).toContain('先核再用');
  });

  test('引用了零个仓内文件 → 说"无从判新鲜度",不冒充"都没变"', () => {
    expect(renderAnchorDrift({ writtenAt: 1, total: 0, changed: [], gone: [] })).toContain('无从判');
  });
});
