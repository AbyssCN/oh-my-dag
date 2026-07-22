/**
 * src/harness/pathfinder/init —— path init 向导 (SDD S4 · D-E/D-I/D-C.1)。
 *
 * 决策地图落地前的**全自动零提问探测 + 引导式两步执行**。MCP 无 TTY, "最多两问"实现为
 * **两步调用**: 首次 (无 backend 参) 跑探测梯回报告 + 推荐值; 带全参再调即执行 (initGh/initMd)。
 *
 * 三块纯件可测:
 *   - runProbeLadder(probes)  探测梯 = 纯函数, 吃注入探针 (InitProbes fixture) 出结构化梯级。
 *   - recommend(ladder)       从梯级推荐 backend/cloudAfk (纯决策)。
 *   - renderReport(...)       报告文本 (纯字符串)。
 * 执行序 (initGh/initMd) = 纯决策 + 注入副作用 (GhRunner + fs 接缝 + canary sleep), 测试注入 fixture
 * 断言 gh 调用序 (label→issue→secret→dispatch→poll→introspect), **永不真调 gh** (backend.ts 同款 idiom)。
 *
 * 分工 (wizard.ts 头注释): provider key 是 init/wizard 的职责 (配值), 本模块**只探存在性 + 复制到
 * repo secret**, 不新造 key、不读值内容 (只判有无)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GhResult, GhRunner, PathBackend } from './backend';
import { resolveBackend } from './backend';
import { createGhBackend } from './backend-gh';
import { slugifyDestination } from '../pathfinder-extension';

// ── 常量 ────────────────────────────────────────────────────────────────────────

/** gh 后端需 repo scope (读写 issue); cloudAfk 另需 workflow scope (dispatch + secret set)。 */
export const REQUIRED_SCOPES = ['repo', 'workflow'] as const;
/** 云端 AFK 研究引擎所需的机器级 key (omd-actions keyset; 只探有无 + 复制, 不读值)。 */
export const CLOUD_KEYS = ['DEEPSEEK_API_KEY', 'TAVILY_API_KEY'] as const;

/** path:* 全套 label + 颜色 (init 幂等确保; research-done 是 S2 workflow 打的完成标)。 */
const PATH_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['path:map', '5319E7'],
  ['path:research', '1D76DB'],
  ['path:grill', 'FBCA04'],
  ['path:prototype', 'D93F0B'],
  ['path:task', '0E8A16'],
  ['path:delivered', 'C2E0C6'],
  ['research-done', '0E8A16'],
];

/** 目标仓 caller workflow 落点 (S2 caller 模板拷入位; 金丝雀 workflow_dispatch 的对象)。 */
const CALLER_WORKFLOW_REL = join('.github', 'workflows', 'path-research.yml');
/** 中心 (oh-my-dag 自身) 已有的 reusable workflow —— 存在则本仓即中心, 金丝雀直打它, 不拷 caller (免双触发)。 */
const CENTRAL_WORKFLOW_REL = join('.github', 'workflows', 'dag-research.yml');
/** caller 模板随包发布 (package.json files 含 templates/); 相对本包根解析 (dispatch.researchScriptPath 同范式)。 */
const CALLER_TEMPLATE_ABS = join(import.meta.dir, '..', '..', '..', 'templates', 'path-research-caller.yml');

// ── 探测梯 (纯函数 + 注入探针) ────────────────────────────────────────────────────

/**
 * 注入探针 (每级一个方法; 生产由 defaultInitProbes 经 gh/git/env 实现, 测试注入 fixture)。
 * 全部**只读**: 探存在/可用, 不改状态、不读 key 值 (hasKey 只判有无)。
 */
export interface InitProbes {
  /** 当前 cwd 是 git 仓库? */
  isGitRepo(): boolean;
  /** GitHub remote 的 `owner/repo` (无 remote / 非 github → null)。 */
  githubRemote(): string | null;
  /** gh 已认证时的 token scope 列表 (未认证 → null; 认证但读不到 scope → [])。 */
  ghAuthScopes(): string[] | null;
  /** 仓库可见性 (读不到 → unknown)。 */
  repoVisibility(): 'public' | 'private' | 'unknown';
  /** 仓库 Actions 是否启用。 */
  actionsEnabled(): boolean;
  /** 机器级 key 是否存在 (只判有无, 不返回值)。 */
  hasKey(name: string): boolean;
}

/** 探测梯的结构化结果 (每级一格 + 派生的 ghReady)。 */
export interface ProbeLadder {
  gitRepo: boolean;
  /** `owner/repo` 或 null。 */
  remote: string | null;
  /** token scopes 或 null (未认证)。 */
  authScopes: string[] | null;
  /** REQUIRED_SCOPES 里缺的 (未认证 → 全缺)。 */
  missingScopes: string[];
  visibility: 'public' | 'private' | 'unknown';
  actions: boolean;
  /** 每个 CLOUD_KEY 是否在机器级 env 存在。 */
  keys: Record<string, boolean>;
  /** gh 后端最低可用 = git 仓库 ∧ 有 remote ∧ 已认证 ∧ 有 repo scope。 */
  ghReady: boolean;
}

/**
 * 跑探测梯 (纯函数, 短路上级失败): git → remote → auth+scope → 可见性 → Actions → 机器级 key。
 * 上级失败时下级不再探 (无 remote 谈不上可见性/Actions), 保证梯级语义单调。
 */
export function runProbeLadder(p: InitProbes): ProbeLadder {
  const gitRepo = p.isGitRepo();
  const remote = gitRepo ? p.githubRemote() : null;
  const authScopes = remote ? p.ghAuthScopes() : null;
  const missingScopes = REQUIRED_SCOPES.filter((s) => !(authScopes ?? []).includes(s));
  const visibility = remote ? p.repoVisibility() : 'unknown';
  const actions = remote ? p.actionsEnabled() : false;
  const keys: Record<string, boolean> = {};
  for (const k of CLOUD_KEYS) keys[k] = p.hasKey(k);
  const ghReady = gitRepo && remote !== null && authScopes !== null && authScopes.includes('repo');
  return { gitRepo, remote, authScopes, missingScopes, visibility, actions, keys, ghReady };
}

/** 从梯级推荐两问答案 + 理由 (纯决策; cloudAfk 需 gh 就绪 ∧ workflow scope ∧ Actions ∧ key 齐)。 */
export interface InitRecommendation {
  backend: 'gh' | 'md';
  cloudAfk: boolean;
  /** cloudAfk 若被推荐为 off, 逐条列缺什么 (给报告用)。 */
  cloudBlockers: string[];
}

export function recommend(l: ProbeLadder): InitRecommendation {
  const backend: 'gh' | 'md' = l.ghReady ? 'gh' : 'md';
  const cloudBlockers: string[] = [];
  if (!l.ghReady) cloudBlockers.push('gh 后端未就绪');
  if (l.authScopes !== null && !l.authScopes.includes('workflow')) cloudBlockers.push('gh 缺 workflow scope');
  if (!l.actions) cloudBlockers.push('Actions 未启用');
  const missingKeys = CLOUD_KEYS.filter((k) => !l.keys[k]);
  if (missingKeys.length > 0) cloudBlockers.push(`缺机器级 key: ${missingKeys.join(', ')}`);
  return { backend, cloudAfk: backend === 'gh' && cloudBlockers.length === 0, cloudBlockers };
}

// ── 报告文本 (纯字符串) ──────────────────────────────────────────────────────────

/** 单级图标 + 修复提示 (缺什么报什么 + 具体命令, D-E)。 */
function rung(label: string, ok: boolean | 'warn', detail: string, fix?: string): string {
  const icon = ok === true ? '✓' : ok === 'warn' ? '⚠' : '✗';
  const fixTail = ok !== true && fix ? `  → ${fix}` : '';
  return `  ${icon} ${label}: ${detail}${fixTail}`;
}

/** 探测报告 + 推荐 + 两步引导 (首次 init 无参调用的返回文本)。 */
export function renderReport(cwd: string, l: ProbeLadder, rec: InitRecommendation, destination?: string): string {
  const lines: string[] = [`◈ pathfinder init 探测报告 (cwd=${cwd})`];
  lines.push(rung('git 仓库', l.gitRepo, l.gitRepo ? '是' : '否', 'git init / 进入仓库目录'));
  lines.push(rung('GitHub remote', l.remote !== null, l.remote ?? '无', 'git remote add origin git@github.com:<owner>/<repo>.git'));

  if (l.authScopes === null) {
    lines.push(rung('gh 认证', false, '未认证', 'gh auth login'));
  } else {
    const hasRepo = l.authScopes.includes('repo');
    const hasWf = l.authScopes.includes('workflow');
    const state = hasRepo && hasWf ? true : 'warn';
    const miss = l.missingScopes.length > 0 ? ` (缺 ${l.missingScopes.join(', ')})` : '';
    lines.push(rung('gh 认证+scope', state, `[${l.authScopes.join(', ') || '—'}]${miss}`, `gh auth refresh -s ${REQUIRED_SCOPES.join(',')}`));
  }

  lines.push(rung('仓库可见性', l.visibility !== 'unknown', l.visibility));
  lines.push(rung('Actions', l.actions, l.actions ? '启用' : '未启用/未知', '仓库 Settings → Actions → General 启用'));
  const keyState = CLOUD_KEYS.map((k) => `${k} ${l.keys[k] ? '✓' : '✗'}`).join('  ');
  const missingKeys = CLOUD_KEYS.filter((k) => !l.keys[k]);
  lines.push(rung('机器级 key', missingKeys.length === 0, keyState, `配缺失 key (omd init / ~/.omd/env) — 只探有无不读值`));

  lines.push('  ─────');
  lines.push(`  推荐: backend=${rec.backend}, cloudAfk=${rec.cloudAfk ? 'on' : 'off'}`);
  if (!rec.cloudAfk && rec.cloudBlockers.length > 0) {
    lines.push(`  cloudAfk 暂不推荐: ${rec.cloudBlockers.join('; ')}`);
  }
  if (rec.cloudAfk && l.visibility === 'public') {
    lines.push('  ⚠ 本仓 public: 开 cloudAfk = map issue (决策历史) 将公开可读。');
  }
  lines.push('  待决两问 (带参再调 path_init 执行):');
  lines.push(`    ① backend: gh|md   (推荐 ${rec.backend})`);
  lines.push(`    ② cloudAfk: on|off (推荐 ${rec.cloudAfk ? 'on' : 'off'})`);
  const destArg = destination ? `destination=${JSON.stringify(destination)}, ` : 'destination="<目的地>", ';
  const cloudArg = rec.backend === 'gh' ? `, cloudAfk=${rec.cloudAfk}` : '';
  lines.push(`  示例: path_init(${destArg}backend=${JSON.stringify(rec.backend)}${cloudArg})`);
  return lines.join('\n');
}

// ── 生产探针 (gh/git/env 实现) ────────────────────────────────────────────────────

/** 一次命令调用器 (git 与 gh 同形; 默认 Bun.spawnSync, cwd 绑定认对 remote)。 */
function spawnRunner(bin: string, cwd: string): (args: string[]) => GhResult {
  return (args) => {
    const r = Bun.spawnSync([bin, ...args], { cwd });
    return { stdout: r.stdout?.toString() ?? '', exitCode: r.exitCode ?? -1, stderr: r.stderr?.toString() ?? '' };
  };
}

/**
 * 生产探针: git/gh shell-out + env 查表。gh api 用 `{owner}/{repo}` 占位 (gh 从 repo 上下文自动展开),
 * 无需先解析 owner/repo。任一探测失败 → 该级判否 (fail-safe: 探不到即当不可用, 不假阳性)。
 */
export function defaultInitProbes(
  cwd: string,
  env: NodeJS.ProcessEnv,
  git: (args: string[]) => GhResult = spawnRunner('git', cwd),
  gh: GhRunner = spawnRunner('gh', cwd),
): InitProbes {
  return {
    isGitRepo: () => git(['rev-parse', '--is-inside-work-tree']).exitCode === 0,
    githubRemote: () => {
      const r = git(['remote', 'get-url', 'origin']);
      if (r.exitCode !== 0) return null;
      const m = r.stdout.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
      return m ? `${m[1]}/${m[2]}` : null;
    },
    ghAuthScopes: () => {
      const r = gh(['auth', 'status']);
      if (r.exitCode !== 0) return null;
      const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      const m = text.match(/Token scopes:\s*(.+)/i);
      if (!m) return []; // 已认证但读不到 scope 行 (老 gh / 输出变体)
      return m[1]!
        .split(',')
        .map((s) => s.replace(/['\s]/g, ''))
        .filter((s) => s.length > 0);
    },
    repoVisibility: () => {
      const r = gh(['repo', 'view', '--json', 'visibility']);
      if (r.exitCode !== 0) return 'unknown';
      try {
        const v = (JSON.parse(r.stdout) as { visibility?: string }).visibility;
        return v === 'PUBLIC' ? 'public' : v === 'PRIVATE' ? 'private' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
    actionsEnabled: () => {
      const r = gh(['api', 'repos/{owner}/{repo}/actions/permissions']);
      if (r.exitCode !== 0) return false;
      try {
        return (JSON.parse(r.stdout) as { enabled?: boolean }).enabled === true;
      } catch {
        return false;
      }
    },
    hasKey: (name) => {
      const v = env[name];
      return typeof v === 'string' && v.trim().length > 0;
    },
  };
}

// ── gh 执行小工具 ────────────────────────────────────────────────────────────────

/** 跑一条 gh; 非零退出即 throw 带上下文 (fail-loud: 每步失败报具体缺什么, D-E)。 */
function run(gh: GhRunner, args: string[], ctx: string): string {
  const r = gh(args);
  if (r.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} 失败 (${ctx}, exit=${r.exitCode}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

/** path:* 全套 label 幂等确保 (`gh label create --force` 存在则更新, 不存在则建)。 */
function ensureLabels(gh: GhRunner): void {
  for (const [name, color] of PATH_LABELS) {
    run(gh, ['label', 'create', name, '--color', color, '--force'], `ensureLabels:${name}`);
  }
}

/**
 * 把机器级 key 复制成 repo secret (值从本机 env 读; 缺 → fail-loud 报缺哪个 + 修复)。
 * GhRunner 无 stdin 通道 → 经 --body 传 (owner 本机一次性 init, 可接受; 值不落日志)。
 */
function setSecrets(gh: GhRunner, env: NodeJS.ProcessEnv, ownerRepo: string): void {
  const missing = CLOUD_KEYS.filter((k) => !(typeof env[k] === 'string' && env[k]!.trim().length > 0));
  if (missing.length > 0) {
    throw new Error(
      `缺机器级 key: ${missing.join(', ')} — 无法 gh secret set (值从本机 env 读)。` +
        ` 修复: 在 ~/.omd/env 或 .env 配好 ${missing.join('/')} (omd init 配 provider key) 后重跑 path_init。`,
    );
  }
  for (const k of CLOUD_KEYS) {
    run(gh, ['secret', 'set', k, '-R', ownerRepo, '--body', env[k]!], `setSecrets:${k}`);
  }
}

/** 金丝雀轮询结果 (超时 → pending, 不挂死)。 */
export interface CanaryResult {
  status: 'success' | 'failure' | 'pending';
  runId?: number;
  url?: string;
  conclusion?: string;
}

/** 金丝雀 sleep/轮询预算 (测试注入 no-op sleep + 立即完成的 gh fixture)。 */
export interface CanaryOpts {
  attempts?: number;
  sleepMs?: number;
  sleep?: (ms: number) => void;
}

/**
 * workflow_dispatch 干跑金丝雀 (D-I): dispatch dry_run=true → 有限次轮询 run 结论。
 * dispatch 失败 fail-loud (throw); 轮询期 gh 暂时读不到不 throw (run 需时间出现), 超时报 pending。
 */
export function runCanary(gh: GhRunner, workflowFile: string, ownerRepo: string, mapNumber: string, opts: CanaryOpts = {}): CanaryResult {
  run(gh, ['workflow', 'run', workflowFile, '-R', ownerRepo, '-f', 'dry_run=true', '-f', `issue=${mapNumber}`], 'canary:dispatch');
  const attempts = opts.attempts ?? 15;
  const sleepMs = opts.sleepMs ?? 4000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  for (let i = 0; i < attempts; i++) {
    sleep(sleepMs); // dispatch 后 run 需时间出现, 先等再读
    const r = gh(['run', 'list', '--workflow', workflowFile, '-R', ownerRepo, '--event', 'workflow_dispatch', '--json', 'databaseId,status,conclusion,url', '--limit', '1']);
    if (r.exitCode !== 0) continue;
    let rows: Array<{ databaseId?: number; status?: string; conclusion?: string; url?: string }>;
    try {
      rows = JSON.parse(r.stdout || '[]');
    } catch {
      continue;
    }
    const row = rows[0];
    if (!row || row.status !== 'completed') continue;
    return {
      status: row.conclusion === 'success' ? 'success' : 'failure',
      ...(row.databaseId !== undefined ? { runId: row.databaseId } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    };
  }
  return { status: 'pending' };
}

/**
 * 探原生 issue-dependencies API 可用性 (D-C.1 切换真相源的依据)。GraphQL 内省 Issue 类型字段,
 * 命中依赖相关字段 (名含 dependenc / blockedBy) → true。任何错/读不到 → **保守 false**
 * (维持 body 尾行 `Blocked-by:` 为单真相, 不赌 preview API)。
 * ? 岔口: 原生依赖的确切 GraphQL 字段名待真 gh 金丝雀验证 (见报告 ? 标注); 内省匹配是保守启发式。
 */
export function probeNativeDependencies(gh: GhRunner): boolean {
  const r = gh(['api', 'graphql', '-f', 'query=query{__type(name:"Issue"){fields{name}}}']);
  if (r.exitCode !== 0) return false;
  try {
    const j = JSON.parse(r.stdout) as { data?: { __type?: { fields?: Array<{ name: string }> } } };
    const names = j.data?.__type?.fields?.map((f) => f.name) ?? [];
    return names.some((n) => /dependenc/i.test(n) || /blockedby/i.test(n) || /blocking/i.test(n));
  } catch {
    return false;
  }
}

// ── 配置落盘 ─────────────────────────────────────────────────────────────────────

/** .omd/pathfinder/config.json 形状 (resolveBackend 只读 .backend; 其余是 init 记的能力/金丝雀档案)。 */
export interface PathfinderConfig {
  backend: 'md' | 'gh';
  cloudAfk?: boolean;
  capabilities?: { nativeDependencies: boolean };
  canary?: CanaryResult & { at: string; workflow?: string };
}

export function configPath(cwd: string): string {
  return join(cwd, '.omd', 'pathfinder', 'config.json');
}

function writeConfigFile(cwd: string, cfg: PathfinderConfig): void {
  const p = configPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

// ── 执行序 (纯决策 + 注入副作用) ──────────────────────────────────────────────────

/** init 执行接缝 (测试注入; 省略 = 生产默认)。 */
export interface InitDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  probes: InitProbes;
  /** gh 调用器 (gh 后端 + secret/canary/introspect 用)。 */
  gh: GhRunner;
  /** gh 后端实例 (createMap 用); 省略 = createGhBackend(gh)。 */
  ghBackend?: PathBackend;
  /** md 后端实例 (createMap 用); 省略 = resolveBackend(cwd, env=md)。 */
  mdBackend?: PathBackend;
  /** 读 caller 模板正文; 省略 = 读随包 templates/path-research-caller.yml。 */
  readTemplate?: () => string;
  /** 写 workflow 文件; 省略 = fs 写入。 */
  writeWorkflow?: (absPath: string, content: string) => void;
  /** 写 config; 省略 = fs 写 .omd/pathfinder/config.json。 */
  writeConfig?: (cfg: PathfinderConfig) => void;
  /** 本仓是否已有中心 dag-research.yml (是 → 金丝雀直打它不拷 caller); 省略 = existsSync 探。 */
  hasCentralWorkflow?: () => boolean;
  /** 金丝雀轮询预算 (测试注入 no-op sleep)。 */
  canary?: CanaryOpts;
  /** 原生依赖探针 (省略 = probeNativeDependencies(gh))。 */
  probeNative?: (gh: GhRunner) => boolean;
}

export interface InitParams {
  destination?: string;
  /** 省略 → 报告模式 (跑探测梯回报告); 给值 → 执行模式。 */
  backend?: 'gh' | 'md';
  cloudAfk?: boolean;
}

export interface InitOutcome {
  text: string;
  isError?: boolean;
}

/** 组装生产默认 InitDeps (cwd/env/probes/gh 必给, 其余补默认)。 */
export function makeInitDeps(cwd: string, env: NodeJS.ProcessEnv, over: Partial<InitDeps> = {}): InitDeps {
  const gh = over.gh ?? spawnRunner('gh', cwd);
  return {
    cwd,
    env,
    gh,
    probes: over.probes ?? defaultInitProbes(cwd, env, undefined, gh),
    ...over,
  };
}

/**
 * init 主入口 (报告 vs 执行由 backend 参在否决定):
 *   - backend 省略 → 报告模式: 跑探测梯 → 回报告 + 推荐 + 两步引导。
 *   - backend 给值 → 执行模式: 需 destination; md 建本地图; gh 走完整执行序。
 */
export function runInit(params: InitParams, deps: InitDeps): InitOutcome {
  if (params.backend === undefined) {
    const ladder = runProbeLadder(deps.probes);
    return { text: renderReport(deps.cwd, ladder, recommend(ladder), params.destination) };
  }
  if (!params.destination || params.destination.trim().length === 0) {
    return { text: '执行 init 需 destination (目的地文本) — path_init(destination="…", backend=…)。', isError: true };
  }
  try {
    return params.backend === 'md' ? initMd(params.destination, deps) : initGh(params.destination, params.cloudAfk, deps);
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}

/** md 后端 init: 建本地图 (复用 createMap) + config 落盘, 零 gh 依赖。 */
function initMd(destination: string, deps: InitDeps): InitOutcome {
  const backend = deps.mdBackend ?? resolveBackend(deps.cwd, { env: { OMD_PATH_BACKEND: 'md' } });
  const map = backend.createMap(deps.cwd, destination, slugifyDestination(destination));
  const cfg: PathfinderConfig = { backend: 'md' };
  (deps.writeConfig ?? ((c) => writeConfigFile(deps.cwd, c)))(cfg);
  return {
    text: [
      `◈ pathfinder init 完成 (backend=md)`,
      `  地图: ${map.destination} (slug=${map.slug}, docs/plan/pathfinder/${map.slug}.md)`,
      `  config: ${configPath(deps.cwd)} {"backend":"md"}`,
      `  下一步: path_add 加票 → path_tickets 看前沿。`,
    ].join('\n'),
  };
}

/**
 * gh 后端 init 执行序 (SDD §5): 预检 (fail-loud) → labels → map issue → [cloudAfk: caller + secrets +
 * canary + 原生依赖探] → config 落盘。cloudAfk 关时只建 labels + map + config (issue 后端本地可用, 无云)。
 */
function initGh(destination: string, cloudAfk: boolean | undefined, deps: InitDeps): InitOutcome {
  const ladder = runProbeLadder(deps.probes);

  // 预检 (每步失败报具体缺什么 + 修复命令, D-E)。
  if (!ladder.gitRepo) throw new Error('gh 后端不可用: 当前不是 git 仓库 — git init / 进入仓库目录后重试。');
  if (!ladder.remote) throw new Error('gh 后端不可用: 无 GitHub remote — git remote add origin git@github.com:<owner>/<repo>.git 后重试。');
  if (ladder.authScopes === null) throw new Error('gh 后端不可用: gh 未认证 — gh auth login 后重试。');
  if (!ladder.authScopes.includes('repo')) throw new Error('gh 后端不可用: gh 缺 repo scope — gh auth refresh -s repo 后重试。');

  const ownerRepo = ladder.remote;
  const wantCloud = cloudAfk === true;
  if (wantCloud) {
    // cloudAfk 额外前提: workflow scope + Actions + key 齐 (缺任一 fail-loud, 不静默降级)。
    if (!ladder.authScopes.includes('workflow')) throw new Error('cloudAfk 需 workflow scope — gh auth refresh -s workflow 后重试 (或 cloudAfk=false 只用本地 issue 后端)。');
    if (!ladder.actions) throw new Error('cloudAfk 需 Actions 启用 — 仓库 Settings → Actions → General 启用后重试 (或 cloudAfk=false)。');
    const missingKeys = CLOUD_KEYS.filter((k) => !ladder.keys[k]);
    if (missingKeys.length > 0) throw new Error(`cloudAfk 需机器级 key: 缺 ${missingKeys.join(', ')} — 在 ~/.omd/env 配好 (omd init) 后重试 (或 cloudAfk=false)。`);
  }

  // 1. labels 幂等。
  ensureLabels(deps.gh);

  // 2. map issue。
  const backend = deps.ghBackend ?? createGhBackend(deps.gh);
  const map = backend.createMap(deps.cwd, destination, slugifyDestination(destination));
  const mapNumber = map.slug;

  const out: string[] = [`◈ pathfinder init 完成 (backend=gh, cloudAfk=${wantCloud ? 'on' : 'off'})`];
  out.push(`  labels: path:* 全套已确保 (${PATH_LABELS.length} 个, 幂等)。`);
  out.push(`  map issue: #${mapNumber} 🧭 [map] ${destination}`);

  let canary: CanaryResult | undefined;
  let nativeDeps = false;
  if (wantCloud) {
    // 3a. caller: 本仓即中心 (已有 dag-research.yml) → 金丝雀直打它, 不拷 caller (免双触发同 issue 事件)。
    const central = (deps.hasCentralWorkflow ?? (() => existsSync(join(deps.cwd, CENTRAL_WORKFLOW_REL))))();
    const workflowFile = central ? 'dag-research.yml' : 'path-research.yml';
    if (!central) {
      const tpl = (deps.readTemplate ?? (() => readFileSync(CALLER_TEMPLATE_ABS, 'utf8')))();
      (deps.writeWorkflow ?? ((p, c) => writeWorkflowFile(p, c)))(join(deps.cwd, CALLER_WORKFLOW_REL), tpl);
      out.push(`  caller: ${CALLER_WORKFLOW_REL} 已写 (pin @v1)。`);
    } else {
      out.push(`  caller: 本仓即中心 (已有 ${CENTRAL_WORKFLOW_REL}), 金丝雀直打之, 不拷 caller。`);
    }

    // 3b. secrets (值从本机 env 读, 缺 → fail-loud)。
    setSecrets(deps.gh, deps.env, ownerRepo);
    out.push(`  secrets: ${CLOUD_KEYS.join(' / ')} 已 set 到 ${ownerRepo} (值从本机 env 复制)。`);

    // 3c. canary (workflow_dispatch dry_run + 轮询)。
    canary = runCanary(deps.gh, workflowFile, ownerRepo, mapNumber, deps.canary ?? {});
    out.push(
      canary.status === 'pending'
        ? `  金丝雀: dispatch 已发, 轮询超时未见完成 — pending (稍后 gh run list --workflow ${workflowFile} 复核)。`
        : `  金丝雀: ${canary.status}${canary.url ? ` (${canary.url})` : ''}${canary.status === 'failure' ? ' — 管道未通, 查 run 日志' : ''}。`,
    );

    // 3d. 原生 issue-dependencies API 可用性 (D-C.1)。
    nativeDeps = (deps.probeNative ?? probeNativeDependencies)(deps.gh);
    out.push(`  原生 issue-dependencies: ${nativeDeps ? '可用 (记入 config; 切换真相源仍待人工确认, 见 ?)' : '不可用/未确认 — 维持 body 尾行 Blocked-by 单真相 (D-C.1)'}。`);

    if (ladder.visibility === 'public') {
      out.push(`  ⚠ 本仓 public: map issue #${mapNumber} (决策历史) 现公开可读。`);
    }
  }

  // 4. config 落盘 (backend + capabilities + canary)。
  const cfg: PathfinderConfig = {
    backend: 'gh',
    cloudAfk: wantCloud,
    capabilities: { nativeDependencies: nativeDeps },
    ...(canary ? { canary: { ...canary, at: new Date().toISOString() } } : {}),
  };
  (deps.writeConfig ?? ((c) => writeConfigFile(deps.cwd, c)))(cfg);
  out.push(`  config: ${configPath(deps.cwd)} 已落 (backend/capabilities/canary)。`);
  out.push(`  下一步: path_add 加票 → path_prefetch 派研究到云端 → path_tickets 拉回流。`);
  return { text: out.join('\n') };
}

function writeWorkflowFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
}
