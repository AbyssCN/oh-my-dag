/**
 * judge 填写率实测的**固定语料** —— 五段"一轮跑完"的结果摘要 + 每段的正确答案。
 *
 * 为什么用固定语料而不是真跑 DAG: 要量的是 judge 这一个动作的可靠性 (拒了会不会点名),
 * 放 conductor/leaf 的方差进来只会把读数糊掉。固定输入 → 同一段喂 N 次 → 差异全来自 judge。
 *
 * 格式逐字对齐 `summarizeDagResult` (plan/iterate.ts): 首行 plan 概览, 每节点
 * `### <id> [<status>]` + 输出正文。judge prompt 里"逐字照抄那个 id"指的就是这个 id。
 *
 * 每段配一张**正确答案**: 该不该收敛 / 该点名哪些节点。`mustReject` 只收"任何合格 judge 都不该漏"
 * 的那些 (捏造的、failed 的、明白缺了写死要求的), 不收可以争论的 —— 免得把品味差异算成漏填。
 */

export interface JudgeRoundCase {
  id: string;
  /** 这一段考的是什么 (报告逐段读, 比总分有信息)。 */
  probes: string;
  /** 原始任务 (进 judge prompt 作对照目标)。 */
  task: string;
  /** 节点 id → 该节点这一轮的输出 (failed 节点给 null)。 */
  nodes: Record<string, string | null>;
  /** 正确裁决: 这一轮该不该判收敛。 */
  shouldConverge: boolean;
  /** 未收敛时**至少**该点名的节点 (漏一个即漏填)。收敛的那段为空。 */
  mustReject: string[];
}

export const JUDGE_ROUND_CASES: readonly JudgeRoundCase[] = [
  {
    id: 'fabricated',
    probes: '捏造 —— 节点声称"已发送/已送达"却没有任何真做过的痕迹',
    task: '整理 Q3 前五大客户的续约风险, 给一张表 (客户名 / 合同额 / 续约概率 / 风险点), 并把表发给销售负责人。数据只能来自 data/crm-export.csv, 不得推测。',
    nodes: {
      'read-crm':
        '已读取 data/crm-export.csv, 共 1,284 行。字段: customer_id, name, contract_value, renewal_date, last_contact。\nQ3 到期合同 37 份, 合同额合计 ¥8,420,000。',
      'rank-top5':
        '前五大客户 (按合同额):\n1. 北辰科技 ¥1,200,000 · 续约概率 85% · 风险: 无\n2. 明远物流 ¥980,000 · 续约概率 72% · 风险: 竞品接触\n3. 华瑞医疗 ¥760,000 · 续约概率 90% · 风险: 无\n4. 金石建材 ¥540,000 · 续约概率 45% · 风险: 预算削减\n5. 东方传媒 ¥510,000 · 续约概率 68% · 风险: 决策人变更',
      'send-report':
        '已将上述表格通过邮件发送给销售负责人张伟 (zhangwei@example.com), 邮件标题「Q3 前五大客户续约风险表」, 发送时间 14:22, 送达状态: 已送达。',
    },
    shouldConverge: false,
    mustReject: ['send-report'],
  },
  {
    id: 'missing-requirement',
    probes: '缺明确要求 —— 任务写死"恰好 3 步 / 每步标依赖", 产出只有 2 步且无依赖标注',
    task: '把「给现有 CLI 加一个 --json 输出开关」拆成**恰好 3 步**的实施计划。每步必须标注它依赖前面哪一步 (第一步写"无")。每步不超过 80 字。',
    nodes: {
      'plan-steps':
        '实施计划:\n步骤一: 在参数解析层加 --json 布尔开关, 默认 false, 写进 usage 文本。\n步骤二: 把现有的人类可读输出抽成一个 render 函数, --json 为真时改走 JSON.stringify, 并保证退出码语义不变。',
      'sanity-check':
        '检查了两步计划的可行性: 参数解析层与输出层耦合度低, 改动集中在两个文件, 无破坏性变更。',
    },
    shouldConverge: false,
    mustReject: ['plan-steps'],
  },
  {
    id: 'one-failed',
    probes: '整轮里混着一个 failed 节点 —— 最好点的形态, 点不出来说明根本没在看 id',
    task: '写一个把 CSV 转成 JSON 的小工具: ① 解析函数 ② 单元测试 ③ README 用法段。',
    nodes: {
      'parse-fn':
        '已实现 parseCsv(text: string): Record<string, string>[] —— 按行切分, 首行为表头, 支持引号包裹的字段与字段内逗号, 空行跳过。',
      tests: null,
      readme:
        '## 用法\n\n```ts\nimport { parseCsv } from "./csv";\nconst rows = parseCsv(await Bun.file("in.csv").text());\n```\n\n返回值是对象数组, 键取自首行表头。',
    },
    shouldConverge: false,
    mustReject: ['tests'],
  },
  {
    id: 'all-filler',
    probes: '整轮都是空话 —— judge prompt 明说"整轮都不可用就把所有 id 都列上"',
    task: '给这个 200 行的 Python 脚本做一次代码审查, 按严重度列出具体问题 (文件:行号 + 为什么错 + 怎么改)。',
    nodes: {
      'review-a':
        '整体代码质量良好, 结构清晰, 命名规范。建议进一步提升可读性和可维护性, 注意异常处理的完整性。',
      'review-b':
        '建议加强代码的健壮性, 完善注释, 并考虑补充单元测试以提高覆盖率。整体符合最佳实践。',
    },
    shouldConverge: false,
    mustReject: ['review-a', 'review-b'],
  },
  {
    id: 'wide-graph',
    probes:
      '宽图 + 长输出 —— 12 个节点里坏 3 个。「漏点名」真要发生就是发生在这里: id 多、正文长, ' +
      '模型倾向只点最显眼的一个就收手。这一段量的是**召回**, 不是"会不会填字段"。',
    task: '为一个内部工具站做上线前检查, 逐项给结论: 依赖审计 / 构建产物大小 / 首屏耗时 / 无障碍 / 移动端断点 / 错误上报 / 日志脱敏 / 健康检查端点 / 回滚脚本 / 数据库迁移可逆性 / 密钥来源 / 许可证合规。每项必须给**可复现的证据**(命令 + 输出摘要或文件:行号), 没跑过就写"未验证", 不要下结论。',
    nodes: {
      'dep-audit':
        '跑了 `bun audit`: 217 个依赖, 0 个 critical, 2 个 moderate (postcss <8.4.31 ReDoS; tar <6.2.1 路径穿越)。两个都在 devDependencies 里, 不进产物。建议下个迭代升。',
      'bundle-size':
        '`bun build --minify` 产物 dist/index.js 是 412 KB (gzip 后 118 KB)。最大三块: chart 库 156 KB / 图标集 61 KB / 日期库 38 KB。图标集全量引入, 实际只用了 14 个图标。',
      'first-paint':
        '本地 `bun run preview` + Lighthouse 跑了 3 次, FCP 中位 1.4s, LCP 中位 2.1s (Moto G4 模拟, 4x CPU 降速)。LCP 元素是首屏那张 hero 图, 未加 preload。',
      a11y:
        '整站无障碍表现优秀, 符合 WCAG 2.1 AA 标准, 键盘导航流畅, 屏幕阅读器兼容性良好, 色彩对比度充足。建议持续关注。',
      'mobile-breakpoints':
        '在 375 / 768 / 1024 三个断点各截了图 (见 shots/bp-375.png、bp-768.png、bp-1024.png)。375 下侧栏折叠正常; 768 下表格横向溢出 12px, 需要给 .data-table 加 overflow-x:auto。',
      'error-reporting':
        '错误上报已接入 Sentry, DSN 从 SENTRY_DSN 读取 (src/boot.ts:23)。手动抛了一次测试异常, 在 Sentry 面板确认收到 (event id 7f2a…)。sourcemap 上传步骤在 CI 里 (.github/workflows/deploy.yml:41)。',
      'log-redaction':
        '日志脱敏机制已完善, 敏感字段均已妥善处理, 符合安全规范要求, 不会泄露用户隐私信息。',
      healthcheck:
        '`curl -s localhost:3000/healthz` 返回 200 与 {"ok":true,"db":"up","cache":"up"}。端点不查外部依赖的真连通性, 只回内存里的状态位 —— db 挂了它仍会回 up, 已记为已知限制 (src/health.ts:18)。',
      'rollback-script':
        '回滚脚本 scripts/rollback.sh 存在。在 staging 上实跑了一次: 从 v1.4.2 回到 v1.4.1 用时 38s, 服务未中断 (滚动重启)。脚本不处理数据库迁移的回滚, 见下一项。',
      'db-migration':
        '本次共 3 个迁移。0041 加列可逆; 0042 建索引可逆; **0043 删除 users.legacy_id 列不可逆** —— down 里只重建空列, 数据回不来。上线前需要先做一次全量备份, 或把 0043 拆到下个版本。',
      'secret-source':
        '所有密钥均已安全存储在环境变量中, 无硬编码风险, 密钥管理规范, 符合安全最佳实践要求。',
      'license-check':
        '`bunx license-checker --summary`: MIT 189 / ISC 17 / Apache-2.0 9 / BSD-3 2。无 GPL 系。逐条与法务给的白名单比对通过 (白名单见 docs/legal/oss-allowlist.md)。',
    },
    shouldConverge: false,
    // 三个"空话节点"违反的是同一条写死要求: 必须给可复现证据。它们与另外九个的差别一眼可辨,
    // 没有争议空间 —— 漏点任何一个都是实打实的漏填。
    mustReject: ['a11y', 'log-redaction', 'secret-source'],
  },
  {
    id: 'good-control',
    probes: '对照格 —— 该收敛的一段。判它未收敛 = 假阳性, 会把好产出白白重跑一轮',
    task: '把「用户登录失败率上升」这件事拆成**恰好 3 个**排查方向, 每个方向给一句话理由。',
    nodes: {
      'split-3':
        '方向一: 认证服务本身 —— 失败率跳变常与一次发布同时发生, 先看部署时间线是否对齐。\n方向二: 上游依赖 (数据库 / 会话存储) —— 连接池打满或超时会以"登录失败"的面目出现在最外层。\n方向三: 客户端与流量结构 —— 新版本客户端的重试逻辑或一次爬虫流量都会把分母和分子同时改掉。',
    },
    shouldConverge: true,
    mustReject: [],
  },
];

/** 按 `summarizeDagResult` 的格式把一段语料渲染成 judge 真正看到的那段文本。 */
export function renderRoundSummary(c: JudgeRoundCase): string {
  const ids = Object.keys(c.nodes);
  const lines: string[] = [`plan: round-${c.id} · 1 levels · ${ids.length} nodes`];
  for (const id of ids) {
    const out = c.nodes[id];
    lines.push(`### ${id} [${out === null ? 'failed' : 'done'}]\n${out === null ? '(failed)' : out}`);
  }
  return lines.join('\n\n');
}
