import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifySkill,
  compileSkill,
  compileSkills,
  contentHash,
  extractInvocation,
  loadSkillSource,
  postValidateDistilled,
  renderCardFile,
  suggestSkills,
  type Distilled,
} from '../../src/harness/skills/compile';
import { loadAgentTemplates } from '../../src/harness/agent-templates';

// skills → 引擎件编译器 (SDD 2026-07-25 S3): 分类确定性 CMP-1 / 哈希冻结 CMP-2 /
// 产物即注册 CMP-3 / opt-in CMP-4。全程 fake distill, 不碰 live 模型。

/** 造一个临时 skills 池。value = SKILL.md 内容; 键含 '/' 时前半是 skill 名后半是附属文件。 */
function tmpSkills(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'omd-skills-'));
  for (const [key, content] of Object.entries(files)) {
    const [skill, sub] = key.includes('/') ? [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)] : [key, 'SKILL.md'];
    mkdirSync(join(root, skill!), { recursive: true });
    writeFileSync(join(root, skill!, sub!), content);
  }
  return root;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omd-compile-root-'));
}

const CRAFT_MD = ['---', 'name: tasteful', 'description: UI taste and hierarchy craft', '---', '# Method', 'Design with one primary action per view.'].join('\n');
const CAP_MD = [
  '---',
  'name: vid',
  'description: video → notes pipeline',
  '---',
  '需要 browser-harness 接管 enumerate 阶段。',
  '```bash',
  '# 跑管线',
  'python run.py --urls list.txt',
  '```',
].join('\n');
const HOST_MD = ['---', 'name: imchat', 'description: send messages', '---', '用 lark-cli 发消息, 需要登录态。'].join('\n');

const okDistill = (d: Partial<Distilled> = {}) => {
  let calls = 0;
  const fn = async (): Promise<Distilled> => {
    calls++;
    return { description: 'Distilled taste card', body: 'You are a taste specialist. Keep hierarchy tight and states complete at all times.', evidence: null, ...d };
  };
  return { fn, calls: () => calls };
};

describe('CMP-1 分类确定性', () => {
  test('craft: 无脚本无宿主标记', () => {
    const root = tmpSkills({ tasteful: CRAFT_MD });
    expect(classifySkill(loadSkillSource(root, 'tasteful')!)).toEqual({ kind: 'craft' });
  });

  test('capability: 脚本存在且被引用; 优先于宿主标记 (omd-video 形状)', () => {
    const root = tmpSkills({ vid: CAP_MD, 'vid/run.py': 'print(1)' });
    const cls = classifySkill(loadSkillSource(root, 'vid')!);
    expect(cls).toEqual({ kind: 'capability', scriptFile: 'run.py', invocation: 'python run.py --urls list.txt' });
  });

  test('capability: 脚本存在但未被 SKILL.md 引用 → 不算 (防误判杂物文件)', () => {
    const root = tmpSkills({ x: CRAFT_MD, 'x/helper.sh': 'echo hi' });
    expect(classifySkill(loadSkillSource(root, 'x')!).kind).toBe('craft');
  });

  test('skip: 宿主标记 + 原因', () => {
    const root = tmpSkills({ imchat: HOST_MD });
    const cls = classifySkill(loadSkillSource(root, 'imchat')!);
    expect(cls.kind).toBe('skip');
    if (cls.kind === 'skip') expect(cls.reason).toContain('lark-cli');
  });

  test('extractInvocation: 只取 fence 内非注释行; 提不到 → null', () => {
    expect(extractInvocation(CAP_MD, 'run.py')).toBe('python run.py --urls list.txt');
    expect(extractInvocation('正文提到 run.py 但没有代码块', 'run.py')).toBeNull();
  });
});

describe('CMP-2 哈希冻结缓存', () => {
  test('二次编译源未变 → cached, 蒸馏不再调; 源变 → 重蒸', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const root = tmpRoot();
    const d = okDistill();
    const opts = { root, skillsRoot, distill: d.fn };
    expect((await compileSkill('tasteful', opts)).status).toBe('card');
    expect((await compileSkill('tasteful', opts)).status).toBe('cached');
    expect(d.calls()).toBe(1);
    writeFileSync(join(skillsRoot, 'tasteful', 'SKILL.md'), `${CRAFT_MD}\nNew line.`);
    expect((await compileSkill('tasteful', opts)).status).toBe('card');
    expect(d.calls()).toBe(2);
  });
});

describe('CMP-3 产物即注册 (loadAgentTemplates 圆程)', () => {
  test('卡产物直接被现有注册表载入; evidence 词表内保留', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const root = tmpRoot();
    const d = okDistill({ evidence: 'ui-pixels' });
    const r = await compileSkill('tasteful', { root, skillsRoot, distill: d.fn });
    expect(r.status).toBe('card');
    const t = loadAgentTemplates({ root });
    expect(t.get('tasteful')?.description).toBe('Distilled taste card');
    expect(t.get('tasteful')?.evidence).toBe('ui-pixels');
    expect(t.get('tasteful')?.body).toContain('taste specialist');
  });

  test('蒸馏 evidence 词表外 → 产物无该字段 (与加载器同规则, 双层防线)', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const root = tmpRoot();
    const r = await compileSkill('tasteful', { root, skillsRoot, distill: okDistill({ evidence: 'bogus' }).fn });
    expect(r.status).toBe('card');
    expect(readFileSync((r as { path: string }).path, 'utf8')).not.toContain('evidence:');
  });

  test('能力型 → 配方文件 (command+script), 不进卡目录', async () => {
    const skillsRoot = tmpSkills({ vid: CAP_MD, 'vid/run.py': 'print(1)' });
    const root = tmpRoot();
    const r = await compileSkill('vid', { root, skillsRoot, distill: okDistill().fn });
    expect(r.status).toBe('recipe');
    const text = readFileSync((r as { path: string }).path, 'utf8');
    expect(text).toContain('command: python run.py --urls list.txt');
    expect(text).toContain('script: run.py');
    expect(existsSync(join(root, '.omd/agents/vid.md'))).toBe(false);
  });

  test('蒸馏超词数硬顶 / 抛错 → error, 不写盘', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const root = tmpRoot();
    const long = await compileSkill('tasteful', { root, skillsRoot, distill: okDistill({ body: 'word '.repeat(700) }).fn });
    expect(long.status).toBe('error');
    const boom = await compileSkill('tasteful', {
      root,
      skillsRoot,
      distill: async () => {
        throw new Error('model down');
      },
    });
    expect(boom.status).toBe('error');
    expect(existsSync(join(root, '.omd/agents/tasteful.md'))).toBe(false);
  });

  test('postValidateDistilled: description 压单行', () => {
    const v = postValidateDistilled('x', { description: 'a\n  b', body: 'long enough body for validation here', evidence: null });
    expect(v?.description).toBe('a b');
  });
});

describe('CMP-4 opt-in + suggest', () => {
  test('suggest 全池分类 + cached 标记, 零写盘', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD, imchat: HOST_MD, vid: CAP_MD, 'vid/run.py': 'x' });
    const root = tmpRoot();
    await compileSkill('tasteful', { root, skillsRoot, distill: okDistill().fn });
    const s = suggestSkills({ root, skillsRoot });
    expect(s.map((e) => [e.name, e.kind, e.cached])).toEqual([
      ['imchat', 'skip', false],
      ['tasteful', 'craft', true],
      ['vid', 'capability', false],
    ]);
  });

  test('--as card 覆盖: 带辅助脚本的 craft skill 强制蒸卡 (impeccable 形状)', async () => {
    const skillsRoot = tmpSkills({ vid: CAP_MD, 'vid/run.py': 'print(1)' });
    const root = tmpRoot();
    const r = await compileSkill('vid', { root, skillsRoot, distill: okDistill().fn, as: 'card' });
    expect(r.status).toBe('card');
    expect(existsSync(join(root, '.omd/agents/vid.md'))).toBe(true);
  });

  test('--as recipe 但无被引用脚本 → error', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const r = await compileSkill('tasteful', { root: tmpRoot(), skillsRoot, distill: okDistill().fn, as: 'recipe' });
    expect(r.status).toBe('error');
  });

  test('compileSkills: 未知 skill → error 不阻断其余', async () => {
    const skillsRoot = tmpSkills({ tasteful: CRAFT_MD });
    const r = await compileSkills(['ghost', 'tasteful'], { root: tmpRoot(), skillsRoot, distill: okDistill().fn });
    expect(r.map((x) => x.status)).toEqual(['error', 'card']);
  });
});

describe('渲染纯函数', () => {
  test('renderCardFile 是合法 frontmatter 卡 + 记 source_hash', () => {
    const text = renderCardFile('n', contentHash('src'), { description: 'd', body: 'b', evidence: 'ui-pixels' });
    expect(text.startsWith('---\nname: n\ndescription: d\nevidence: ui-pixels\n')).toBe(true);
    expect(text).toContain(`source_hash: ${contentHash('src')}`);
  });
});
