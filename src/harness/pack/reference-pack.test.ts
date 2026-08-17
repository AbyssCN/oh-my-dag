/**
 * 参考 pack (templates/packs/tdd-bugfix) 的常青闸:
 *  ① 它必须永远装得进 —— 它是全链闸 (A-1/A-2/A-3/卡校验/冲突/回执) 的活 fixture,
 *    装不进 = 要么闸变严了没跟文档, 要么模板坏了给作者抄错样板。
 *  ② 内容物经三层叠加真的可见 (playbook 3 步 / 两张卡 / skill)。
 *  ③ eval fixture 的判别力反向自检: 种 bug 世界上 fixture 自测**绿** (bug 没被既有测试
 *    盖住 —— eval 的前提) 而隐藏 oracle **红** (oracle 判得出 bug)。oracle 在错世界上
 *    不红 = oracle 是虚的, 整个 eval 白设。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentTemplates } from '../agent-templates';
import { loadPlaybooks } from '../playbook/load';
import { addPack, removePack } from './pack';

const PACK_DIR = join(import.meta.dir, '../../../templates/packs/tdd-bugfix');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-refpack-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('参考 pack: tdd-bugfix', () => {
  test('① 装得进且回执完整 · ② 三层叠加可见 · 可卸载', async () => {
    const cwd = tmp();
    const r = await addPack(cwd, PACK_DIR);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('bug-reproducer');
    expect(r.message).toContain('minimal-fixer');
    expect(r.message).toContain('tdd-bugfix (3 步, 判据已自证)');
    expect(r.message).toContain('skill: bugfix-triage');
    expect(r.message).toMatch(/内容哈希: [0-9a-f]{12}/);

    const pb = loadPlaybooks(cwd).get('tdd-bugfix');
    expect(pb?.steps).toHaveLength(3);
    expect(pb?.loop?.maxRounds).toBe(3);
    const cards = loadAgentTemplates({ root: cwd });
    expect(cards.get('bug-reproducer')?.description).toContain('复现');
    expect(cards.get('minimal-fixer')?.description).toContain('最小');

    expect(removePack(cwd, 'omd-pack-tdd-bugfix').ok).toBe(true);
    expect(loadPlaybooks(cwd).get('tdd-bugfix')).toBeUndefined();
  });

  test('③ eval fixture 判别力反向自检: 种 bug 世界自测绿、隐藏 oracle 红', () => {
    const world = tmp();
    cpSync(join(PACK_DIR, 'eval/tasks/broken-calc'), world, { recursive: true });
    // 前提: 既有测试没盖住 bug (否则任务在起点就红, eval 量不出"修复")
    const own = spawnSync('bun', ['test', '.'], { cwd: world, encoding: 'utf8' });
    expect(own.status).toBe(0);
    // 判别力: oracle 拷入后必须红 —— oracle 在错世界上不红 = oracle 是虚的
    cpSync(join(PACK_DIR, 'eval/oracle/regression.oracle.ts'), join(world, 'src', 'oracle.test.ts'));
    // 拷入 src/ 后相对 import 改写: oracle 源文件按 eval/oracle 相对路径写, 落地时指回本地实现
    const fix = spawnSync('bun', ['-e', `
      const fs = require('fs');
      const p = '${join(world, 'src', 'oracle.test.ts')}';
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace("'../tasks/broken-calc/src/split-bill'", "'./split-bill'"));
    `], { encoding: 'utf8' });
    expect(fix.status).toBe(0);
    const oracle = spawnSync('bun', ['test', 'src/oracle.test.ts'], { cwd: world, encoding: 'utf8' });
    expect(oracle.status).not.toBe(0);
    expect(`${oracle.stdout}${oracle.stderr}`).toContain('总和守恒');
  });
});
