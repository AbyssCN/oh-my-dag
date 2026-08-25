/**
 * src/harness/post-leaf-gate —— **三态 post-leaf gate** (INV-16 / I-9)。
 *
 * leaf 节点跑完后, 引擎拉起一个外部 oracle 脚本 (落在引擎持有的 checks/ 目录里)
 * 判 done 还是 failed。本件是那层包装, 核心约束:
 *
 *   1. **三态字符串字面量**, 不用 boolean —— UNVERIFIED 既不是 OK 也不是 FAIL, 是
 *      "oracle 自己出了问题, 本次判定无效"。OK/FAIL 是关于 leaf 工作的语义;
 *      UNVERIFIED 是关于 oracle 自身的可靠性。压成 boolean 会丢掉这条分界
 *      ("假绿" 的最常见来源)。
 *   2. **四种 UNVERIFIED 触发路径** —— 脚本缺失 / 脚本抛异常 / 脚本超时 / 目标产物未写完,
 *      每条独立计数 +1 (`oracleFaults`) 且把异常栈原文 / 失败证据塞进 `evidence`。
 *      `reason` 是短码, `evidence` 是原文, 两层都留 —— oracle 自己崩了也得能溯源。
 *   3. **写权判定** —— checks/ 目录由引擎持有, leaf (与 conductor / verifier)
 *      对其**无写权**。这条闸是独立的可测函数 `gateWriteAuthority`, 防止 leaf
 *      "修一下脚本" 这种隐蔽篡改 oracle 行为的手法 (那种修改会把它本来要判红的
 *      活判成绿, 是 oracle-fault 里最难看的一种)。
 *
 * 依赖: 只用 `node:fs` 做存在性 / 大小检查; 子进程跑法由调用方注入 (`spawn`),
 * 这样测试能换替身, 真接线由 `agent-leaf` 那条路负责 (那条路已经有白名单 + 超时闸)。
 *
 * ## 与 `repo-checks.ts` 的关系 (D2 切片 2, #266)
 *
 * 本件导出 `GateVerdict` / `GateSpawn` 类型; `repo-checks.ts` 复用这两条做
 * leaf 级仓规检查的语义真源 (INV-D2-3: 同一份三态语义, 不另立词表)。不**调用**
 * `evaluatePostLeaf` (后者跑脚本路径, `repo-checks` 跑命令串 — 形态不同, 入口各
 * 异; 共用一份语义真源, 不共用入口, 见 `command-leaf-cache-scope.test.ts` 反向自检)。
 */
import { existsSync as nodeExistsSync, statSync as nodeStatSync } from 'node:fs';
import { logger } from '../logger';

// ── types (S1 接口契约 §1.6 字段顺序即指纹) ─────────────────────────────────

/**
 * 三态字符串字面量。**禁止 boolean** —— "OK/FAIL 是关于 leaf 语义, UNVERIFIED 是关于
 * oracle 自身的可靠性", 二者压成 boolean 会丢掉 "oracle 自己崩了" 这条独立分界。
 * 实测教训: 此前曾用 `verdict: 'ok' | 'fail'`, 一次真事故里 oracle 超时但被翻译成
 * 'fail' 写进了账本, 看起来像 "leaf 没干好", 实则是 oracle 跑挂了, 排查方向全错。
 */
export type GateVerdict = 'OK' | 'FAIL' | 'UNVERIFIED';

/** 短码: 区分 UNVERIFIED 的具体触发路径, 也是 OK/FAIL 的退出码标签。 */
export type GateReason =
  | 'script_missing'
  | 'script_threw'
  | 'script_timeout'
  | 'artifact_unfinished'
  | `exit_${number}`
  | 'exit_null'
  | 'ok';

/**
 * gate 判定的对外结果 (S1 §1.6)。字段顺序即指纹, 改序 = 升 SCHEMA_VERSION。
 *  - verdict: 三态
 *  - reason:  短码 (UNVERIFIED 的触发路径 / OK / FAIL 的退出码)
 *  - evidence: 原文 (stdout/stderr/异常栈), 可选, 没原文就不塞
 *  - oracleFaults: UNVERIFIED 触发累计; OK/FAIL 必为 0
 *  - evaluatedAt: ISO 时间戳, 排账用
 */
export interface GateResult {
  verdict: GateVerdict;
  reason?: GateReason;
  evidence?: string;
  oracleFaults: number;
  evaluatedAt: string;
}

/** leaf 节点对外暴露的产物 (S1 §1.6)。实装里 nodeId 是必填, 其余可选。 */
export interface LeafArtifact {
  nodeId: string;
  output?: string;
  toolCalls?: ReadonlyArray<unknown>;
}

// ── write-authority (独立可测函数) ────────────────────────────────────────────

/** checks/ 目录的写权主体。引擎是唯一持有者, 其余角色皆无写权。 */
export type WriteActor = 'engine' | 'leaf' | 'conductor' | 'verifier';

/**
 * 写权判定的对外结果。`allowed: false` 时 `reason` 必填 (供调用方写账本 / 触发升级)。
 * `allowed: true` 且 `reason` 非空: "通过本闸, 但调用方应当套其他闸" (典型 = 路径
 * 落在 checks/ 之外, gateWriteAuthority 不管这块)。
 */
export interface WriteAuthorityVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * INV-I9: **checks/ 目录由引擎持有**, 只有 `engine` 有写权。
 *
 * 为什么是独立函数: "leaf 偷偷改 oracle 脚本" 是 oracle-fault 里最难抓的那种——
 * 它**不会被 UNVERIFIED 触发**(脚本存在、能跑、退出 0, 一切正常), 唯一拦得住的地方
 * 是写期闸。这条闸单独抽出, 一是可测 (给定 actor + path 直接得 verdict),
 * 二是各层接线点 (agent-leaf / conductor / harness) 都可以复用同一份判据。
 *
 * 边界: **本函数只判 checks/ 内**。落在 checks/ 之外的路径 → `allowed: true` + 一条
 * "本闸不适用" 的 reason; 那块由别的写权策略管 (writeset 闸 / 输出路径白名单 等),
 * 不归这里。
 */
export function gateWriteAuthority(
  actor: WriteActor,
  path: string,
  checksRoot: string,
): WriteAuthorityVerdict {
  const root = checksRoot.replace(/\/+$/, '');
  const inside = path === root || path.startsWith(root + '/');
  if (!inside) {
    return { allowed: true, reason: `path 不在 checks/ 内 (${root}); gateWriteAuthority 不管这块` };
  }
  if (actor === 'engine') return { allowed: true };
  return {
    allowed: false,
    reason: `INV-I9: '${actor}' 对引擎持有的 checks/ (${root}) 无写权; 只有 'engine' 可写 gate 脚本`,
  };
}

// ── evaluatePostLeaf (主入口) ────────────────────────────────────────────────

/**
 * 可注入的子进程跑法签名。**故意只取 `command-leaf` 那条路要的最小集** —— 实装接到
 * `agent-leaf` 那条白名单+超时闸上时, 由调用方负责传 `spawn`, 不要在本件里再造一份
 * (会双源, 见 `command-leaf-cache-scope.test.ts` 那条反向自检的教训)。
 *
 * `timedOut` / `signal` 可选, 老替身只给三元组时按 "没发生" 处理 —— 跟 command-leaf
 * 那边的口径一致。
 */
export type GateSpawn = (
  command: string,
  cwd: string,
  timeoutMs?: number,
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  signal?: string | null;
}>;

/** 可注入的文件系统操作 —— 测 "产物未写完" 这条 UNVERIFIED 时需要替身 (造 0 字节文件)。 */
export interface GateFs {
  existsSync(p: string): boolean;
  statSync(p: string): { size: number };
}

const DEFAULT_FS: GateFs = {
  existsSync: (p) => nodeExistsSync(p),
  statSync: (p) => ({ size: nodeStatSync(p).size }),
};

/** `evaluatePostLeaf` 的入参。`artifact` 之外都是 gate 自身的接线参数。 */
export interface PostLeafGateInput {
  /** leaf 节点对外暴露的产物 (S1 §1.6)。 */
  artifact: LeafArtifact;
  /** gate 脚本的绝对路径。实装由引擎在 run-start 时把脚本落在 `checksRoot` 下。 */
  scriptPath: string;
  /** checks/ 的根, 写权判定用 (与 scriptPath 应同根)。 */
  checksRoot: string;
  /** gate 脚本的工作目录 (默认 process.cwd())。 */
  cwd?: string;
  /** gate 脚本的超时毫秒。**默认 30_000** —— oracle 不该比 leaf 跑得久。 */
  timeoutMs?: number;
  /** leaf 声称它已写入的产物路径。若提供, gate 跑前先查存在+非空; 否则走脚本自查。 */
  artifactPath?: string;
  /** 注入的子进程跑法。无注入 → UNVERIFIED('no_spawn') (生产侧必须由 agent-leaf 注入)。 */
  spawn?: GateSpawn;
  /** 注入的文件系统操作。无注入用 node:fs 真实现。 */
  fs?: GateFs;
  /** 时钟注入 (测试断言 evaluatedAt 用)。无注入用 Date.now()。 */
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 主入口。语义按 INV-16:
 *
 *   - 脚本退出码 0         → verdict:'OK'
 *   - 脚本退出码 非 0       → verdict:'FAIL'  (reason = `exit_${code}`)
 *   - 脚本缺失 / 抛 / 超时 / 产物未写完 → verdict:'UNVERIFIED' 且 oracleFaults += 1
 *
 * 任何 UNVERIFIED 路径都把证据原文塞进 `evidence` (异常栈 / stat 失败信息 / 路径原文),
 * 不丢原始信息 —— 这是 oracle-fault 排账的唯一依据。
 *
 * **不抛** —— oracle 自己出问题不该让 leaf 整条线跟着炸, 它该被翻译成 UNVERIFIED
 * 走 verifier 那条怀疑链。"oracle 抛了 → 调用方也抛 → 整跑炸" 是假实现的常见形态。
 */
export async function evaluatePostLeaf(input: PostLeafGateInput): Promise<GateResult> {
  const fs = input.fs ?? DEFAULT_FS;
  const cwd = input.cwd ?? process.cwd();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = input.now ?? (() => new Date());
  let oracleFaults = 0;

  // ── 触发路径 1: 脚本缺失 ─────────────────────────────────────────────────
  // 在 spawn 之前查 —— spawn 一个不存在的脚本会让 OS 报 ENOENT, 那条错误信息
  // 跨平台长得不一样 (sh: "No such file" / win32: "系统找不到指定的文件"), 自己
  // 查存在性后返固定 reason, 比依赖 stderr 文案稳得多。
  if (!fs.existsSync(input.scriptPath)) {
    oracleFaults++;
    return {
      verdict: 'UNVERIFIED',
      reason: 'script_missing',
      evidence: `gate script not found: ${input.scriptPath}`,
      oracleFaults,
      evaluatedAt: now().toISOString(),
    };
  }

  // ── 触发路径 2: 产物未写完 ────────────────────────────────────────────────
  // 在 spawn **之前**查 —— 若 leaf 声称它写了 artifact 但盘上不存在或 0 字节, 那是
  // leaf 撒谎或写入中被打断, 跑 oracle 只会让它读到一半的内容, 比不跑更糟。
  // 不提供 artifactPath → 跳过本检查 (oracle 脚本会自查, 见各自脚本约定)。
  if (input.artifactPath !== undefined) {
    let size = -1;
    let statErr: string | undefined;
    try {
      size = fs.statSync(input.artifactPath).size;
    } catch (e) {
      statErr = e instanceof Error ? e.message : String(e);
      // fail-open 可以吞异常, 不许吞证据 (catch-evidence 纪律): stat 失败即走 UNVERIFIED, 原文留痕。
      logger.warn({ artifactPath: input.artifactPath, err: statErr }, '[post-leaf-gate] artifact stat 失败 → UNVERIFIED');
    }
    if (size <= 0) {
      oracleFaults++;
      return {
        verdict: 'UNVERIFIED',
        reason: 'artifact_unfinished',
        evidence:
          statErr !== undefined
            ? `claimed artifact stat failed: ${input.artifactPath} :: ${statErr}`
            : `claimed artifact is empty (0 bytes) or missing: ${input.artifactPath}`,
        oracleFaults,
        evaluatedAt: now().toISOString(),
      };
    }
  }

  // ── spawn 注入缺失也算 oracle-fault, 不能让它退化成 "脚本未跑 = 默绿" ───────
  if (!input.spawn) {
    oracleFaults++;
    return {
      verdict: 'UNVERIFIED',
      reason: 'script_threw',
      evidence:
        'evaluatePostLeaf: spawn is not injected (production must inject via agent-leaf wiring); ' +
        'without a runner, the oracle is structurally unverifiable — refusing to silently downgrade to OK/FAIL.',
      oracleFaults,
      evaluatedAt: now().toISOString(),
    };
  }

  // ── 触发路径 3 & 4: 脚本抛异常 / 脚本超时 ───────────────────────────────
  // timeout 是 "进程还活着但超了预算", 跟 "脚本自己抛" 是两条独立路径, 分别记。
  let result: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean; signal?: string | null };
  try {
    result = await input.spawn(`sh -c ${shellQuote(input.scriptPath)}`, cwd, timeoutMs);
  } catch (e) {
    oracleFaults++;
    // **异常栈原文**: 不 strip 不截断 —— 这就是排账的唯一依据, 万一是 Bun 子进程记账
    // 缺陷 (见 command-leaf.ts 那条 `bun ${Bun.version}` 注释), 改字就再也分不开了。
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    logger.warn({ scriptPath: input.scriptPath, stack }, '[post-leaf-gate] check 脚本 spawn 异常 → UNVERIFIED (oracle-fault)');
    return {
      verdict: 'UNVERIFIED',
      reason: 'script_threw',
      evidence: `gate script threw: ${stack}`,
      oracleFaults,
      evaluatedAt: now().toISOString(),
    };
  }

  if (result.timedOut) {
    oracleFaults++;
    return {
      verdict: 'UNVERIFIED',
      reason: 'script_timeout',
      evidence: `gate script exceeded ${timeoutMs}ms; partial stdout=${truncate(result.stdout, 200)}`,
      oracleFaults,
      evaluatedAt: now().toISOString(),
    };
  }

  const code = result.exitCode;
  // 非 0 = FAIL —— exitCode === null 算 FAIL (进程被信号杀掉时 exitCode 可能是 null,
  // command-leaf 那边口径是 "没拿到 exit code 视为失败"; 这里跟齐, 不另立枚举)。
  if (code !== 0) {
    const reason: GateReason = code === null ? 'exit_null' : (`exit_${code}` as GateReason);
    return {
      verdict: 'FAIL',
      reason,
      evidence: (result.stderr || result.stdout).trim() || undefined,
      oracleFaults,
      evaluatedAt: now().toISOString(),
    };
  }
  return {
    verdict: 'OK',
    reason: 'ok',
    evidence: result.stdout.trim() || undefined,
    oracleFaults,
    evaluatedAt: now().toISOString(),
  };
}

// ── 内部小工具 ──────────────────────────────────────────────────────────────

/** 把脚本路径 shell-quote 一下, 路径里带空格 / 引号时不至于炸。最小实现: 单引号包裹, 内部单引号换成 `'\''`。 */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** 截断证据字符串 —— 防止一个挂死的 oracle 把几百 MB 的部分 stdout 塞进账本。 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}