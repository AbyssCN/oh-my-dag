import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClientSkills } from '../../src/harness/client-skills-install';

// 自装器: 幂等铺 client-skills/ 下每个技能目录进用户级 skills 根, 不覆盖用户改过的, best-effort 从不抛。
// 全程注入临时 src/dst, 不碰真 ~/.claude。

let base: string;
let src: string;
let dst: string;

function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}
function readSkill(root: string, name: string): string {
  return readFileSync(join(root, name, 'SKILL.md'), 'utf8');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'omd-skills-'));
  src = join(base, 'client-skills');
  dst = join(base, 'skills');
  mkdirSync(src, { recursive: true });
  writeSkill(src, 'omd-path', '# /omd-path v1');
  writeSkill(src, 'omd-deepen', '# /omd-deepen v1');
  // 无前缀技能照铺 (2026-10-08 起不再只认 omd- 前缀)
  writeSkill(src, 'grill', '# /grill v1');
  // 没有 SKILL.md 的目录 / 点目录: 不该被铺
  mkdirSync(join(src, 'not-a-skill'), { recursive: true });
  writeSkill(src, '.hidden', '# hidden');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('installClientSkills', () => {
  test('首装: 铺每个带 SKILL.md 的技能目录(含无前缀), 无 SKILL.md 目录与点目录忽略', () => {
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.installed.sort()).toEqual(['grill', 'omd-deepen', 'omd-path']);
    expect(existsSync(join(dst, 'omd-path', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'grill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dst, 'not-a-skill'))).toBe(false);
    expect(existsSync(join(dst, '.hidden'))).toBe(false);
    expect(existsSync(join(dst, '.omd-skills.json'))).toBe(true);
  });

  test('幂等: 未变的第二次跑 → 零动作', () => {
    installClientSkills({ srcRoot: src, dstRoot: dst });
    const s2 = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s2.installed).toEqual([]);
    expect(s2.updated).toEqual([]);
    expect(s2.skipped).toEqual([]);
  });

  test('源更新: 我们写过且用户没改 → 更新到新内容', () => {
    installClientSkills({ srcRoot: src, dstRoot: dst });
    writeSkill(src, 'omd-path', '# /omd-path v2 改了');
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.updated).toEqual(['omd-path']);
    expect(readSkill(dst, 'omd-path')).toContain('v2');
  });

  test('不覆盖用户改过的: 目标被用户编辑 → 跳过, 保留用户内容', () => {
    installClientSkills({ srcRoot: src, dstRoot: dst });
    writeSkill(dst, 'omd-path', '# 用户自己改的'); // 用户动了目标
    writeSkill(src, 'omd-path', '# /omd-path v3'); // 同时源也升级了
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.skipped).toEqual(['omd-path']);
    expect(s.updated).toEqual([]);
    expect(readSkill(dst, 'omd-path')).toBe('# 用户自己改的'); // 用户内容原样保留
  });

  test('第三方同名(非我们清单里)→ 跳过不碰', () => {
    writeSkill(dst, 'omd-path', '# 别的来源装的同名'); // 目标先存在, 但清单里没有
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.skipped).toContain('omd-path');
    expect(s.installed).toEqual(['grill', 'omd-deepen']); // 另外两个照常装
    expect(readSkill(dst, 'omd-path')).toBe('# 别的来源装的同名');
  });

  test('修剪: 源里删掉/改名的技能 → 我们写的那份删掉, 清单撤条目', () => {
    installClientSkills({ srcRoot: src, dstRoot: dst });
    rmSync(join(src, 'omd-deepen'), { recursive: true, force: true }); // 删
    rmSync(join(src, 'omd-path'), { recursive: true, force: true }); // 改名 omd-path → path
    writeSkill(src, 'path', '# /omd-path v1');
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.removed).toEqual(['omd-deepen', 'omd-path']);
    expect(s.installed).toEqual(['path']);
    expect(existsSync(join(dst, 'omd-deepen'))).toBe(false);
    expect(existsSync(join(dst, 'omd-path'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dst, '.omd-skills.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(['grill', 'path']);
    // 再跑一次: 零动作
    const s2 = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect([...s2.installed, ...s2.updated, ...s2.removed, ...s2.skipped]).toEqual([]);
  });

  test('修剪不碰用户改过的: 源里删了但目标被用户编辑 → 目录保留, 只撤清单条目', () => {
    installClientSkills({ srcRoot: src, dstRoot: dst });
    writeSkill(dst, 'omd-deepen', '# 用户自己改的');
    rmSync(join(src, 'omd-deepen'), { recursive: true, force: true });
    const s = installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(s.removed).toEqual([]);
    expect(s.skipped).toEqual(['omd-deepen']);
    expect(readSkill(dst, 'omd-deepen')).toBe('# 用户自己改的');
    const manifest = JSON.parse(readFileSync(join(dst, '.omd-skills.json'), 'utf8')) as Record<string, string>;
    expect(manifest['omd-deepen']).toBeUndefined();
  });

  test('修剪不碰第三方: 不在清单里的目标目录从不删', () => {
    writeSkill(dst, 'investigate', '# 别的来源装的');
    installClientSkills({ srcRoot: src, dstRoot: dst });
    expect(readSkill(dst, 'investigate')).toBe('# 别的来源装的');
  });

  test('opt-out: OMD_INSTALL_SKILLS=0 → 整体跳过, 不建目录', () => {
    const prev = process.env.OMD_INSTALL_SKILLS;
    process.env.OMD_INSTALL_SKILLS = '0';
    try {
      const s = installClientSkills({ srcRoot: src, dstRoot: dst });
      expect(s.reason).toContain('opt-out');
      expect(existsSync(dst)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OMD_INSTALL_SKILLS;
      else process.env.OMD_INSTALL_SKILLS = prev;
    }
  });

  test('无源目录 → best-effort 返回 reason, 不抛', () => {
    const s = installClientSkills({ srcRoot: join(base, 'nonexistent'), dstRoot: dst });
    expect(s.reason).toBeTruthy();
    expect(s.installed).toEqual([]);
  });
});
