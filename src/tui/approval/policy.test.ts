/**
 * L1:审批分类判据(切片①)。
 *
 * 反向自检(每条闸当场证伪一次):
 * - 「config 不硬编码」那条:把 `write` 在 config 里改成 `read` → 分类跟着变。
 *   这同时证明档位真的由 config 驱动 —— 把 classifyToolCall 里的 `cfg.tiers[name]`
 *   换成写死的表,那条用例当场红。
 * - 「read 恒放行」那条:给 read 换一个凭证文件路径 → 升 read_sensitive,证明
 *   "read 不弹框"不是因为分类器根本不看参数。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APPROVAL_CONFIG,
  type ApprovalPolicyConfig,
  classifyToolCall,
  describeToolCall,
  loadApprovalConfig,
  protectedPathHit,
} from './policy';

const cfg = DEFAULT_APPROVAL_CONFIG;

describe('四档分类', () => {
  test('读半区 → read, 零 reasons(G-1: read 全程不弹框的判据源头)', () => {
    for (const name of ['read', 'ls', 'grep', 'omd_status', 'omd_recall', 'codegraph_search']) {
      const c = classifyToolCall(name, { path: 'src/x.ts' }, cfg);
      expect(c.tier, name).toBe('read');
      expect(c.reasons, name).toEqual([]);
    }
  });

  test('write / edit / omd_run → write + function 级原因', () => {
    for (const name of ['write', 'edit', 'omd_run']) {
      const c = classifyToolCall(name, { path: 'src/x.ts' }, cfg);
      expect(c.tier, name).toBe('write');
      expect(c.reasons[0], name).toBe('function 级 write');
    }
  });

  test('未登记的工具默认 write(fail-closed 方向), 不静默放行', () => {
    expect(classifyToolCall('some_new_tool', {}, cfg).tier).toBe('write');
  });

  test('读凭证文件 → read_sensitive(那道硬拒的正确形态)', () => {
    const c = classifyToolCall('read', { path: '.env' }, cfg);
    expect(c.tier).toBe('read_sensitive');
    expect(c.reasons.join()).toContain('.env');
    // 反向: 豁免表里的样例文件不升档
    expect(classifyToolCall('read', { path: '.env.example' }, cfg).tier).toBe('read');
  });

  test('bash: read_only 命令降 read(cat/git log 不弹框)', () => {
    expect(classifyToolCall('bash', { command: 'cat src/x.ts' }, cfg).tier).toBe('read');
    expect(classifyToolCall('bash', { command: 'git log --oneline -3' }, cfg).tier).toBe('read');
  });

  test('bash: scoped_write / 未登记命令 → write', () => {
    const c = classifyToolCall('bash', { command: 'bun test' }, cfg);
    expect(c.tier).toBe('write');
    expect(c.reasons.join()).toContain('风险级');
    expect(classifyToolCall('bash', { command: 'mkdir -p /tmp/x' }, cfg).tier).toBe('write');
  });

  test('bash: 不可逆子集 → admin(v5: 强制审批)', () => {
    for (const command of ['git push --force origin main', 'git reset --hard HEAD~3']) {
      const c = classifyToolCall('bash', { command }, cfg);
      expect(c.tier, command).toBe('admin');
      expect(c.reasons.join(), command).toContain('不可逆');
    }
  });

  test('bash: 尾环读凭证也要被看见 (ls && cat .env) → 至少 read_sensitive', () => {
    const c = classifyToolCall('bash', { command: 'ls && cat .env' }, cfg);
    // cat/ls 都是 read_only, 但凭证命中把它抬到 read_sensitive
    expect(c.tier).toBe('read_sensitive');
    expect(c.reasons.join()).toContain('.env');
  });

  test('★ 双级合并成一张单: function 级 write + 受保护清单 → 两条 reasons, 一个分类', () => {
    const withProtected: ApprovalPolicyConfig = { ...cfg, protectedPaths: ['src/model/seats.ts', 'docs/plan/'] };
    const c = classifyToolCall('edit', { path: 'src/model/seats.ts', oldText: 'a', newText: 'b' }, withProtected);
    expect(c.tier).toBe('write');
    expect(c.reasons).toEqual(['function 级 write', '目标在受保护清单 (src/model/seats.ts)']);
    // 目录前缀也命中
    const c2 = classifyToolCall('write', { path: 'docs/plan/x.md', content: '' }, withProtected);
    expect(c2.reasons.length).toBe(2);
    // 反向: 不在清单里的路径只有一条
    expect(classifyToolCall('write', { path: 'src/other.ts', content: '' }, withProtected).reasons.length).toBe(1);
  });

  test('★ 档位由 config 驱动, 不硬编码: config 把 write 改成 read → 分类跟着变', () => {
    const loosened: ApprovalPolicyConfig = { ...cfg, tiers: { ...cfg.tiers, write: 'read' } };
    expect(classifyToolCall('write', { path: 'x' }, loosened).tier).toBe('read');
  });
});

describe('protectedPathHit', () => {
  test('精确文件 / 目录前缀(带斜杠不带都行)/ 不误伤同前缀文件名', () => {
    expect(protectedPathHit('a/b.ts', ['a/b.ts'])).toBe('a/b.ts');
    expect(protectedPathHit('docs/plan/x.md', ['docs/plan/'])).toBe('docs/plan/');
    expect(protectedPathHit('docs/plan/x.md', ['docs/plan'])).toBe('docs/plan');
    // `docs/planning.md` 不该被 `docs/plan` 盖住 —— 前缀命中要求目录边界
    expect(protectedPathHit('docs/planning.md', ['docs/plan'])).toBe(null);
  });
});

describe('loadApprovalConfig', () => {
  test('没有 config 文件 → 默认表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-approval-'));
    expect(loadApprovalConfig(dir, {})).toEqual(DEFAULT_APPROVAL_CONFIG);
  });

  test('config 覆盖逐条合并; 四档之外的值被丢弃(只收紧或平移, 不放松出词表)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-approval-'));
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(
      join(dir, '.omd', 'config.json'),
      JSON.stringify({
        tui: {
          approvals: {
            tiers: { grep: 'write', bash: 'nonsense', my_ext_tool: 'read' },
            protectedPaths: ['src/model/seats.ts', 42],
            tokenTtlSec: 120,
          },
        },
      }),
    );
    const c = loadApprovalConfig(dir, {});
    expect(c.tiers.grep).toBe('write'); // 覆盖生效
    expect(c.tiers.bash).toBe('write'); // 非法值丢弃, 保默认
    expect(c.tiers.my_ext_tool).toBe('read'); // 新登记生效
    expect(c.protectedPaths).toEqual(['src/model/seats.ts']); // 非串条目丢弃
    expect(c.tokenTtlSec).toBe(120);
    expect(c.tiers.write).toBe('write'); // 没碰的保默认
  });

  test('坏 JSON → 默认表(fail-open 但不吞证据: 座位那侧自会响亮报)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-approval-'));
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), '{oops');
    expect(loadApprovalConfig(dir, {})).toEqual(DEFAULT_APPROVAL_CONFIG);
  });
});

describe('describeToolCall(卡片文案)', () => {
  test('edit → diff 形态; write → 字节数 + 内容预览; bash → 命令全文', () => {
    const e = describeToolCall('edit', { path: 'a.ts', oldText: 'x\ny', newText: 'z' });
    expect(e.summary).toBe('edit a.ts (-2 +1 行)');
    expect(e.preview).toEqual(['- x', '- y', '+ z']);
    const w = describeToolCall('write', { path: 'b.ts', content: 'hello\nworld' });
    expect(w.summary).toContain('11 字节');
    expect(w.preview).toEqual(['hello', 'world']);
    const b = describeToolCall('bash', { command: 'bun test\necho done' });
    expect(b.summary).toBe('bash: bun test');
    expect(b.preview).toEqual(['bun test', 'echo done']);
  });

  test('预览封顶, 超长说还有多少行(单条长工具输出能拖死 TUI, superpowers 教训同族)', () => {
    const w = describeToolCall('write', { path: 'x', content: Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n') });
    expect(w.preview.length).toBe(31);
    expect(w.preview[30]).toContain('还有 70 行');
  });
});
