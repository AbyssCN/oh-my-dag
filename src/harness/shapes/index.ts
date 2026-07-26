/**
 * src/harness/shapes —— **图式 (shape) 的单一真源** (2026-07-26 owner 定名: 用 shape 不用 motif ——
 * prompt 里本来就写着 "Full-stack SDD shape" / "control-flow SHAPE", eval 里的函数就叫 shapeOf,
 * 扶正已在用的词, 不再引入新词)。
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
 * 一份数据, 两个消费面 (与 DEFAULT_COMMAND_ALLOWLIST 同款做法, 2026-07-26 已验证):
 *   ① conductorSystemPrompt —— 渲染成 prompt 行 (图模式, 行为与散文版等价)
 *   ② MCP 工具 —— 组合模式下, 外部 agent 分解前取一次
 * skill 里**只存"去取 shape"这个动作, 不存内容** —— 抄第二份必然漂移。
 *
 * `whenNot` 是数据化强制多出来的那一栏, 也是最值钱的一栏: 反例和正例一样是知识, 散文形式下
 * 它总是第一个被省掉的 (LangChain《3 years of graph engineering》整篇的落点就是 "when not to use")。
 */

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
      '地板必须是零模型的: 实测一轮全栈 eval, 依赖多模态审查当地板时 6 次跑只走通 1 次, ' +
      '而主指标 pass 依然 1.000 —— **模型判断这一环失败是静默的**, 断了读数上看不出来。' +
      '确定性闸没跑就是没跑, 白板就是红的。看得懂设计好不好是品味, 属于人或图外。',
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
  },
  {
    id: 'research-lens',
    what: '多专家镜头并行 → 逐镜头收敛 → 综合 → 裁判 → 嫁接',
    when: '需要从多个角度把一个问题查透, 且**角度可以现场拟定**',
    whenNot:
      '通用探索式 deep research —— 连"该问什么"都还不知道时, 固定管线是错配 ' +
      '(LangChain 那篇文章的原话: 这类任务应该让规划在 harness 里涌现, 而不是钉进图里)。' +
      '那种情况让组合者自己 loop + 调原语。',
    steps: [
      '按任务现场编写镜头集 (每镜头一个 persona + 独立子角度)',
      '逐镜头 reduce 出该镜头的冠军',
      'framing 综合',
      'judge panel 多维评判 + 嫁接亚军亮点',
    ],
    why: '镜头之间必须**跨模型家族**分散 —— 同家族三个镜头产出三份同源盲点, fan-in 出来的"共识"是假的。',
  },
];

/** 按 id 取一个 shape。 */
export function shapeById(id: string): GraphShape | undefined {
  return GRAPH_SHAPES.find((s) => s.id === id);
}

/**
 * 渲染成 conductor prompt 的行 (图模式消费面)。
 * lean 档只出 what/when/whenNot/steps —— 强模型自己推得出 why; 弱模型才需要理由压住偏置。
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
  }
  return out;
}
