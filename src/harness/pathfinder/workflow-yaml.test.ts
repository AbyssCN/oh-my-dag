/**
 * workflow yaml 语法/结构验证 (S2 · task D): yml 无法单测行为, 但至少证明两个 workflow 文件能被
 * YAML 解析器无错解析, 且关键结构 (触发口 / reusable pin / 注入防线) 就位。用 `yaml` 包解析。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const RESEARCH_WF = join(REPO_ROOT, '.github', 'workflows', 'dag-research.yml');
const CALLER_WF = join(REPO_ROOT, 'templates', 'path-research-caller.yml');

/** 读原文 (structural asserts 里做注入面文本检查用)。 */
function raw(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('workflow yaml 可解析 + 结构就位', () => {
  test('dag-research.yml: YAML 解析无错', () => {
    expect(() => parse(raw(RESEARCH_WF))).not.toThrow();
  });

  test('path-research-caller.yml: YAML 解析无错', () => {
    expect(() => parse(raw(CALLER_WF))).not.toThrow();
  });

  test('dag-research.yml: 三触发口齐 (issues.labeled / workflow_call / workflow_dispatch.dry_run)', () => {
    // `on` 在 YAML 1.2 (yaml 包默认) 是普通字符串键, 不被当布尔。
    const wf = parse(raw(RESEARCH_WF)) as { on?: Record<string, unknown> };
    const on = wf.on ?? {};
    expect(on.issues).toBeDefined();
    expect((on.issues as { types: string[] }).types).toContain('labeled');
    expect(on.workflow_call).toBeDefined();
    expect((on.workflow_dispatch as { inputs: { dry_run: unknown } }).inputs.dry_run).toBeDefined();
  });

  test('dag-research.yml: job 级 owner 权力闸 (github.repository_owner, 不硬编码用户名)', () => {
    const wf = parse(raw(RESEARCH_WF)) as { jobs: { research: { if: string } } };
    const gate = wf.jobs.research.if;
    expect(gate).toContain('github.actor');
    expect(gate).toContain('github.repository_owner');
    // 硬编码用户名会是字面 'AbyssCN'; 闸里不该出现。
    expect(gate).not.toContain('AbyssCN');
  });

  test('dag-research.yml: 注入面防线 — title/body 经 env 传, run 不内插 ${{ }}', () => {
    const text = raw(RESEARCH_WF);
    // env 里以受控名接收不可信输入。
    expect(text).toContain('TITLE: ${{ github.event.issue.title }}');
    expect(text).toContain('BODY: ${{ github.event.issue.body }}');
    // run 脚本经 shell 变量引用, 绝不把 issue title/body 的 ${{ }} 直接内插进命令。
    expect(text).not.toContain('dag-research.ts "${{');
    expect(text).toContain('"$QUERY"');
  });

  test('path-research-caller.yml: reusable pin @v1 + secrets inherit (D-F)', () => {
    const wf = parse(raw(CALLER_WF)) as { jobs: { research: { uses: string; secrets: string } } };
    const job = wf.jobs.research;
    expect(job.uses).toBe('AbyssCN/oh-my-dag/.github/workflows/dag-research.yml@v1');
    expect(job.secrets).toBe('inherit');
  });

  test('dag-research.yml: workflow_call 接 dry_run/issue inputs (canary 经 caller 转发, S4)', () => {
    const wf = parse(raw(RESEARCH_WF)) as { on?: { workflow_call?: { inputs?: Record<string, unknown> } } };
    const inputs = wf.on?.workflow_call?.inputs ?? {};
    expect(inputs.dry_run).toBeDefined();
    expect(inputs.issue).toBeDefined();
    // run 步骤统一读 inputs.* (workflow_call/dispatch 两路都填), 不再依赖 github.event.inputs.*。
    const text = raw(RESEARCH_WF);
    expect(text).toContain('DRY_RUN: ${{ inputs.dry_run }}');
  });

  test('path-research-caller.yml: workflow_dispatch 金丝雀入口 + 转发 with (S4 canary)', () => {
    const wf = parse(raw(CALLER_WF)) as {
      on?: { workflow_dispatch?: { inputs?: { dry_run?: unknown } } };
      jobs: { research: { with?: Record<string, unknown> } };
    };
    expect(wf.on?.workflow_dispatch?.inputs?.dry_run).toBeDefined();
    // caller 把 inputs 转发给中心 workflow (canary dry_run + issue)。
    expect(wf.jobs.research.with).toBeDefined();
    const text = raw(CALLER_WF);
    expect(text).toContain('dry_run: ${{ inputs.dry_run || false }}');
    expect(text).toContain('issue: ${{ inputs.issue }}');
  });
});
