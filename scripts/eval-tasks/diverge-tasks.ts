/**
 * eval-tasks/diverge-tasks —— 跨家族发散 eval 的题库 + 隐藏金标 (owner 2026-07-27)。
 *
 * 设计要点:
 *  - **seeds 对生成体全隐藏**, 只喂 grader。生成 prompt 里不得出现 seed 措辞 (否则测的是提示不是能力)。
 *  - seed 选"非显然但真重要"的考量/缺陷: 显然点人人都提 → 天花板效应, 测不出地板。
 *  - grill 题的 seed = **植入缺陷**, ground truth 客观 (计划是我写的, 缺陷是我埋的), grader 噪声最低。
 *  - personas 两臂逐字相同 → 单变量只剩"这个 persona 由哪个家族跑"。
 */

/** 一个考量/缺陷金标点。text 给 grader 判命中; nonObvious 只作记录, 不进任何 prompt。 */
export interface Seed {
  id: string;
  text: string;
  nonObvious: string;
}

export interface EvalTask {
  id: string;
  /** council = 生成式设计题; grill = 对抗式挑错题 (植入缺陷)。 */
  kind: 'council' | 'grill';
  /** 喂给生成体的题面 (不含任何 seed 措辞)。 */
  brief: string;
  seeds: Seed[];
}

/** 6 个视角槽位: 两臂共用, 只有"谁来跑这个槽"不同。temperature 按视角调探索度。 */
export interface Persona {
  id: string;
  persona: string;
  angle: string;
  temperature: number;
  topP: number;
}

export const PERSONAS: readonly Persona[] = [
  {
    id: 'delivery',
    persona: '代入务实的交付型工程主管',
    angle: 'MVP-first: 最小可行切口, 最快验证, 砍掉一切非核心',
    temperature: 0.4,
    topP: 0.85,
  },
  {
    id: 'sre',
    persona: '代入资深 SRE',
    angle: 'failure-first: 从失败模式/边界/不可逆点倒推, 先堵风险',
    temperature: 0.5,
    topP: 0.9,
  },
  {
    id: 'security',
    persona: '代入对抗性安全工程师',
    angle: '攻击者视角: 谁能滥用它, 哪里 fail-open, 信任边界在哪断',
    temperature: 0.5,
    topP: 0.9,
  },
  {
    id: 'first-principles',
    persona: '代入第一性原理思考者',
    angle: '质疑既定前提, 找最简结构, 优先删除而非新增',
    temperature: 0.75,
    topP: 0.95,
  },
  {
    id: 'data',
    persona: '代入数据一致性/存储工程师',
    angle: '状态视角: 并发/顺序/持久化/恢复, 数据什么时候会对不上',
    temperature: 0.5,
    topP: 0.9,
  },
  {
    id: 'longterm',
    persona: '代入 6 个月后回看今天的运维负责人',
    angle: '演进视角: 可观测/可迁移/可回滚, 今天的选择半年后变成什么债',
    temperature: 0.6,
    topP: 0.9,
  },
];

export const TASKS: readonly EvalTask[] = [
  {
    id: 'webhook-billing',
    kind: 'council',
    brief: `为一个多租户 SaaS 设计"上游支付服务商 webhook 接入 → 按事件对租户计费扣费"的管道。
上游 (Stripe 类) 推送订阅/支付事件到我们的 HTTP 端点, 我们据此给租户账户扣费并记账, 结果要能对账。
给出你的方案设计 + 你认为必须处理的关键考量清单 (每条: 是什么问题 + 怎么处理)。写实质内容, 不要套话。`,
    seeds: [
      {
        id: 'idem-key-source',
        text: '幂等键必须取自上游事件 id (或上游给的 idempotency key), 不能用请求体 hash / 到达时间派生 —— 同一事件重投时体或包装可能不同, 体 hash 会漏判为新事件。',
        nonObvious: '大多数答案会说"要幂等", 但不追究幂等键取自哪里, 而键源错了幂等就是假的。',
      },
      {
        id: 'idem-ttl-vs-retry',
        text: '幂等记录的保留期必须 ≥ 上游最大重试窗口 (常数天), 否则记录过期后迟到的重投被当新事件 → 重复扣费。',
        nonObvious: '幂等 TTL 与上游重试窗口的关系几乎总被忽略, 是真实重复扣费的常见根因。',
      },
      {
        id: 'charge-record-atomicity',
        text: '"扣费" 与 "记账/标记已处理" 跨系统不在同一事务, 中间崩溃会重复扣或扣了不记 —— 需要 outbox / 先写意图再执行 / 补偿对账, 而非依赖两次写都成功。',
        nonObvious: '双写原子性是本题真正的硬点, happy-path 方案会直接串行写两处。',
      },
      {
        id: 'out-of-order',
        text: '事件可能乱序到达 (updated 早于 created, 或退款早于扣款), 必须按上游版本号/序号做单调性判断, 不能用到达时间或本地时钟排序 (时钟偏斜)。',
        nonObvious: '至少一次投递通常被提到, 但"乱序 + 不能靠时间戳定序"很少被点破。',
      },
      {
        id: 'signature-replay',
        text: '签名校验之外还要校验时间戳窗口 + 拒绝窗口外重放, 否则截获的合法签名请求可被无限重放。',
        nonObvious: '大多数答案止于"验签名", 不提重放窗口。',
      },
      {
        id: 'tenant-isolation',
        text: '共享队列/worker/限流下, 单个大租户的事件洪峰会饿死其他租户 —— 需要按租户分片或公平调度 (noisy neighbor)。',
        nonObvious: '多租户下的公平性/隔离在 happy-path 设计里基本不出现。',
      },
      {
        id: 'poison-dlq',
        text: '永久失败的毒丸消息需要 DLQ + 重试上限 + 告警, 否则无限重试打死下游并阻塞队列头。',
        nonObvious: '重试常被提到, 重试上限与队头阻塞常被忽略。',
      },
      {
        id: 'money-integer',
        text: '金额一律用最小货币单位整数 + 明确舍入方向/币种, 禁浮点; 汇率与舍入必须可复现, 否则对账长期漂移。',
        nonObvious: '钱的表示是会计接缝的硬约束, 设计稿里常被默认掉。',
      },
      {
        id: 'replay-sideeffect-switch',
        text: '历史回放/重放事件必须与真实扣费的副作用解耦 (dry-run / 只重建视图), 否则一次回填就是一次全体真实扣费。',
        nonObvious: '重放能力人人想要, 但"重放会不会再扣一次钱"极少被前置设计。',
      },
      {
        id: 'refund-compensation',
        text: '退款/撤销/争议事件的补偿路径要与已出账单/已开票状态挂钩 (冲正而非删除), 保证账面可审计。',
        nonObvious: '正向流之外的逆向流通常被整体遗漏。',
      },
    ],
  },
  {
    id: 'online-schema-migration',
    kind: 'council',
    brief: `设计一次"零停机在线 schema 迁移": 一张亿级行的热表 (持续读写), 要把一个字段拆成新结构并切换应用读写路径。
数据库是主从复制的关系型库, 应用是多实例滚动发布。给出迁移方案 + 你认为必须处理的关键考量清单 (每条: 是什么问题 + 怎么处理)。写实质内容, 不要套话。`,
    seeds: [
      {
        id: 'backfill-vs-live-race',
        text: '回填批次与实时写并发同一行时, 回填不能盲写覆盖 —— 必须条件写/只填未迁移行, 否则回填会把更新的实时值写回旧值。',
        nonObvious: '回填与实时写的覆盖竞争是本题最经典的静默数据损坏点。',
      },
      {
        id: 'expand-contract',
        text: '走扩展-收缩 (先加不删 / 先双写后切读 / 最后才删旧字段), 保证任一时刻新旧版本应用都能跑 —— 滚动发布期新旧代码同时在线。',
        nonObvious: '滚动发布意味着新旧应用共存, 单步切换的方案在这一步就废了。',
      },
      {
        id: 'batch-and-replica-lag',
        text: '回填必须分批 + 限速 + 按复制延迟反压, 大事务会撑爆复制延迟和 undo/日志, 拖垮只读副本。',
        nonObvious: '"分批"常被提, "按 replica lag 反压"很少。',
      },
      {
        id: 'dirty-data-precheck',
        text: '新结构的约束 (唯一/非空/格式) 会在回填时才被历史脏数据触发 —— 必须先做全量预检并决定脏数据策略, 而不是迁移中途失败。',
        nonObvious: '历史脏数据违反新约束是迁移中断的高频原因, 事前预检很少写进方案。',
      },
      {
        id: 'resumable-watermark',
        text: '回填要幂等可重入 + 记录进度水位, 中断后能续跑而非从头, 且续跑不重复副作用。',
        nonObvious: '亿级行回填必然被中断, 但方案常假设一次跑完。',
      },
      {
        id: 'stale-read-replica',
        text: '灰度期从只读副本读到的可能是旧结构/旧数据 (延迟 + DDL 传播), 读路径切换要考虑副本一致性, 不能只按主库状态判断。',
        nonObvious: '主从架构下的读路径灰度是隐蔽坑。',
      },
      {
        id: 'app-cache-schema',
        text: '应用侧的 prepared statement / ORM 元数据 / 连接池缓存的 schema 不会自动刷新, DDL 后老连接可能持续用旧列集报错。',
        nonObvious: '数据库侧完成 ≠ 应用侧生效, 这层几乎只有踩过的人会写。',
      },
      {
        id: 'verify-before-cutover',
        text: '切换前需要确定性一致性校验 (全量或采样 checksum 比对新旧字段), 用证据而非"回填跑完了"来决定能不能切。',
        nonObvious: '"怎么证明可以切"是判断闸, 常被"跑完就切"取代。',
      },
      {
        id: 'rollback-path',
        text: '切读之后仍要保留可回滚窗口 (旧字段继续被写/保留一段时间), 明确不可逆点在哪一步 —— 删旧字段才是不可逆点。',
        nonObvious: '很多方案把切换当终点, 不标不可逆点与回滚窗口。',
      },
      {
        id: 'index-build-cost',
        text: '新结构上的索引创建对热表是重操作 (锁/资源/复制), 要用在线/并发建索引并把它当独立高风险步骤排期。',
        nonObvious: '加索引常被当成迁移的附属动作, 实际是独立风险步。',
      },
    ],
  },
  {
    id: 'memory-layer-grill',
    kind: 'grill',
    brief: `下面是一份"Agent 长期记忆层"设计草案, 准备照此实施。请以你的视角审查它, 找出其中**真实存在**的设计缺陷/风险。
逐条给出: 缺陷是什么 + 为什么会出问题 + 怎么改。只报真缺陷, 不要泛泛而谈, 不要复述草案。

──────── 草案 ────────
1. 存储: 所有记忆写入单个 memories.jsonl 文件, 每条一行 JSON, 追加写入。多个 agent 进程共用这一个文件。
2. 写入: 每次 session 结束, 把整段对话喂给模型, 让它总结成若干条记忆并追加。不做去重, 不做冲突检测 —— 新的一条自然排在后面, 读的时候后面的优先。
3. 召回: 对每条记忆做 embedding, 查询时取余弦相似度 top-k (k=10), 相似度阈值固定 0.7, 低于阈值丢弃。
4. 注入: 召回结果由模型判断相关性, relevance > 0.5 的全部拼进本次 system prompt。注入内容就是记忆正文。
5. 脱敏: 写入前让模型检查这条记忆里有没有密钥/密码/个人隐私, 判定为敏感则跳过不写。
6. 生命周期: 记忆永久保留, 不做过期/衰减 —— 历史越全越好。
7. 演进: embedding 模型将来要换的话, 全量重算一次索引即可。
────────────────────`,
    seeds: [
      {
        id: 'concurrent-append',
        text: '多进程并发追加同一 jsonl 无锁/无原子写 → 交错写入产生坏行或丢记录; 需单写者/文件锁/原子替换或换成真数据库。',
        nonObvious: '追加写"看起来"是原子的, 多进程 + 大行时并不是。',
      },
      {
        id: 'no-dedup-conflict',
        text: '不去重不做冲突检测 → 同一事实反复写入且新旧矛盾并存, "后写优先"会让被更正过的旧事实又被新一轮错误总结覆盖; 需要按实体归并 + 显式冲突仲裁。',
        nonObvious: '草案把"后面的优先"当成仲裁策略, 实际是无仲裁。',
      },
      {
        id: 'fixed-threshold',
        text: '固定 0.7 余弦阈值不可移植 —— 阈值随 embedding 模型/领域/文本长度漂移, 换模型后要么召不回要么全召回; 应用相对排序/校准而非绝对常数。',
        nonObvious: '硬编码相似度阈值是 RAG 最常见的隐性脆点。',
      },
      {
        id: 'no-lexical-fallback',
        text: '纯向量召回对专有名词/ID/路径/错误码这类精确串召回差 → 需要词法 (BM25/精确匹配) 混合检索兜底。',
        nonObvious: '纯语义检索在工程记忆场景恰好在最需要精确的地方失手。',
      },
      {
        id: 'unbounded-injection',
        text: '注入无预算上限 (只有 relevance>0.5 的软条件) → 记忆增长后挤爆 context / 稀释主线任务; 需要 token 预算 + 硬性条数上限 + 按价值排序截断。',
        nonObvious: '相关性闸不是预算闸, 两者常被混为一谈。',
      },
      {
        id: 'model-redaction-failopen',
        text: '把脱敏交给模型判断是 fail-open: 漏判即永久写入密钥/隐私; 应先跑确定性检测 (正则/熵/白名单) 再谈模型判断, 且默认拒绝而非默认写入。',
        nonObvious: '"模型来判断敏感信息"是典型的把可靠性放进模型内部。',
      },
      {
        id: 'no-decay-staleness',
        text: '永不过期 + 无衰减 → 陈旧事实 (改过的路径/接口/决定) 与现状冲突却仍被高分召回, 反而主动误导; 需要时效标注 + 衰减/复验/失效机制。',
        nonObvious: '"历史越全越好"在记忆层是错的, 陈旧记忆的危害大于缺失。',
      },
      {
        id: 'no-provenance',
        text: '注入的是记忆正文, 没有来源/时间戳/置信度 → 消费方无法判断该不该信、能不能核实, 幻觉被当既成事实继承。',
        nonObvious: '溯源缺失让所有下游判断失去纠错入口。',
      },
      {
        id: 'no-eval-baseline',
        text: '没有召回质量基准/回归集 → 任何调整 (阈值/模型/策略) 都无法证明变好还是变差, 记忆层会随改随烂。',
        nonObvious: '检索系统没有 eval 就没有方向盘, 草案完全没提。',
      },
      {
        id: 'reindex-migration',
        text: '换 embedding 模型时"全量重算"缺可用性设计: 重算期间新旧向量空间不可混用比较, 需要双索引并行 + 版本标记 + 灰度切换, 否则重算窗口内召回不可用或结果错乱。',
        nonObvious: '不同 embedding 空间的向量不可比较, 草案默认可以就地替换。',
      },
      {
        id: 'summary-lossy-unverified',
        text: '整段对话交模型总结且无核验 → 总结阶段的幻觉/误概括被固化成"记忆"并在未来被当事实复用, 错误随时间放大; 需要抽取时附原文锚点或可核验片段。',
        nonObvious: '记忆层的真正污染源在写入端, 草案只关心读取端。',
      },
    ],
  },
];

export const TASK_BY_ID = new Map(TASKS.map((t) => [t.id, t]));

/** 生成 prompt: seed 一个字都不进 (否则测的是提示不是能力)。矩阵与渠道探针共用同一份, 保证可比。 */
export function buildGenPrompt(task: EvalTask, p: Persona): string {
  const ask =
    task.kind === 'council'
      ? '给出你的方案 + 关键考量清单。每条考量写: 问题是什么 + 怎么处理。宁可少而实, 不要罗列套话。'
      : '逐条给出你发现的真实缺陷: 缺陷是什么 + 为什么出问题 + 怎么改。只报真缺陷, 不要复述草案。';
  return `${p.persona}。你的视角: ${p.angle}。坚定走这个视角到底, 不要中庸折中。

${task.brief}

${ask}`;
}
