/**
 * hooks/jail-diagnosis —— **leaf 挂了之后,判它是"jail 挂载面缺东西"还是别的**
 * (jail 自检层③,owner 裁 2026-08-21)。
 *
 * ## 为什么是分类器,不是起跑探针
 *
 * jail 是 **per-leaf** 构造的(`sandboxed-leaf.ts` 每次 leaf 调用 spawn 一个 bwrap),
 * 所以任何"起跑前跑一组探针"的方案都会**乘以叶子数**。而那几笔事故里的大部分,
 * 事后从 stderr 上一眼就能认出来 —— 认出来是零成本的,**只在失败路径上跑,正常跑一次都不执行**。
 *
 * ## 它治的病:读数被写成假的
 *
 * S-34 那笔的代价不是"跑挂了",是**读数被写成「叶子空转」** —— 沙箱把 git 拿走,
 * 尺子同场失真,而失败判词看起来像模型不行。五笔 jail 次生事故的形状是同一个:
 * **jail 内缺了外面有的东西**(worker / git / node_modules / 路径长度),
 * 而每一次不完整都伪装成"模型不行"。
 *
 * 所以判据的关键不是"stderr 里有没有这句话",而是**这句话指的东西在宿主上存不存在**:
 *   · jail 里 `Cannot find module`,而宿主上 `node_modules` 就在 → **挂载面缺**,修部署;
 *   · jail 里 `Cannot find module`,宿主上也没有 → 真的没装,不是 jail 的锅。
 * 两者的下一步相反,编成一句话就等于把唯一能定方向的证据扔了。
 *
 * ## 边界
 *
 * · **不判模型好坏**,不判任务难易 —— 认不出来就返回 `null`,让原来的判词原样出去。
 * · 不做修复动作,只出判词。
 * · 不跑任何子进程:唯一的 IO 是"这个路径在宿主上存不存在",而且经 `existsOnHost` 注入。
 *
 * @module
 */
import { existsSync } from 'node:fs';

export interface JailDiagnosis {
  /** 缺的是什么(进判词的主语)。 */
  missing: string;
  /** stderr 里命中的那一句(留证:凭什么这么判)。 */
  evidence: string;
  /** 下一步该干什么 —— 与"加时间/换池"明确区分开。 */
  fix: string;
}

export interface JailDiagnosisDeps {
  /** 这个路径在**宿主**上存不存在。注入是为了能在测试里造出"宿主有 / 宿主也没有"两种世界。 */
  existsOnHost?: (path: string) => boolean;
}

/** 一条规则:命中正则 → 判词。`hostPath` 给了就要求"宿主上有"才算挂载面缺(否则是真的没装)。 */
interface Rule {
  re: RegExp;
  missing: string;
  fix: string;
  /** 从 match 里取出要在宿主上核对的路径;返回 null = 这条不需要核对宿主。 */
  hostPath?: (m: RegExpMatchArray, root: string) => string | null;
}

const RULES: readonly Rule[] = [
  {
    // bwrap 自己没起来 —— 这条排最前: 它一响, 后面所有症状都是它的下游。
    re: /^bwrap: (.+)$/m,
    missing: 'jail 本身没起来 (bwrap 报错)',
    fix: '看 bwrap 那句原文: 挂载点不存在 / 内核不给 unprivileged user namespace 都长这样, 两者修法不同',
  },
  {
    re: /(?:Cannot find module|Module not found)[^\n]*/,
    missing: 'jail 内没有 node_modules (依赖解析悬空)',
    fix: '检查 ensureNodeModulesLink / findNodeModules 是否返回 realpath —— symlink 会让 jail 内解析悬空 (86e6cdb 那笔)',
    hostPath: (_m, root) => `${root}/node_modules`,
  },
  {
    re: /fatal: not a git repository[^\n]*/,
    missing: 'jail 内没有 git 仓 (gitBinds 缺席)',
    fix: '给 bwrapArgs 传 gitBinds。⚠ 这笔的真正代价不是跑挂, 是**尺子同场失真**: 拿不到 git 的叶子会被记成"空转" (S-34)',
    hostPath: (_m, root) => `${root}/.git`,
  },
  {
    re: /(?:ENOENT[^\n]*?|command not found:\s*)['"`]?([\w./@-]+)['"`]?/,
    missing: 'jail 内缺一个宿主上存在的路径 / 可执行文件',
    fix: '把它加进 roBinds —— 挂载面不完整会伪装成"模型不行"',
    hostPath: (m) => m[1] ?? null,
  },
];

/**
 * 认一认这条 leaf 失败是不是 jail 挂载面造成的。
 *
 * @param stderr 子进程的 stderr(尾巴就够,规则都是行级的)。
 * @param root   jail 根(= 隔离 worktree),用来拼要在宿主上核对的路径。
 * @returns 认不出来 → `null`(**原判词原样出去**,不许瞎猜)。
 */
export function diagnoseJailFailure(stderr: string, root: string, deps: JailDiagnosisDeps = {}): JailDiagnosis | null {
  if (!stderr) return null;
  const exists = deps.existsOnHost ?? existsSync;
  for (const rule of RULES) {
    const m = stderr.match(rule.re);
    if (!m) continue;
    if (rule.hostPath) {
      const p = rule.hostPath(m, root);
      // 宿主上也没有 → **不是 jail 的锅**, 别抢答。认不出比认错强。
      if (!p || !exists(p)) continue;
    }
    return { missing: rule.missing, evidence: m[0].trim().slice(0, 200), fix: rule.fix };
  }
  return null;
}

/** 判词渲染 —— 一行,进日志与抛出的错误消息。 */
export function describeJailDiagnosis(d: JailDiagnosis): string {
  return `jail 挂载面缺东西: ${d.missing} · 证据: ${d.evidence} · 下一步: ${d.fix} (**不是**模型不行, 加时间/换池没用)`;
}
