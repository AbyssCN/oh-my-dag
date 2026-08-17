/**
 * A3 omd pack 判据 (吸收计划):
 *  ① 装含坏 playbook 的包被判据自证闸拒 (A-3: 判据在错样本上不失败 = 虚判据), .omd/ 零残留。
 *  ② 装好包后三层叠加生效 (loadAgentTemplates / loadPlaybooks 真装出) 且 omd_inspect 可见。
 *  ③ remove 后 byte 级回到装前。
 *  ④ 重复 add 同内容 no-op (幂等)。
 *  ⑤ 冲突 (目标存在且不属于本包) → 整包拒, 一个文件都不拷 (原子性)。
 *  ⑥ 用户改过的文件 remove 保留 (不吞用户的活)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentTemplates } from '../agent-templates';
import { createInspectTool } from '../inspect-tool';
import { loadPlaybooks } from '../playbook/load';
import { addPack, listPacks, removePack } from './pack';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-pack-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 造一个 pack 源目录。 */
function makePack(opts: {
  name: string;
  version?: string;
  agents?: Record<string, string>;
  playbooks?: Record<string, { json: unknown; docs?: Record<string, string> }>;
  skills?: Record<string, string>; // skillName → SKILL.md 内容
}): string {
  const dir = tmp();
  const decl: Record<string, string> = {};
  if (opts.agents) {
    decl.agents = './agents';
    mkdirSync(join(dir, 'agents'));
    for (const [f, c] of Object.entries(opts.agents)) writeFileSync(join(dir, 'agents', f), c);
  }
  if (opts.playbooks) {
    decl.playbooks = './playbooks';
    for (const [name, pb] of Object.entries(opts.playbooks)) {
      mkdirSync(join(dir, 'playbooks', name), { recursive: true });
      writeFileSync(join(dir, 'playbooks', name, 'playbook.json'), JSON.stringify(pb.json));
      for (const [f, c] of Object.entries(pb.docs ?? {})) writeFileSync(join(dir, 'playbooks', name, f), c);
    }
  }
  if (opts.skills) {
    decl.skills = './skills';
    for (const [name, c] of Object.entries(opts.skills)) {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), c);
    }
  }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: opts.name, ...(opts.version ? { version: opts.version } : {}), omd: { pack: decl } }),
  );
  return dir;
}

const GOOD_CARD = ['---', 'name: pack-card', 'description: 来自 pack 的测试卡', '---', '', 'persona 正文'].join('\n');

const goodPlaybook = (name: string) => ({
  json: {
    name,
    steps: [{ doc: '1_STEP.md' }],
    acceptance: {
      command: 'grep -qx DONE STATUS.md',
      negativeSample: { path: 'STATUS.md', content: 'NOT_DONE' },
    },
  },
  docs: { '1_STEP.md': '做第一步' },
});

/** 目录快照 (相对路径 → 内容哈希代替物: 原文)。 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, base: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, base);
      else if (statSync(p).isFile()) out[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(root, root);
  return out;
}

describe('omd pack', () => {
  test('① 坏 playbook (判据在错样本上恒绿 = 虚判据) → 整包拒 + .omd/ 零残留', async () => {
    const cwd = tmp();
    const before = snapshot(join(cwd, '.omd'));
    const src = makePack({
      name: 'bad-pack',
      agents: { 'card.md': GOOD_CARD },
      playbooks: {
        'hollow-pb': {
          json: {
            name: 'hollow-pb',
            steps: [{ doc: '1_STEP.md' }],
            // `true` 在错样本上照样退出 0 —— A-3 要拒的就是这种判不出错的判据
            acceptance: { command: 'true', negativeSample: { path: 'STATUS.md', content: 'x' } },
          },
          docs: { '1_STEP.md': 'x' },
        },
      },
    });
    const r = await addPack(cwd, src);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('playbook');
    // 零残留: 连 agents 那半也不许进 (原子性)
    expect(snapshot(join(cwd, '.omd'))).toEqual(before);
  });

  test('② 好包装入: 三层叠加生效 + omd_inspect 可见 + 账本落账', async () => {
    const cwd = tmp();
    const src = makePack({
      name: 'good-pack',
      version: '1.0.0',
      agents: { 'card.md': GOOD_CARD },
      playbooks: { 'pack-pb': goodPlaybook('pack-pb') },
      skills: { 'pack-skill': '# Pack Skill\n\n一句话。' },
    });
    const r = await addPack(cwd, src);
    expect(r.ok).toBe(true);
    // 叠加机制真的看得见它们 (不是只拷了文件)
    expect(loadAgentTemplates({ root: cwd }).get('pack-card')?.description).toBe('来自 pack 的测试卡');
    expect(loadPlaybooks(cwd).get('pack-pb')?.steps).toHaveLength(1);
    // omd_inspect 可见
    const [tool] = createInspectTool({ cwd });
    const agents = (await tool!.execute('t', { what: 'agents' })).content[0] as { text: string };
    expect(agents.text).toContain('pack-card');
    // 账本
    const ledger = JSON.parse(readFileSync(join(cwd, '.omd', 'packs.json'), 'utf8'));
    expect(Object.keys(ledger.packs['good-pack'].files).length).toBeGreaterThanOrEqual(4);
    expect(listPacks(cwd).message).toContain('good-pack@1.0.0');
  });

  test('③ remove 后 byte 级回到装前 · ④ 重复 add 幂等', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'unrelated.json'), '{"mine": true}');
    const before = snapshot(join(cwd, '.omd'));
    const src = makePack({ name: 'p3', agents: { 'card.md': GOOD_CARD } });
    expect((await addPack(cwd, src)).ok).toBe(true);
    // ④ 幂等
    const again = await addPack(cwd, src);
    expect(again.ok).toBe(true);
    expect(again.message).toContain('no-op');
    // ③ remove 回到装前 (packs.json 会留一个空账本文件, 单独豁免并断言其内容为空账)
    expect(removePack(cwd, 'p3').ok).toBe(true);
    const after = snapshot(join(cwd, '.omd'));
    const ledger = JSON.parse(after['packs.json']!);
    expect(ledger.packs).toEqual({});
    delete after['packs.json'];
    expect(after).toEqual(before);
  });

  test('⑤ 冲突: 目标存在且不属于本包 → 整包拒, 一个文件都不拷', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd', 'agents'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'agents', 'card.md'), '项目自己的卡, 不许覆盖');
    const before = snapshot(join(cwd, '.omd'));
    const src = makePack({
      name: 'p5',
      agents: { 'card.md': GOOD_CARD },
      skills: { s1: '# s1\n' },
    });
    const r = await addPack(cwd, src);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不属于本包');
    expect(snapshot(join(cwd, '.omd'))).toEqual(before);
  });

  test('⑥ 用户改过的文件: remove 保留不删', async () => {
    const cwd = tmp();
    const src = makePack({ name: 'p6', agents: { 'card.md': GOOD_CARD } });
    expect((await addPack(cwd, src)).ok).toBe(true);
    const installed = join(cwd, '.omd', 'agents', 'card.md');
    writeFileSync(installed, `${GOOD_CARD}\n\n用户补了一段`);
    const r = removePack(cwd, 'p6');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('保留');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf8')).toContain('用户补了一段');
  });
});
