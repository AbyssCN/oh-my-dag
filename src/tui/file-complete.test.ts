/**
 * L1 判据:模糊文件补全(原生实现 `pi-fff` 那个能力,2026-08-07)。
 *
 * 匹配本身用 pi-tui 的 `fuzzyFilter` —— **这里不测它**,测的是我们加的那几层:
 * 枚举的忽略名单与上限 · 取词的边界 · 什么时候该弹什么时候不该弹 · 补全插得对不对。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileScan, MAX_FILES, createFileCompleteProvider, scanFiles, tokenAt } from './file-complete';

function world(paths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-fc-'));
  for (const p of paths) {
    const full = join(root, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'x');
  }
  return root;
}

describe('scanFiles', () => {
  test('★ 忽略名单生效 —— node_modules / .git 不许进补全', () => {
    const root = world(['src/a.ts', 'node_modules/pkg/index.js', '.git/config', 'dist/out.js']);
    expect(scanFiles(root).files).toEqual(['src/a.ts']);
  });

  test('★ `.claude` / `.omd` 是例外 —— 它们是这个仓真的会去编辑的东西', () => {
    const root = world(['.claude/CLAUDE.md', '.omd/config.json', '.hidden/x']);
    const f = scanFiles(root).files;
    expect(f).toContain('.claude/CLAUDE.md');
    expect(f).toContain('.omd/config.json');
    expect(f).not.toContain('.hidden/x');
  });

  test('★ 撞上限时 truncated=true —— 少几条而不解释, 人会以为文件不存在', () => {
    const root = world(Array.from({ length: 6 }, (_, i) => `f${i}.ts`));
    const s = scanFiles(root, 3);
    expect(s.truncated).toBe(true);
    expect(s.files.length).toBeLessThanOrEqual(3);
  });

  test('没撞上限时 truncated=false', () => {
    expect(scanFiles(world(['a.ts']), 100).truncated).toBe(false);
  });

  test('读不了的目录跳过, 不让整次补全失败', () => {
    expect(() => scanFiles('/nonexistent-omd-fc-root')).not.toThrow();
  });
});

describe('tokenAt', () => {
  test('★ 以空白为界, **不以斜杠为界** —— 按 / 切会让每段各补各的', () => {
    expect(tokenAt('看看 src/tui/foo', 16)).toEqual({ prefix: 'src/tui/foo', start: 5 });
  });

  test('光标前是空白 → 空前缀', () => {
    expect(tokenAt('abc ', 4)).toEqual({ prefix: '', start: 4 });
  });

  test('光标在行中间只取到光标处', () => {
    expect(tokenAt('abcdef', 3).prefix).toBe('abc');
  });
});

describe('provider —— 什么时候弹', () => {
  const scan = (files: string[], truncated = false): (() => FileScan) => () => ({ files, truncated });
  const mk = (files: string[], over: Partial<Parameters<typeof createFileCompleteProvider>[0]> = {}) =>
    createFileCompleteProvider({ cwd: '/x', scan: scan(files), now: () => 0, ...over });
  const ask = (p: ReturnType<typeof mk>, line: string) =>
    p.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

  test('★ 前缀太短不弹 —— 打一个字符就铺整仓文件没有意义', async () => {
    expect(await ask(mk(['src/a.ts']), 's')).toBeNull();
  });

  test('够长就弹', async () => {
    const r = await ask(mk(['src/alpha.ts', 'src/beta.ts']), 'alp');
    expect(r?.items.map((i) => i.value)).toEqual(['src/alpha.ts']);
  });

  test('★ `@` 是显式触发 —— 一个字符也弹', async () => {
    const r = await ask(mk(['src/a.ts']), '@a');
    expect(r?.items.map((i) => i.value)).toEqual(['src/a.ts']);
  });

  test('光秃秃一个 `@` 不弹(那是还没打字)', async () => {
    expect(await ask(mk(['src/a.ts']), '@')).toBeNull();
  });

  test('一条都不匹配 → null(不弹一个空框)', async () => {
    expect(await ask(mk(['src/a.ts']), 'zzzz')).toBeNull();
  });

  test('★ 截断时把说明塞进列表 —— AutocompleteSuggestions 没有 footer 字段', async () => {
    const r = await ask(mk(['src/alpha.ts'], { scan: scan(['src/alpha.ts'], true) }), 'alp');
    expect(r?.items.at(-1)?.label).toContain(`超过 ${MAX_FILES}`);
    expect(r?.items.at(-1)?.value).toBe(''); // 选中它什么都不插
  });

  test('条数封顶', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `src/alpha${i}.ts`);
    expect((await ask(mk(many, { maxSuggestions: 5 }), 'alp'))?.items).toHaveLength(5);
  });
});

describe('provider —— 缓存与插入', () => {
  test('★ TTL 内只扫一次(补全跑在按键循环里, 每次按键全盘扫会卡住)', async () => {
    let calls = 0;
    const p = createFileCompleteProvider({
      cwd: '/x', now: () => 0,
      scan: () => {
        calls++;
        return { files: ['src/alpha.ts'], truncated: false };
      },
    });
    const sig = { signal: new AbortController().signal };
    await p.getSuggestions(['alp'], 0, 3, sig);
    await p.getSuggestions(['alph'], 0, 4, sig);
    expect(calls).toBe(1);
  });

  test('TTL 过了重扫', async () => {
    let calls = 0;
    let t = 0;
    const p = createFileCompleteProvider({
      cwd: '/x', now: () => t,
      scan: () => {
        calls++;
        return { files: ['src/alpha.ts'], truncated: false };
      },
    });
    const sig = { signal: new AbortController().signal };
    await p.getSuggestions(['alp'], 0, 3, sig);
    t = 999_999;
    await p.getSuggestions(['alp'], 0, 3, sig);
    expect(calls).toBe(2);
  });

  test('★ 补全替换的是**那个词**, 不是整行', () => {
    const p = createFileCompleteProvider({ cwd: '/x', scan: () => ({ files: [], truncated: false }) });
    // '看看 src/tu 这个' 里 `src/tu` 占 3..8, 光标在 `u` 之后 = 第 9 列。
    // (初版写 10 —— 那已经越过空格了, 于是 tokenAt 取到空前缀, 补全被插在空格后面。)
    const r = p.applyCompletion(['看看 src/tu 这个'], 0, 9, { value: 'src/tui/tui.ts', label: '' }, 'src/tu');
    expect(r.lines[0]).toBe('看看 src/tui/tui.ts 这个');
    expect(r.cursorCol).toBe(3 + 'src/tui/tui.ts'.length);
  });
});
