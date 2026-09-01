/**
 * repro-allow.test —— INV-5「reproCmd 白名单」(GWT-5)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · 把 `REPRO_FORBIDDEN_CHARS` 里的 `>` 删掉 → 「重定向被拒」那条红。
 *   · 把前缀判断改成 `.includes` → 「rm -rf 里塞个 cat 也不放行」那条红。
 *   · 把两道判据顺序对调 → 「拒因指的是真正那一条」那条红 (rm 会报成元字符)。
 */
import { describe, expect, test } from 'bun:test';
import { REPRO_ALLOW_PREFIXES, REPRO_FORBIDDEN_CHARS, reproAllowed } from './repro-allow';

describe('INV-5 GWT-5 三条样本', () => {
  test('rm -rf x → 拒, 拒因是「白名单」', () => {
    const v = reproAllowed('rm -rf x');
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('白名单');
  });

  test('ugrep -n foo src > out.txt → 拒, 拒因是「重定向」(前缀合法但会写盘)', () => {
    const v = reproAllowed('ugrep -n foo src > out.txt');
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('重定向');
  });

  test('bun test src/a.test.ts → 放行', () => {
    expect(reproAllowed('bun test src/a.test.ts')).toEqual({ ok: true });
  });
});

describe('fail-closed 的边缘', () => {
  test('空 / 全空白 → 拒', () => {
    expect(reproAllowed('').ok).toBe(false);
    expect(reproAllowed('   ').ok).toBe(false);
  });

  test('前缀必须在开头, 藏在中间不算', () => {
    expect(reproAllowed('rm -rf x && cat y').ok).toBe(false);
    expect(reproAllowed('sudo ugrep -n foo src').ok).toBe(false);
  });

  test('管道 / 串接 / 命令替换逐个被拒, 且拒因指名那个字符', () => {
    for (const [cmd, word] of [
      ['ugrep -n foo src | tee out', '管道'],
      ['ugrep -n foo src ; rm -rf /', '命令串接'],
      ['cat $(echo /etc/passwd)', '命令替换'],
    ] as const) {
      const v = reproAllowed(cmd);
      expect(v.ok).toBe(false);
      expect((v as { reason: string }).reason).toContain(word);
    }
  });

  test('sed 只放 -n (没有 -i 的写盘路子)', () => {
    expect(reproAllowed('sed -n 1,20p src/a.ts').ok).toBe(true);
    expect(reproAllowed('sed -i s/a/b/ src/a.ts').ok).toBe(false);
  });

  test('白名单每条自身都能放行一个最小样本 (没有写死就过不了的僵尸条目)', () => {
    for (const p of REPRO_ALLOW_PREFIXES) {
      expect(reproAllowed(`${p} src/a.ts`.replace(/\s+/g, ' ')).ok).toBe(true);
    }
  });

  test('禁字符表非空 (闸不是摆设)', () => {
    expect(REPRO_FORBIDDEN_CHARS.length).toBeGreaterThan(0);
  });
});
