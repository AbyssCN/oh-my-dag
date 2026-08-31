/**
 * src/harness/shapes —— **图式 (shape) 的单一真源**。
 *
 * 三层各管一件事, 粒度递减 —— 别混:
 *   skill  「这类活该走哪条路」 路由 + 验收纪律     载体 client-skills/*.md   消费者 agent runtime
 *   shape  「这条路上的图长什么样」节点怎么排 + 为什么 + **什么时候别用**  消费者 分解者
 *   card   「图里这个节点怎么把活干好」专家检查单    载体 .omd/agents/*.md     消费者 leaf prompt
 *
 * **为什么要数据化**: 这些形状原本以散文散在 conductorSystemPrompt 里 —— 没有触发条件、没有反例、
 * 没有"为什么"。而 omd 正在从"图是唯一入口"走向"任何 SOTA agent 经 MCP 自由组合"(见 README
 * 的定位): 组合模式下 conductor 不在场, 这些**攒了很久的图形状知识会直接蒸发**。
 *
 * 一份数据, 两个消费面 (与 DEFAULT_COMMAND_ALLOWLIST 同款做法):
 *   ① conductorSystemPrompt —— 渲染成 prompt 行 (图模式, 行为与散文版等价)
 *   ② MCP 工具 —— 组合模式下, 外部 agent 分解前取一次
 * skill 里**只存"去取 shape"这个动作, 不存内容** —— 抄第二份必然漂移。
 *
 * `whenNot` 是数据化强制多出来的那一栏, 也是最值钱的一栏: 反例和正例一样是知识, 散文形式下
 * 它总是第一个被省掉的 (LangChain《3 years of graph engineering》整篇的落点就是 "when not to use")。
 */

/** 图式 few-shot 样例 (SHAPE_EXAMPLES, 2026-08-31)。来源真实 dag-runs 账本绿跑;
 *  编造样例 = 把先验伪装成证据 (仓规)。无源卡 example 字段缺席 —— 缺席合法 ≠ 0。
 *  与 §静默坑 1 同源: 把「没样例」读成「权重为 0」会把未来后补通道堵死。 */
export interface ShapeExample {
  /** 真实绿跑 runId (8 位) —— 锚串逐字来自附录, GWT-1 用此 grep。 */
  source: string;
  /** 一行:为什么这条图跑这个形状 (人话, 给模型"这个形状触发什么"的锚)。 */
  goalHint: string;
  /** 蒸馏后的图结构逐行 (代码块风格; keyBy/probe 节点全保留, 兄弟省略号照写)。 */
  graph: string[];
}

export interface GraphShape {
  /** 稳定 id (工具输出与 prompt 渲染共用)。 */
  id: string;
  /** 一行说明:这个形状解决什么。 */
  what: string;
  /** 触发条件 —— 什么时候该用它。 */
  when: string;
  /** **反例** —— 什么时候别用它 (数据化强制要求;散文版从来没有这一栏)。 */
  whenNot: string;
  /** 节点怎么排 (每行一步)。 */
  steps: string[];
  /** 为什么是这个形状 —— 换个形状会坏在哪。 */
  why: string;
  /** 引擎是否**强制**它 (硬闸), 还是只是建议。 */
  enforced?: string;
  /** 真实绿跑样例 —— **有才填, 没有就 undefined** (D-2 缺席合法)。 */
  example?: ShapeExample;
}

export const GRAPH_SHAPES: readonly GraphShape[] = [
  {
    id: 'one-decision-then-fanout',
    what: '一个决策节点在前, 一片执行节点在后, 全部依赖它',
    when: 'N 个节点必须就同一个接口 / schema / 命名 / 设计决策达成一致',
    whenNot: '各节点的产物互不引用 (那就是普通并行, 加决策节点只是多一层串行延迟)',
    steps: [
      '一个 leaf 节点 OUTPUT 那个决策 (接口文本 / schema / 命名表), 给 tier:"strong"',
      'N 个执行节点全部 depends_on 它, 彼此之间不连边',
    ],
    why:
      '不这么排就是 N 个兄弟各自发明一份, 得到 N 份互不兼容的答案和一次没人负责的合并。' +
      '这也是整张图里最值得花强模型的一个点 —— 它下面的 worker 是在**转录**一个决策, 不是在做决策, 所以可以廉价。',
    // A1 ← run 49e1bfcf 「goal-contract-冻结判据失败明细必达块」(21 节点, 扇出 18, 宽图)
    example: {
      source: '49e1bfcf',
      goalHint:
        '契约勘察段 —— 一次探明全部落点, 18 个调查兄弟并行消费同一份基准',
      graph: [
        'probe_landmarks [command] ← —          (输出勘察基准: 全部落点一次探明, 供所有兄弟消费)',
        'survey_handoff [agent] ← probe_landmarks',
        'survey_failure_detail::a [command] ← probe_landmarks',
        'survey_failure_detail::b [command] ← probe_landmarks',
        '… 共 18 个调查兄弟, 彼此零连边, 全部只依赖 probe_landmarks',
      ],
    },
  },
  {
    id: 'ui-evidence',
    what: 'UI 交付物后面挂 [渲染 → 确定性截图闸]',
    when: '任何节点的交付物是用户可见的 UI (HTML/CSS、组件、页面、动效)',
    whenNot: 'TUI / 纯文本输出 —— 它们的证据是 ANSI 文本, 走普通审查, 不转图不占多模态池',
    steps: [
      'executor:"command" 渲染节点: 截图并**打印图片路径**',
      'executor:"command" 跑 `omd-shots-verify`: 截图真存在 / 非空 / 不是白板 —— **零模型**',
      '(可选) attach_media:true 审查 leaf 接在闸后面, 判品味',
    ],
    why:
      '地板必须是零模型的: **模型判断这一环失败是静默的** —— 它没跑时没有任何东西会变红, ' +
      '主指标照样全绿。确定性闸没跑就是没跑, 白板就是红的。' +
      '看得懂设计好不好是品味, 属于人或图外。',
    enforced: 'evidence pass 硬闸: 卡声明 evidence:"ui-pixels" 的节点缺这条链 → 自动补挂; 补不出 → 拒 plan',
  },
  {
    id: 'full-stack',
    what: '一份含 UI 与 API 两个面的 spec 的标准分解',
    when: 'spec 同时要求后端接口与前端界面',
    whenNot: '只有一个面 (纯后端 / 纯前端) —— 那用 one-decision-then-fanout 就够, 别硬套六步',
    steps: [
      'research 簇: 并行兄弟叶 (领域 / UX 参照 / 技术约束), cluster:"research"',
      '一个契约节点依赖 research —— 即 one-decision-then-fanout 应用在接口面上',
      'backend 簇 + frontend 簇: 全部 depends_on 契约节点, **跨簇不连边** (所以能真并行)',
      'ui-evidence 链接在前端产物后面',
      'cross-review 节点: 依赖 契约 + 各实装, 抓契约违背与遗漏',
    ],
    why: '契约冻结之后两侧才互不依赖 —— 跨簇连边就把并行退化成串行, 而 pass 指标看不出这种"画错但能过"。',
  },
  {
    id: 'ui-best-of-n',
    what: 'N 个变体各自渲染, 一个裁判看全部截图',
    when: '视觉方案空间宽, 想要多个候选再择优',
    whenNot: '已有明确设计资产 —— 那是照着做不是选, 应该走 ui-evidence + 对参照图比对',
    steps: [
      'N 个变体 agent 节点 (互不依赖)',
      'N 个渲染 command 节点',
      '一个 attach_media 裁判, requires:K —— 挂掉的变体不拖死判决',
    ],
    why: 'requires:K 是关键: 不给的话一个变体失败就让整个判决级联 skip, N 份钱白花。',
  },
  {
    id: 'runtime-work-list',
    what: '待处理集合在规划期未知 → 用 executor:"map"',
    when: '"审计每个模块 / 调研每个镜头 / 修每个失败测试" —— 现在**说不出**具体有哪些',
    whenNot: '集合已知且稳定 —— 直接写 N 个兄弟节点, map 的运行时展开是多余的间接层',
    steps: [
      '一个 executor:"map" 节点',
      'lister 子步在**运行时**跑出数组 (优先 executor:"command" 复用已有索引设施, 别让模型猜)',
      'template 按元素展开成子节点; keyBy 给稳定身份 → resume 只重跑变化的元素',
    ],
    why: '不这么做就会编一个"既枚举又处理"的假命令 (那个工具并不存在), 或者凭空写死一份猜测的清单。',
    // A2 ← run 0f53b6fe 「f2-cross-source-fact-synthesis」(26 节点, map 展开 10 份)
    example: {
      source: '0f53b6fe',
      goalHint:
        '读 10 篇论文回答 8 个问题 —— 清单在规划期已存在于盘上但不该手抄',
      graph: [
        'paper_corpus [map] — lister 子步用 command 在运行时列出 10 篇论文路径',
        'paper_corpus::<论文> [command] ×10 — 模板按元素展开, keyBy 给稳定身份',
        'load_checklist [command] ← —',
        '(下游综合节点 fan-in paper_corpus 与 load_checklist)',
      ],
    },
  },
  {
    id: 'runtime-decomposition',
    what: '一步在规划期**分不出来**, 留一个 executor:"conductor" 节点, 到它跑的时候现场画子图',
    when:
      '这一步该怎么拆, 取决于上游跑出来的东西 —— "看完调研再决定分几路" / "按契约定下来的接口面拆实装"。' +
      '规划期硬拆只能瞎猜, 猜错的那张图会被照着执行。',
    whenNot:
      '① 现在就拆得出来 —— 那就直接把节点写出来, conductor 节点是多一次模型调用 + 多一层间接, 白花的。' +
      '② 要扇的是**同一件事的 N 份** (每个模块审一遍 / 每个镜头查一遍) —— 那是 runtime-work-list (map), ' +
      '它有模板和 keyBy, 比让 conductor 手写 N 个几乎一样的节点稳且便宜。' +
      'conductor 节点是给**异构**步骤用的 (各有各的 goal/executor/依赖)。',
    steps: [
      '一个 executor:"conductor" 节点, goal 写清"要达成什么", 不写"分几步"(那正是留给它现场判的)',
      '它的 depends_on 挂上"决定怎么拆"所需要的上游 —— 展开时那些输出会进它的 prompt',
      '(可选) max_nodes 钳住子图规模; 缺省 64, 与 map 的 maxItems 同一个数',
      '子图由它现场画, 子节点走完整的 leaf 全套 (路由/产物闸/checkpoint), 与手写节点无差',
    ],
    why:
      '把"分不出来的一步"硬拆成静态节点, 得到的是一张**看起来完整但建立在猜测上**的图 —— 而图一旦画出来就会被照着执行, ' +
      '没有任何环节会因为"当初拆错了"变红。留成 conductor 节点是把这个决定推迟到**信息真的到齐**的时刻。' +
      '\n代价要认: conductor 的规划质量成了一个新的单点 (原本静态图至少是人审过的)。' +
      '所以子图过与外层同一条 pass 管线 (prune→dedup→evidence→stamp), 且禁嵌套 —— 展开只许一层。',
    enforced:
      '展开闸: 子节点禁再用 conductor/map (D-D); 子图有环 / 空 / 不是合法 plan → 整份拒, 一个子节点都不跑; ' +
      '子节点 id 内容寻址 (D-B), conductor 改名不改内容则 resume 照旧命中',
    // A3 ← run 5d0853b6 「goal-execute」(11 节点, conductor 现场画 9 节点异构子图)
    example: {
      source: '5d0853b6',
      goalHint:
        '执行段怎么拆取决于契约内容 —— 规划期留 conductor 节点, 跑到时现场分解',
      graph: [
        'execute [conductor] ← —    goal 只写「要达成什么」, 不写分几步',
        'execute::impl [agent] → execute::gate [command] → execute::fix [agent] → …',
        '  (运行时展开: agent/command 混排 9 节点, 各有各的依赖边, 含 red→impl→verify 链)',
        'accept [command] ← execute   (外层验收不进子图)',
      ],
    },
  },
  {
    id: 'research-lens',
    what: '多专家镜头并行 → 逐镜头收敛 → 综合 → 裁判 → 嫁接',
    when: '需要从多个角度把一个问题查透, 且**角度可以现场拟定**',
    whenNot:
      '通用探索式 deep research —— 连"该问什么"都还不知道时, 固定管线是错配 ' +
      '(LangChain《3 years of graph engineering》原话: 这类任务应该让规划在 harness 里涌现, ' +
      '而不是钉进图里)。那种情况让组合者自己 loop + 调原语。',
    steps: [
      '按任务现场编写镜头集 (每镜头一个 persona + 独立子角度)',
      '逐镜头 reduce 出该镜头的冠军',
      'framing 综合',
      'judge panel 多维评判 + 嫁接亚军亮点',
    ],
    why:
      '镜头之间必须**跨模型家族**分散 —— 同家族三个镜头产出三份同源盲点, fan-in 出来的"共识"是假的。' +
      'lens 集本身由模型现场编写 (管线固定, 内容全是变量), 别把它读成"形状写死"。',
    // A4 ← run 56fd4aa3 「omd README first-screen copy: 4 voices → judge panel → fused winner」(9 节点)
    example: {
      source: '56fd4aa3',
      goalHint:
        'README 首屏文案 —— 4 个 persona 竞稿, panel 评判, 嫁接融合',
      graph: [
        'draft_1_category_definer / draft_2_pain_narrative / draft_3_terse_engineer / draft_4_honest_skeptic [agent] ×4 互不依赖 (四个 persona 镜头)',
        'collect_drafts [command] ← 四稿',
        'judge_panel [agent] ← collect_drafts        (多维评判)',
        'fusion_winner [agent] ← judge_panel, collect_drafts   (嫁接亚军亮点)',
        'verify_artifacts [command] ← (落盘核验)',
      ],
    },
  },
  {
    id: 'research-second-pass',
    what: '第一轮之后再挖一轮 —— 但只挖**新的东西**',
    when: '第一轮出了答案, 而你需要的是深度不是覆盖面; 或第一轮暴露了没读的料 / 没出处的断言',
    whenNot: '第一轮已经回答了问题 —— 再来一轮只会得到同一批角度的重述。**重复的不是信息, 是噪声。**',
    steps: [
      '确定性探测器扫第一轮产物 (被引用却没抓取过的 URL / 没有出处的结论) —— 这是**下限**, 保证明显的漏不漏',
      '模型自由地读第一轮全文, 提出该继续挖什么 —— 这是**上限**, 不用规则替代它',
      '第二轮只做增量: 缺料的去抓 (web), 有料没挖透的换 lens 再蒸馏 (challenger lens 挖长尾), 不重跑原题',
      '轮数上限与"无新增即停"归引擎计数; **不要问模型"够了吗"**',
    ],
    why:
      '两个半边缺一不可: 只靠探测器 → 研究能力被限死在"已经拿到的 URL"里, 把 SOTA 当 grep 使; ' +
      '只靠模型自述"还缺什么" → 又回到那个静默失败 (它说够了你无从证伪)。' +
      '探测器保下限, 模型顶上限, 计数归引擎。' +
      '\n分段组合参考 xihe 三段链: web (抓, 零 LLM) / research (抓+综合) / distill (吃已有料, 多 lens 蒸馏) ——' +
      '第二轮多数时候不需要重抓, 只需要换 lens 重蒸。',
  },
];

/** 按 id 取一个 shape。 */
export function shapeById(id: string): GraphShape | undefined {
  return GRAPH_SHAPES.find((s) => s.id === id);
}

/**
 * 渲染成 conductor prompt 的行 (图模式消费面)。
 * lean 档只出 what/when/whenNot/steps —— 强模型自己推得出 why; 弱模型才需要理由压住偏置。
 * 样例是**证据不是理由** (D-3), 两档同渲染 —— 与 lean 档「省 why」正交; 无源卡零样例行。
 */
export function renderShapesForPrompt(profile: 'full' | 'lean' = 'full'): string[] {
  const out: string[] = [
    'Graph shapes (proven decompositions — match by trigger, and heed the "NOT when" line):',
  ];
  for (const s of GRAPH_SHAPES) {
    out.push(`- ${s.id} — ${s.what}`);
    out.push(`  WHEN: ${s.when}`);
    out.push(`  NOT when: ${s.whenNot}`);
    for (const step of s.steps) out.push(`  · ${step}`);
    if (profile === 'full') out.push(`  WHY: ${s.why}`);
    if (s.enforced) out.push(`  ENFORCED: ${s.enforced}`);
    // SHAPE_EXAMPLES (2026-08-31): 仅当 example 真存在才渲染; 无源卡严守 D-2 缺席合法。
    // lean 档渲染**拓扑短形**(剥行尾括号注释, 整行注释跳过)—— 两档都见样例与节点 id
    // (防空旋钮, 契约 D-3), 同时不吃掉 strong-coord.test.ts 的 lean 省 >20% prompt 预算不变量
    // (首跑 accept 红的实测: 两档同渲染全注把差压到 19.3%)。
    if (s.example) {
      out.push(`  EXAMPLE (real green run ${s.example.source}): ${s.example.goalHint}`);
      for (const line of s.example.graph) {
        const rendered = profile === 'full' ? line : line.replace(/[((][^))]*[))]\s*$/u, '').trimEnd();
        if (rendered) out.push(`  ${rendered}`);
      }
    }
  }
  // SH-1 (2026-08-30): 光在输出 schema 里列一个 "shape"?: string 是不够的 —— W1 (26895234)
  // 的教训是词表与散文缺任一个, 那一格的产出率就是 0。这里给出**指令**那一半。
  // 刻意允许缺席: 逼模型硬填一张卡会让它去凑, 而"没跟卡"本身是合法且有信息量的读数。
  out.push(
    'If your graph follows one of the shapes above, set the top-level "shape" field to that',
    'shape id (exact string, e.g. "one-decision-then-fanout"). If it follows none of them,',
    'OMIT the field — do NOT invent an id and do NOT force-fit a shape you did not use.',
  );
  return out;
}

/**
 * 这个 id 是不是已知图式卡 —— **消费面**的分类器(SH-1, 2026-08-30)。
 *
 * `ConductorPlan.shape` 的值域是 `string` 而不是枚举:一个拼错的 id 不该让整张 plan
 * 判 INVALID。所以「合法性」不在写侧拦,在读侧分 —— 与 `seat-usage.ts` 的
 * `seatOfTrace` / `traceIsClassified` 同一条纪律:原始观测原样写入磁盘,归类留给消费面,
 * 映射表将来发现错了历史行还能重算。
 *
 * ⚠ 读账的人**必须**把三种情形分开,别压平(仓规 §静默坑 1):
 *   · 缺席      = conductor 没跟任何一张卡(自由发挥)—— 合法状态;
 *   · 已知 id   = 跟了某张卡;
 *   · 未知 id   = 声明了但不在卡表里(拼错 / 卡表改名 / 模型编了一个)。
 * 把后两者混成「有 shape」会让「哪张卡好」的统计混进一堆不存在的卡。
 */
export function isKnownShapeId(id: string | undefined): boolean {
  return id !== undefined && GRAPH_SHAPES.some((s) => s.id === id);
}
