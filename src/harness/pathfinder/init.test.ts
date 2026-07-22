/**
 * init 测试: 探测梯纯函数 (注入探针 fixture 全覆盖) + 推荐/报告 + 引导两步流 (缺参回报告 / 全参执行) +
 * gh 执行序 emission (GhRunner fixture 断言 label→issue→secret→dispatch→poll→introspect 调用序)。
 * gh 全程注入 fixture, **永不真调 gh/git** (backend.ts 同款 idiom)。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GhResult, GhRunner } from './backend';
import {
  type InitProbes,
  type PathfinderConfig,
  recommend,
  runInit,
  runProbeLadder,
} from './init';

const okr = (stdout: string): GhResult => ({ stdout, exitCode: 0, stderr: '' });

/** 全绿探针 (可覆盖单级) — 探测梯 fixture 基线。 */
function probes(over: Partial<InitProbes> = {}): InitProbes {
  return {
    isGitRepo: () => true,
    githubRemote: () => 'acme/repo',
    ghAuthScopes: () => ['repo', 'workflow'],
    repoVisibility: () => 'private',
    actionsEnabled: () => true,
    hasKey: () => true,
    ...over,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pf-init-'));
}

// ── 探测梯纯函数 ──────────────────────────────────────────────────────────────

describe('runProbeLadder (纯函数 + 注入探针)', () => {
  test('全绿 → ghReady, scope/key/actions 全齐', () => {
    const l = runProbeLadder(probes());
    expect(l.gitRepo).toBe(true);
    expect(l.remote).toBe('acme/repo');
    expect(l.authScopes).toEqual(['repo', 'workflow']);
    expect(l.missingScopes).toEqual([]);
    expect(l.actions).toBe(true);
    expect(l.keys).toEqual({ DEEPSEEK_API_KEY: true, TAVILY_API_KEY: true });
    expect(l.ghReady).toBe(true);
  });

  test('非 git 仓库 → 短路: remote/auth 不再探, ghReady false', () => {
    let remoteProbed = false;
    const l = runProbeLadder(
      probes({
        isGitRepo: () => false,
        githubRemote: () => {
          remoteProbed = true;
          return 'x/y';
        },
      }),
    );
    expect(l.gitRepo).toBe(false);
    expect(l.remote).toBeNull();
    expect(l.authScopes).toBeNull();
    expect(l.actions).toBe(false);
    expect(l.ghReady).toBe(false);
    expect(remoteProbed).toBe(false); // 上级失败, 下级不探
  });

  test('有 remote 但未认证 → ghReady false, 全 scope 缺', () => {
    const l = runProbeLadder(probes({ ghAuthScopes: () => null }));
    expect(l.remote).toBe('acme/repo');
    expect(l.authScopes).toBeNull();
    expect(l.missingScopes).toEqual(['repo', 'workflow']);
    expect(l.ghReady).toBe(false);
  });

  test('认证但缺 workflow scope → ghReady true (repo 够), missingScopes=[workflow]', () => {
    const l = runProbeLadder(probes({ ghAuthScopes: () => ['repo'] }));
    expect(l.ghReady).toBe(true);
    expect(l.missingScopes).toEqual(['workflow']);
  });

  test('缺一个 key → keys 反映有无', () => {
    const l = runProbeLadder(probes({ hasKey: (n) => n === 'DEEPSEEK_API_KEY' }));
    expect(l.keys).toEqual({ DEEPSEEK_API_KEY: true, TAVILY_API_KEY: false });
  });
});

describe('recommend (纯决策)', () => {
  test('全绿 → gh + cloudAfk on, 无 blocker', () => {
    const r = recommend(runProbeLadder(probes()));
    expect(r).toEqual({ backend: 'gh', cloudAfk: true, cloudBlockers: [] });
  });

  test('未就绪 → md + cloudAfk off', () => {
    const r = recommend(runProbeLadder(probes({ githubRemote: () => null })));
    expect(r.backend).toBe('md');
    expect(r.cloudAfk).toBe(false);
  });

  test('gh 就绪但缺 workflow scope + 缺 key → cloudAfk off, blocker 逐条列', () => {
    const r = recommend(runProbeLadder(probes({ ghAuthScopes: () => ['repo'], hasKey: () => false })));
    expect(r.backend).toBe('gh');
    expect(r.cloudAfk).toBe(false);
    expect(r.cloudBlockers.some((b) => b.includes('workflow scope'))).toBe(true);
    expect(r.cloudBlockers.some((b) => b.includes('缺机器级 key'))).toBe(true);
  });
});

// ── 引导两步流 ────────────────────────────────────────────────────────────────

describe('runInit 报告模式 (缺 backend → 探测报告 + 推荐)', () => {
  test('无 backend 参 → 回报告, 含推荐 + 两步引导示例', () => {
    const dir = tmp();
    try {
      const o = runInit({ destination: 'Ship X' }, { cwd: dir, env: {}, probes: probes(), gh: okrGh() });
      expect(o.isError).toBeUndefined();
      expect(o.text).toContain('探测报告');
      expect(o.text).toContain('推荐: backend=gh, cloudAfk=on');
      expect(o.text).toContain('path_init(');
      expect(o.text).toContain('backend="gh"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('public 仓 + cloudAfk 推荐 on → 报告含「决策历史公开可读」提示', () => {
    const dir = tmp();
    try {
      const o = runInit({}, { cwd: dir, env: {}, probes: probes({ repoVisibility: () => 'public' }), gh: okrGh() });
      expect(o.text).toContain('公开可读');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runInit md 执行 (退化本地图, 零 gh)', () => {
  test('建本地图 + config 落 backend:md', () => {
    const dir = tmp();
    try {
      const o = runInit({ destination: 'Local Only', backend: 'md' }, { cwd: dir, env: {}, probes: probes(), gh: throwGh() });
      expect(o.isError).toBeUndefined();
      expect(o.text).toContain('backend=md');
      // 本地图落盘。
      expect(existsSync(join(dir, 'docs', 'plan', 'pathfinder', 'local-only.md'))).toBe(true);
      // config 落盘 backend:md。
      const cfg = JSON.parse(readFileSync(join(dir, '.omd', 'pathfinder', 'config.json'), 'utf8')) as PathfinderConfig;
      expect(cfg.backend).toBe('md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runInit gh 执行序 emission', () => {
  test('全参 gh + cloudAfk: label→issue→secret→dispatch→poll→introspect 调用序 + config', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      let writtenCfg: PathfinderConfig | undefined;
      let workflowWritten: string | undefined;
      const o = runInit(
        { destination: 'Ship X', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk' },
          probes: probes(),
          gh,
          readTemplate: () => 'CALLER_YAML',
          writeWorkflow: (_p, c) => {
            workflowWritten = c;
          },
          writeConfig: (c) => {
            writtenCfg = c;
          },
          hasCentralWorkflow: () => false,
          canary: { sleep: () => {} },
        },
      );
      expect(o.isError).toBeUndefined();

      const verbs = calls.map((c) => `${c[0]} ${c[1] ?? ''}`.trim());
      // 序: label create ×N → issue create (map) → secret set ×2 → workflow run → run list → api graphql。
      const iLabel = verbs.indexOf('label create');
      const iIssue = verbs.indexOf('issue create');
      const iSecret = verbs.indexOf('secret set');
      const iDispatch = verbs.indexOf('workflow run');
      const iPoll = verbs.indexOf('run list');
      const iIntrospect = verbs.findIndex((v) => v.startsWith('api'));
      expect(iLabel).toBeGreaterThanOrEqual(0);
      expect(iLabel).toBeLessThan(iIssue);
      expect(iIssue).toBeLessThan(iSecret);
      expect(iSecret).toBeLessThan(iDispatch);
      expect(iDispatch).toBeLessThan(iPoll);
      expect(iPoll).toBeLessThan(iIntrospect);

      // 7 个 label 全建。
      expect(verbs.filter((v) => v === 'label create')).toHaveLength(7);
      // 两个 key 都 secret set (list 探已存在 → 空 → 全复制)。
      const secretNames = calls.filter((c) => c[0] === 'secret' && c[1] === 'set').map((c) => c[2]);
      expect(secretNames).toEqual(['DEEPSEEK_API_KEY', 'TAVILY_API_KEY']);
      // canary dispatch 传 dry_run=true + issue=map number。
      const dispatch = calls.find((c) => c[0] === 'workflow' && c[1] === 'run')!;
      expect(dispatch).toContain('dry_run=true');
      expect(dispatch).toContain('issue=7');

      // caller 写入 (非中心仓) + config 落 gh/capabilities/canary。
      expect(workflowWritten).toBe('CALLER_YAML');
      expect(writtenCfg?.backend).toBe('gh');
      expect(writtenCfg?.cloudAfk).toBe(true);
      expect(writtenCfg?.capabilities?.nativeDependencies).toBe(true); // fixture Issue 字段含 blockedByIssues
      expect(writtenCfg?.canary?.status).toBe('success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('中心仓 (已有 dag-research.yml) → 不拷 caller, 金丝雀直打 dag-research.yml', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      let workflowWritten = false;
      runInit(
        { destination: 'Self', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk' },
          probes: probes(),
          gh,
          writeWorkflow: () => {
            workflowWritten = true;
          },
          writeConfig: () => {},
          hasCentralWorkflow: () => true,
          canary: { sleep: () => {} },
        },
      );
      expect(workflowWritten).toBe(false);
      const dispatch = calls.find((c) => c[0] === 'workflow' && c[1] === 'run')!;
      expect(dispatch).toContain('dag-research.yml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cloudAfk=off → 只 label + map + config, 无 secret/dispatch', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      let writtenCfg: PathfinderConfig | undefined;
      const o = runInit(
        { destination: 'No Cloud', backend: 'gh', cloudAfk: false },
        { cwd: dir, env: {}, probes: probes(), gh, writeConfig: (c) => (writtenCfg = c), canary: { sleep: () => {} } },
      );
      expect(o.isError).toBeUndefined();
      expect(calls.some((c) => c[0] === 'secret')).toBe(false);
      expect(calls.some((c) => c[0] === 'workflow' && c[1] === 'run')).toBe(false);
      expect(writtenCfg).toEqual({ backend: 'gh', cloudAfk: false, capabilities: { nativeDependencies: false } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repo secret 已存在 → 跳过不覆写 (保护云端专用 keyset, 不冲成本机 key)', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      // 包一层: secret list 报两个 key 都已存在 (如 omd-actions keyset), 其余透传共享 fixture。
      const ghExisting: GhRunner = (args) =>
        args[0] === 'secret' && args[1] === 'list'
          ? { stdout: JSON.stringify([{ name: 'DEEPSEEK_API_KEY' }, { name: 'TAVILY_API_KEY' }]), stderr: '', exitCode: 0 }
          : gh(args);
      const o = runInit(
        { destination: 'Keep Keyset', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: {}, // 本机 env 无 key 也不该报错: 已存在即无需复制
          probes: probes(),
          gh: ghExisting,
          readTemplate: () => 'CALLER_YAML',
          writeWorkflow: () => {},
          writeConfig: () => {},
          hasCentralWorkflow: () => false,
          canary: { sleep: () => {} },
        },
      );
      expect(o.isError).toBeUndefined();
      expect(calls.some((c) => c[0] === 'secret' && c[1] === 'set')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runInit 执行前预检 fail-loud (D-E: 缺什么报什么 + 修复命令)', () => {
  test('gh 无 destination → isError', () => {
    const o = runInit({ backend: 'gh' }, { cwd: tmp(), env: {}, probes: probes(), gh: throwGh() });
    expect(o.isError).toBe(true);
    expect(o.text).toContain('destination');
  });

  test('gh 未认证 → fail-loud 报 gh auth login', () => {
    const o = runInit({ destination: 'X', backend: 'gh' }, { cwd: tmp(), env: {}, probes: probes({ ghAuthScopes: () => null }), gh: throwGh() });
    expect(o.isError).toBe(true);
    expect(o.text).toContain('gh auth login');
  });

  test('cloudAfk 缺 workflow scope → fail-loud 报 gh auth refresh -s workflow', () => {
    const o = runInit(
      { destination: 'X', backend: 'gh', cloudAfk: true },
      { cwd: tmp(), env: { DEEPSEEK_API_KEY: 'd', TAVILY_API_KEY: 't' }, probes: probes({ ghAuthScopes: () => ['repo'] }), gh: recorderGh().gh },
    );
    expect(o.isError).toBe(true);
    expect(o.text).toContain('gh auth refresh -s workflow');
  });

  test('cloudAfk 缺机器级 key → fail-loud 报缺哪个', () => {
    const o = runInit(
      { destination: 'X', backend: 'gh', cloudAfk: true },
      { cwd: tmp(), env: {}, probes: probes({ hasKey: () => false }), gh: recorderGh().gh },
    );
    expect(o.isError).toBe(true);
    expect(o.text).toContain('TAVILY_API_KEY');
  });

  test('public 仓 gh cloudAfk → 输出含公开可读提示', () => {
    const dir = tmp();
    try {
      const { gh } = recorderGh();
      const o = runInit(
        { destination: 'Ship X', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk' },
          probes: probes({ repoVisibility: () => 'public' }),
          gh,
          writeWorkflow: () => {},
          writeConfig: () => {},
          hasCentralWorkflow: () => false,
          readTemplate: () => 'X',
          canary: { sleep: () => {} },
        },
      );
      expect(o.text).toContain('公开可读');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── grill 评论区通道 (可选件: 与必选 CLOUD_KEYS 分开, 缺凭证不 fail) ──────────────────

describe('runInit grill 通道铺设 (可选件)', () => {
  test('本机 env 有 token → secret set + 拷 grill caller + grillChannel:true', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      const writes: Array<[string, string]> = [];
      let writtenCfg: PathfinderConfig | undefined;
      const o = runInit(
        { destination: 'Grill On', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' },
          probes: probes(),
          gh,
          readTemplate: () => 'CALLER_YAML',
          readGrillTemplate: () => 'GRILL_CALLER_YAML',
          writeWorkflow: (p, c) => writes.push([p, c]),
          writeConfig: (c) => (writtenCfg = c),
          hasCentralWorkflow: () => false,
          hasGrillWorkflow: () => false,
          canary: { sleep: () => {} },
        },
      );
      expect(o.isError).toBeUndefined();
      // token 走 secret set。
      const secretNames = calls.filter((c) => c[0] === 'secret' && c[1] === 'set').map((c) => c[2]);
      expect(secretNames).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      // grill caller 拷到 .github/workflows/claude-grill.yml。
      const grillWrite = writes.find(([p]) => p.endsWith(join('.github', 'workflows', 'claude-grill.yml')));
      expect(grillWrite?.[1]).toBe('GRILL_CALLER_YAML');
      expect(writtenCfg?.grillChannel).toBe(true);
      expect(o.text).toContain('grill 评论区通道');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺 token (env 无 + secret 无) → 不 fail, 报告含未启用 + grillChannel:false', () => {
    const dir = tmp();
    try {
      const { gh } = recorderGh(); // secret list → [] (token 不存在)
      let writtenCfg: PathfinderConfig | undefined;
      const o = runInit(
        { destination: 'Grill Off', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk' }, // 无 CLAUDE_CODE_OAUTH_TOKEN
          probes: probes(),
          gh,
          readTemplate: () => 'CALLER_YAML',
          writeWorkflow: () => {},
          writeConfig: (c) => (writtenCfg = c),
          hasCentralWorkflow: () => false,
          canary: { sleep: () => {} },
        },
      );
      expect(o.isError).toBeUndefined(); // 可选件缺凭证不阻断
      expect(o.text).toContain('grill 评论区通道未启用');
      expect(o.text).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(writtenCfg?.grillChannel).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repo secret 已存在 → 跳过 set, 仍启用 (grillChannel:true, caller 照拷)', () => {
    const dir = tmp();
    try {
      const { gh, calls } = recorderGh();
      // secret list 报 token 已存在 (CLOUD_KEYS 仍走 env 复制); 其余透传共享 fixture。
      const ghExisting: GhRunner = (args) =>
        args[0] === 'secret' && args[1] === 'list' ? okr(JSON.stringify([{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }])) : gh(args);
      const writes: Array<[string, string]> = [];
      let writtenCfg: PathfinderConfig | undefined;
      const o = runInit(
        { destination: 'Grill Kept', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk' }, // env 无 token: 已存在即无需复制
          probes: probes(),
          gh: ghExisting,
          readTemplate: () => 'CALLER_YAML',
          readGrillTemplate: () => 'GRILL_CALLER_YAML',
          writeWorkflow: (p, c) => writes.push([p, c]),
          writeConfig: (c) => (writtenCfg = c),
          hasCentralWorkflow: () => false,
          hasGrillWorkflow: () => false,
          canary: { sleep: () => {} },
        },
      );
      expect(o.isError).toBeUndefined();
      // token 不再 set (已存在, 保留不覆写)。
      expect(calls.some((c) => c[0] === 'secret' && c[1] === 'set' && c[2] === 'CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
      // 仍启用: caller 照拷, config true。
      expect(writes.some(([p]) => p.endsWith(join('.github', 'workflows', 'claude-grill.yml')))).toBe(true);
      expect(writtenCfg?.grillChannel).toBe(true);
      expect(o.text).toContain('保留不覆写');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('中心仓 (已有 claude-grill.yml) → 不拷 grill caller, 仍启用', () => {
    const dir = tmp();
    try {
      const { gh } = recorderGh();
      const writes: Array<[string, string]> = [];
      let writtenCfg: PathfinderConfig | undefined;
      runInit(
        { destination: 'Grill Central', backend: 'gh', cloudAfk: true },
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: 'dk', TAVILY_API_KEY: 'tk', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' },
          probes: probes(),
          gh,
          writeWorkflow: (p, c) => writes.push([p, c]),
          writeConfig: (c) => (writtenCfg = c),
          hasCentralWorkflow: () => true,
          hasGrillWorkflow: () => true,
          canary: { sleep: () => {} },
        },
      );
      expect(writes.some(([p]) => p.endsWith(join('.github', 'workflows', 'claude-grill.yml')))).toBe(false);
      expect(writtenCfg?.grillChannel).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── gh fixture ────────────────────────────────────────────────────────────────

/** 探测永远成功 + 各执行调用有响应的 recorder (owner/repo = acme/repo)。 */
function recorderGh(): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === 'repo' && args[1] === 'view') {
      if (args.includes('visibility')) return okr(JSON.stringify({ visibility: 'PRIVATE' }));
      return okr(JSON.stringify({ nameWithOwner: 'acme/repo' }));
    }
    if (args[0] === 'label') return okr('');
    if (args[0] === 'issue' && args[1] === 'create') return okr('https://github.com/acme/repo/issues/7\n');
    if (args[0] === 'secret' && args[1] === 'list') return okr('[]');
    if (args[0] === 'secret') return okr('');
    if (args[0] === 'workflow' && args[1] === 'run') return okr('');
    if (args[0] === 'run' && args[1] === 'list') {
      return okr(JSON.stringify([{ databaseId: 123, status: 'completed', conclusion: 'success', url: 'https://x/runs/123' }]));
    }
    if (args[0] === 'api' && args.includes('graphql')) {
      return okr(JSON.stringify({ data: { __type: { fields: [{ name: 'title' }, { name: 'blockedByIssues' }] } } }));
    }
    return okr('');
  };
  return { gh, calls };
}

/** 永远成功的空 gh (报告模式不该真触发写操作)。 */
function okrGh(): GhRunner {
  return () => okr('');
}

/** 一触发即失败的 gh (断言"不该调 gh"的路径; md 执行 / 预检早退)。 */
function throwGh(): GhRunner {
  return () => {
    throw new Error('gh 不该被调用');
  };
}
