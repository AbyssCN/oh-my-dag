/**
 * skill-manifest (C-3) 单元测试 — INV-14 / INV-15 / I-10 + PP-S02 / PP-S03 判定输入。
 *
 * 契约源: `docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md` §C-3。
 * 不变量 (与 skill-manifest.ts 顶部注释逐字对齐):
 *   INV-14 工具池 = natural ∩ allowed ∩ ¬red_lines.deny ∩ ¬plan.deny; ∪ / ⊇ 一律拒
 *                  skill.allowed_tools \ natural → escalations (PP-S02 不可抑制)
 *   INV-15 装载三支: (a) 有 checks → loaded (脚本即闸)
 *                  (b) 无 checks + 无 red_lines + 正文禁令句 → ban + ppS03:true
 *                  (c) 其它 → loaded
 *   I-10 / INV-5 散文探测只返 bool + 坐标; 模块内不含 摘录器类符号 (extract·summari·ze 与 ban 的组合形)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectProseViolation,
  intersectToolPool,
  listSkills,
  loadSkillManifest,
  SkillCheckSchema,
  SkillManifestSchema,
  SkillRedLineSchema,
  type PlanDeny,
  type SkillRedLine,
} from './skill-manifest';

// ── 工厂: 最小合法 manifest 基底 (skill_id/skill_version/description/body_ref/schema_version) ──
const BASE = {
  skill_id: 's1',
  skill_version: '1.0.0',
  description: 'desc',
  body_ref: 'SKILL.md' as const,
  schema_version: '1.0',
};

// ════════════════════════════════════════════════════════════════════════════════
// §1 manifest schema — 解析 + 拒收非法形状
// ════════════════════════════════════════════════════════════════════════════════
describe('SkillManifestSchema (C-3 §1 schema 解析与拒收)', () => {
  test('最小合法 manifest: checks / red_lines / allowed_tools 默认 []', () => {
    const m = SkillManifestSchema.parse(BASE);
    expect(m.checks).toEqual([]);
    expect(m.red_lines).toEqual([]);
    expect(m.allowed_tools).toEqual([]);
    expect(m.skill_id).toBe('s1');
    expect(m.skill_version).toBe('1.0.0');
    expect(m.body_ref).toBe('SKILL.md');
    expect(m.schema_version).toBe('1.0');
  });

  test('缺 skill_id / skill_version / body_ref / schema_version 任一必填 → 拒收', () => {
    const { skill_id: _a, ...r1 } = BASE;
    expect(SkillManifestSchema.safeParse(r1).success).toBe(false);
    const { skill_version: _b, ...r2 } = BASE;
    expect(SkillManifestSchema.safeParse(r2).success).toBe(false);
    const { body_ref: _c, ...r3 } = BASE;
    expect(SkillManifestSchema.safeParse(r3).success).toBe(false);
    const { schema_version: _d, ...r4 } = BASE;
    expect(SkillManifestSchema.safeParse(r4).success).toBe(false);
  });

  test('skill_id / skill_version / schema_version 空串 → 拒收 (min(1))', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, skill_id: '' }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, skill_version: '' }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, schema_version: '' }).success).toBe(false);
  });

  test('description 必填但允许空串 (无 min 约束)', () => {
    const m = SkillManifestSchema.parse({ ...BASE, description: '' });
    expect(m.description).toBe('');
    const { description: _omit, ...noDesc } = BASE;
    expect(SkillManifestSchema.safeParse(noDesc).success).toBe(false);
  });

  test('body_ref 锁死 "SKILL.md" 字面量 (其它/小写/空串 → 拒收)', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, body_ref: 'SKILL.md' }).success).toBe(true);
    expect(SkillManifestSchema.safeParse({ ...BASE, body_ref: 'README.md' }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, body_ref: 'skill.md' }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, body_ref: '' }).success).toBe(false);
  });

  test('SkillCheck: type 枚举 {script, inline}; 其它字面拒收', () => {
    const ok1 = { ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 1 }] };
    expect(SkillManifestSchema.safeParse(ok1).success).toBe(true);
    const ok2 = { ...BASE, checks: [{ name: 'c', type: 'inline', pass_rule: 'r', timeout_sec: 1 }] };
    expect(SkillManifestSchema.safeParse(ok2).success).toBe(true);
    const bad = { ...BASE, checks: [{ name: 'c', type: 'other', pass_rule: 'r', timeout_sec: 1 }] };
    expect(SkillManifestSchema.safeParse(bad).success).toBe(false);
  });

  test('SkillCheck: timeout_sec 必须正整数 (0 / 负数 / 小数 → 拒收)', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 0 }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: -1 }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 1.5 }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 1 }] }).success).toBe(true);
  });

  test('SkillCheck: 缺 name / pass_rule 或空串 → 拒收 (min(1))', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ type: 'script', pass_rule: 'r', timeout_sec: 1 }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: '', type: 'script', pass_rule: 'r', timeout_sec: 1 }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, checks: [{ name: 'c', type: 'script', pass_rule: '', timeout_sec: 1 }] }).success).toBe(false);
  });

  test('SkillRedLine: action 锁死 "deny" (allow / 缺 / 其它 → 拒收)', () => {
    const ok = { ...BASE, red_lines: [{ action: 'deny', target_tool: 'bash', arg_match: '' }] };
    expect(SkillManifestSchema.safeParse(ok).success).toBe(true);
    expect(SkillManifestSchema.safeParse({ ...BASE, red_lines: [{ action: 'allow', target_tool: 'bash', arg_match: '' }] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, red_lines: [{ target_tool: 'bash', arg_match: '' }] }).success).toBe(false);
  });

  test('SkillRedLine: 空 target_tool → 拒收 (min(1))', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, red_lines: [{ action: 'deny', target_tool: '', arg_match: '' }] }).success).toBe(false);
  });

  test('allowed_tools 元素必须 string (数字 / null / 缺 → 拒收)', () => {
    expect(SkillManifestSchema.safeParse({ ...BASE, allowed_tools: ['bash', 123 as unknown as string] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, allowed_tools: ['bash', null as unknown as string] }).success).toBe(false);
    expect(SkillManifestSchema.safeParse({ ...BASE, allowed_tools: ['bash', 'read'] }).success).toBe(true);
  });

  test('顶层非 object → 拒收', () => {
    expect(SkillManifestSchema.safeParse('not an object').success).toBe(false);
    expect(SkillManifestSchema.safeParse(null).success).toBe(false);
    expect(SkillManifestSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  test('SkillCheckSchema / SkillRedLineSchema 单独可解析 (子件 sanity)', () => {
    expect(SkillCheckSchema.safeParse({ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 5 }).success).toBe(true);
    expect(SkillRedLineSchema.safeParse({ action: 'deny', target_tool: 'bash', arg_match: '*' }).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 INV-14 工具池交集 — 单向收紧, ∪ / ⊇ 一律拒
// ════════════════════════════════════════════════════════════════════════════════
describe('intersectToolPool (INV-14 单向收紧, ∪/⊇ 一律拒)', () => {
  const NAT = ['bash', 'read', 'write'] as const;
  const noRed: SkillRedLine[] = [];
  const noPlan: PlanDeny[] = [];

  test('skill allowed ⊇ natural + 无 deny → effective ⊆ natural, escalations = allowed \\ natural, ppS02=true', () => {
    const r = intersectToolPool(NAT, { allowed_tools: ['bash', 'read', 'write', 'extra'], red_lines: noRed }, noPlan);
    expect(r.effective).toEqual(['bash', 'read', 'write']); // ∪/⊇ 一律拒 → 不扩张
    expect(r.escalations).toEqual(['extra']);
    expect(r.ppS02).toBe(true);
  });

  test('skill allowed ⊊ natural → effective = 严格交集 (无扩张)', () => {
    const r = intersectToolPool(NAT, { allowed_tools: ['read'], red_lines: noRed }, noPlan);
    expect(r.effective).toEqual(['read']);
    expect(r.escalations).toEqual([]);
    expect(r.ppS02).toBe(false);
  });

  test('red_lines.deny 从 effective 中剔除 (skill 自报 deny)', () => {
    const r = intersectToolPool(NAT, { allowed_tools: [...NAT], red_lines: [{ action: 'deny', target_tool: 'bash', arg_match: '' }] }, noPlan);
    expect(r.effective).toEqual(['read', 'write']);
    expect(r.ppS02).toBe(false);
  });

  test('plan.deny 从 effective 中剔除 (计划层 deny 独立于 skill)', () => {
    const r = intersectToolPool(NAT, { allowed_tools: [...NAT], red_lines: noRed }, [{ target_tool: 'read', arg_match: '' }]);
    expect(r.effective).toEqual(['bash', 'write']);
  });

  test('red_lines.deny ∩ plan.deny 同时生效 (联合收紧)', () => {
    const r = intersectToolPool(NAT, { allowed_tools: [...NAT], red_lines: [{ action: 'deny', target_tool: 'bash', arg_match: '' }] }, [{ target_tool: 'read', arg_match: '' }]);
    expect(r.effective).toEqual(['write']);
  });

  test('effective ⊆ natural 恒成立 (skill ⊃ natural 不导致扩张 — ∪/⊇ 一律拒 实证)', () => {
    const r = intersectToolPool(['bash'], { allowed_tools: ['bash', 'read', 'write', 'net'], red_lines: [] }, []);
    expect(r.effective.every((t) => t === 'bash')).toBe(true); // 仅 natural 成员
    expect(r.effective).toEqual(['bash']); // 不扩张
    expect(r.escalations).toEqual(['net', 'read', 'write']);
    expect(r.ppS02).toBe(true);
  });

  test('空 natural → effective 空, escalations = 所有 allowed (全提权)', () => {
    const r = intersectToolPool([], { allowed_tools: ['bash', 'read'], red_lines: [] }, []);
    expect(r.effective).toEqual([]);
    expect(r.escalations).toEqual(['bash', 'read']);
    expect(r.ppS02).toBe(true);
  });

  test('空 allowed → effective 空, escalations 空, ppS02=false (零声明 = 零工具)', () => {
    const r = intersectToolPool(NAT, { allowed_tools: [], red_lines: noRed }, noPlan);
    expect(r.effective).toEqual([]);
    expect(r.escalations).toEqual([]);
    expect(r.ppS02).toBe(false);
  });

  test('effective + escalations 都按字典序排序', () => {
    const r = intersectToolPool(['zeta', 'alpha', 'mu'], { allowed_tools: ['zeta', 'alpha', 'mu', 'extra_b', 'extra_a'], red_lines: [] }, []);
    expect(r.effective).toEqual(['alpha', 'mu', 'zeta']);
    expect(r.escalations).toEqual(['extra_a', 'extra_b']);
  });

  test('escalations 来自 allowed \\ natural, 与 deny/red_lines/plan 无关 (提权 = 声明问题 ≠ 拒绝问题)', () => {
    // 'x' 不在 natural, skill 同时声明 + 自报 deny → 仍属 escalation (越权声明本身就是问题)
    const r = intersectToolPool(['bash'], { allowed_tools: ['bash', 'x'], red_lines: [{ action: 'deny', target_tool: 'x', arg_match: '' }] }, []);
    expect(r.escalations).toEqual(['x']);
    expect(r.ppS02).toBe(true);
    expect(r.effective).toEqual(['bash']); // x 不在 natural → 不进 effective, 即使 deny 也无意义
  });

  test('escalations 内部去重 (allowed 含重复声明)', () => {
    const r = intersectToolPool(['bash'], { allowed_tools: ['bash', 'x', 'x', 'x'], red_lines: [] }, []);
    expect(r.escalations).toEqual(['x']);
    expect(r.ppS02).toBe(true);
  });

  test('natural 不修改 (只读语义) — 函数返回的 effective/escalations 不与 natural 共享引用', () => {
    const natural = ['bash', 'read'];
    const r = intersectToolPool(natural, { allowed_tools: ['bash', 'read', 'x'], red_lines: [] }, []);
    expect(natural).toEqual(['bash', 'read']); // 自然池未被改动
    expect(r.effective).not.toBe(natural as unknown as string[]); // 不同数组
  });

  test('PP-S02 判定输入齐备: { effective, escalations, ppS02: escalations.length > 0 }', () => {
    const r1 = intersectToolPool(NAT, { allowed_tools: [...NAT], red_lines: noRed }, noPlan);
    expect(r1.ppS02).toBe(false);
    expect(r1.escalations.length).toBe(0);
    const r2 = intersectToolPool(NAT, { allowed_tools: ['bash', 'evil_tool'], red_lines: noRed }, noPlan);
    expect(r2.ppS02).toBe(true);
    expect(r2.escalations).toContain('evil_tool');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 INV-15 分支 2 启发式 — detectProseViolation 仅返 bool + 坐标
// ════════════════════════════════════════════════════════════════════════════════
describe('detectProseViolation (INV-15 分支 2 启发式: 仅返 bool + 坐标)', () => {
  test('空 body → hasBan=false, hits=[]', () => {
    expect(detectProseViolation('')).toEqual({ hasBan: false, hits: [] });
  });

  test('干净正文 → hasBan=false, hits=[]', () => {
    const r = detectProseViolation('# Title\n\nNormal prose without any markers.\n');
    expect(r.hasBan).toBe(false);
    expect(r.hits).toEqual([]);
  });

  test.each([
    ['绝对禁止'],
    ['严禁'],
    ['never'],
    ['must not'],
  ])('命中 marker "%s" → hasBan=true + 单 hit, marker 字面保留原大小写', (marker) => {
    const r = detectProseViolation(`line one\nthis ${marker} appears here\n`);
    expect(r.hasBan).toBe(true);
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]!.marker).toBe(marker);
  });

  test('英文 marker 大小写不敏感 (NEVER / Must Not / MuSt NoT 均命中)', () => {
    expect(detectProseViolation('NEVER do X').hasBan).toBe(true);
    expect(detectProseViolation('Must Not do X').hasBan).toBe(true);
    expect(detectProseViolation('MuSt NoT happen').hasBan).toBe(true);
    // marker 字面仍是小写 (源不变)
    expect(detectProseViolation('NEVER').hits[0]!.marker).toBe('never');
  });

  test('行/列 坐标 1-indexed, col 为 marker 起点 (无上下文起点错位)', () => {
    // 'foo bar never baz' — 字符索引 8 处开始 'never' → col 9 (1-indexed)
    const r = detectProseViolation('foo bar never baz');
    expect(r.hits[0]!.line).toBe(1);
    expect(r.hits[0]!.col).toBe(9);
    expect(r.hits[0]!.marker).toBe('never');
  });

  test('多行 → line 坐标按 1-indexed 行号定位', () => {
    const body = 'line1 clean\nline2 严禁 this\nline3 clean';
    const r = detectProseViolation(body);
    expect(r.hits[0]!.line).toBe(2);
    expect(r.hits[0]!.marker).toBe('严禁');
  });

  test('同行多次同 marker → 全部上报 (while 循环非贪婪终止)', () => {
    // 'never and never' — 首次 idx=0 (col 1), from=5, 二次 idx=10 (col 11)
    const r = detectProseViolation('never and never');
    expect(r.hits.length).toBe(2);
    expect(r.hits[0]!.col).toBe(1);
    expect(r.hits[1]!.col).toBe(11);
  });

  test('跨行 + 多 marker 共存 → 全部按扫描顺序上报', () => {
    const body = '绝对禁止 + never\nmust not on line 2\n严禁 on line 3';
    const r = detectProseViolation(body);
    expect(r.hits.length).toBe(4);
    expect(r.hits.map((h) => `${h.line}:${h.marker}`)).toEqual([
      '1:绝对禁止',
      '1:never',
      '2:must not',
      '3:严禁',
    ]);
  });

  test('hits 仅含 line / col / marker 三键 (无 context/sentence/snippet — INV-5/I-10 硬闸)', () => {
    const r = detectProseViolation('context before never context after');
    const keys = Object.keys(r.hits[0]!).sort();
    expect(keys).toEqual(['col', 'line', 'marker']);
  });

  test('返回值仅含 hasBan + hits 两键 (无 extract/sentence/list/summary 字段)', () => {
    const r1 = detectProseViolation('any');
    expect(Object.keys(r1).sort()).toEqual(['hasBan', 'hits']);
    const r2 = detectProseViolation('never');
    expect(Object.keys(r2).sort()).toEqual(['hasBan', 'hits']);
  });

  test('marker 不包含周围文本 (INV-5: 不摘录/不复述禁令内容)', () => {
    const r = detectProseViolation('surrounding sentence with never inside it');
    expect(r.hits[0]!.marker).toBe('never');
    expect(r.hits[0]!.marker.length).toBe(5);
    expect(r.hits[0]!.marker).not.toContain('surrounding');
    expect(r.hits[0]!.marker).not.toContain('sentence');
  });

  test('CRLF 行尾 (\\r\\n) 也按 \\n 切行 (跨平台鲁棒)', () => {
    const r = detectProseViolation('line1\r\n严禁 here\r\nline3');
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]!.line).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 INV-15 三分支装载 — loadSkillManifest 路由
// ════════════════════════════════════════════════════════════════════════════════
describe('loadSkillManifest (INV-15 三分支装载 + 路由)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-manifest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSkill(manifest: object, body: string): Promise<void> {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'SKILL.md'), body);
  }
  const baseM = {
    skill_id: 's', skill_version: '1.0.0', description: 'd',
    body_ref: 'SKILL.md', schema_version: '1.0',
  };

  test('分支 a: 有 checks → kind=loaded (即使 body 含禁令句, 脚本即闸优先)', async () => {
    await writeSkill(
      { ...baseM, checks: [{ name: 'c', type: 'script', pass_rule: 'r', timeout_sec: 5 }] },
      '正文严禁这么做\n绝对禁止 other\n',
    );
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('loaded');
    if (r.kind === 'loaded') {
      expect(r.manifest.checks.length).toBe(1);
    }
  });

  test('分支 b: 无 checks + 无 red_lines + 正文含禁令句 → kind=ban + ppS03=true', async () => {
    await writeSkill(baseM, '绝对禁止 something\n');
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('ban');
    if (r.kind === 'ban') {
      expect(r.ppS03).toBe(true);
      expect(r.ban.hasBan).toBe(true);
      expect(r.ban.hits[0]!.marker).toBe('绝对禁止');
    }
  });

  test('分支 b 边缘: 有 red_lines 但无 checks + 正文含禁令 → kind=loaded (red_lines 优先于正文禁令)', async () => {
    await writeSkill(
      { ...baseM, red_lines: [{ action: 'deny', target_tool: 'bash', arg_match: '' }] },
      '正文含 严禁 + never\n',
    );
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('loaded');
  });

  test('分支 c: 无 checks + 无 red_lines + 干净正文 → kind=loaded', async () => {
    await writeSkill(baseM, 'Just clean prose without markers.\n');
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('loaded');
  });

  test('manifest.json 不是合法 JSON → kind=invalid', async () => {
    await writeFile(join(dir, 'manifest.json'), '{not json');
    await writeFile(join(dir, 'SKILL.md'), 'body');
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.error).toMatch(/not JSON/);
    }
  });

  test('manifest.json 缺 → kind=invalid (file read 失败)', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'body');
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.error).toMatch(/read/);
    }
  });

  test('SKILL.md 缺 → kind=invalid (file read 失败)', async () => {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(baseM));
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.error).toMatch(/read/);
    }
  });

  test('manifest.json zod 拒收 (缺必填) → kind=invalid + 错误含 zod 字样', async () => {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...baseM, skill_id: undefined })); // undefined → JSON 省略
    await writeFile(join(dir, 'SKILL.md'), 'body');
    const r = await loadSkillManifest(dir);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.error).toMatch(/zod/);
    }
  });

  test('分支 b → orchestrator 传空 allowed_tools → intersectToolPool 零扩展 (保守默认实证)', async () => {
    await writeSkill(baseM, '绝对禁止 + never + must not\n');
    const loaded = await loadSkillManifest(dir);
    expect(loaded.kind).toBe('ban');
    if (loaded.kind !== 'ban') return;
    // 保守默认: tool_pool 零扩展 → 调用方传 allowed_tools: []
    const pool = intersectToolPool(
      ['bash', 'read', 'write'],
      { allowed_tools: [], red_lines: loaded.manifest.red_lines },
      [],
    );
    expect(pool.effective).toEqual([]);
    expect(pool.ppS02).toBe(false); // 没声明 → 没提权
  });

  test('listSkills: 扫目录子目录, 跳过 invalid, 按目录名升序', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-list-'));
    try {
      const a = join(root, 'a-skill');
      const b = join(root, 'b-skill');
      const bad = join(root, 'c-bad');
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await mkdir(bad, { recursive: true });
      await writeFile(join(a, 'manifest.json'), JSON.stringify({ ...baseM, skill_id: 'a' }));
      await writeFile(join(a, 'SKILL.md'), 'clean');
      await writeFile(join(b, 'manifest.json'), JSON.stringify({ ...baseM, skill_id: 'b' }));
      await writeFile(join(b, 'SKILL.md'), 'clean');
      await writeFile(join(bad, 'manifest.json'), '{garbage');
      await writeFile(join(bad, 'SKILL.md'), 'x');
      const all = await listSkills(root);
      expect(all.map((m) => m.skill_id)).toEqual(['a', 'b']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('listSkills: "ban" 与 "loaded" 同时收 (按 kind 路由由调用方处理)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-list-ban-'));
    try {
      const clean = join(root, 'a-clean');
      const banned = join(root, 'b-banned');
      await mkdir(clean, { recursive: true });
      await mkdir(banned, { recursive: true });
      await writeFile(join(clean, 'manifest.json'), JSON.stringify({ ...baseM, skill_id: 'a' }));
      await writeFile(join(clean, 'SKILL.md'), 'clean');
      await writeFile(join(banned, 'manifest.json'), JSON.stringify({ ...baseM, skill_id: 'b' }));
      await writeFile(join(banned, 'SKILL.md'), '正文严禁\n');
      const all = await listSkills(root);
      // b-banned 进 listSkills 返回 (含 ban.kind); 调用方按 outcome.kind 二次分流
      expect(all.map((m) => m.skill_id).sort()).toEqual(['a', 'b']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §5 I-10 — 模块源码不含「从散文摘取红线」类符号 (INV-5 全仓 ugrep 硬闸守护)
// ════════════════════════════════════════════════════════════════════════════════
describe('I-10: skill-manifest.ts 不含 摘录器类符号 (extract·summari·ze 与 ban 的组合形)', () => {
  let codeOnly: string;
  beforeAll(async () => {
    const src = await readFile('src/harness/skill-manifest.ts', 'utf8');
    // 剥注释后再做标识符断言: 块注释 + 行注释; 不动字符串字面 (避免误改代码形)
    codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
      .replace(/\/\/[^\n]*/g, '');        // // ...
  });

  // 任何「动词+禁令名词」组合的标识符都不该出现
  const COMPOSITE = /\b(?:extract|summariz|pars)(?:e|ing|ed|es)?[A-Z]?\w*(?:RedLine|RedLines|Ban|Banned|Prose|ProseBan|Constraint|Constraints|Rule|Rules)\w*/i;

  test('代码段无 extract*/summarize*/parse* + RedLine/Ban/Prose/Rule/Constraint 组合标识符', () => {
    expect(codeOnly).not.toMatch(COMPOSITE);
  });

  test('代码段不含具体禁名 (extractRedLine / summarizeBan / parseProse / 等)', () => {
    const explicit = [
      'extractBan', 'extractRedLine', 'extractRedLines', 'extractProse', 'extractProseBan',
      'summarizeBan', 'summarizeRedLine', 'summarizeRule', 'summarizeProse',
      'parseProseBan', 'parseBan', 'parseRedLine', 'parseConstraint',
    ];
    for (const name of explicit) {
      expect(codeOnly).not.toContain(name);
    }
  });

  test('export 函数列表无 extract*/summarize*/parse* 开头', () => {
    const fnRe = /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm;
    const names = [...codeOnly.matchAll(fnRe)].map((m) => m[1]!);
    expect(names.some((n) => /^(extract|summarize|parse)/i.test(n))).toBe(false);
    // sanity: 关键函数名应仍在
    expect(names).toContain('intersectToolPool');
    expect(names).toContain('detectProseViolation');
    expect(names).toContain('loadSkillManifest');
    expect(names).toContain('listSkills');
  });

  test('export const/let 列表无 extract*/summarize*/parse* 开头', () => {
    const declRe = /^\s*export\s+(?:const|let|var)\s+(\w+)/gm;
    const names = [...codeOnly.matchAll(declRe)].map((m) => m[1]!);
    expect(names.some((n) => /^(extract|summarize|parse)/i.test(n))).toBe(false);
    // sanity: 关键 schema / 类型名仍在
    expect(names).toContain('SkillCheckSchema');
    expect(names).toContain('SkillRedLineSchema');
    expect(names).toContain('SkillManifestSchema');
  });

  test('PROSE_BAN_MARKERS 字面集合与契约一致 (sanity 锚点)', () => {
    // I-10 的硬闸由全仓 ugrep 守护; 这里锚定模块源中 PROSE_BAN_MARKERS 包含全部 4 个 marker
    expect(codeOnly).toMatch(/PROSE_BAN_MARKERS\s*=\s*\[[^\]]*绝对禁止/);
    expect(codeOnly).toMatch(/PROSE_BAN_MARKERS\s*=\s*\[[^\]]*严禁/);
    expect(codeOnly).toMatch(/PROSE_BAN_MARKERS\s*=\s*\[[^\]]*never/);
    expect(codeOnly).toMatch(/PROSE_BAN_MARKERS\s*=\s*\[[^\]]*must not/);
  });
});