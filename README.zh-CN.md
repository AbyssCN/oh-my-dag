<div align="center">

# oh-my-dag

### 它本身就是一个 agent —— 也是一台谁都能调用的开放执行引擎。

*四个入口:调一个能力、交出一整张图、和 conductor 对话、或者打开 TUI。*

<img src="assets/diagrams/omd-architecture.gif" alt="omd 架构" width="820">

[![MCP server: 50 tools](https://img.shields.io/badge/MCP%20server-50%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/guide/mcp-tools.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](docs/architecture/model-layer.md)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

[English](README.md) · **中文** · **[上手 →](docs/guide/getting-started.md)**

</div>

## 四个入口

一台引擎,四扇门。按"你想一次交出去多少"来挑。

| | |
|---|---|
| **MCP · 组合** | 调一个能力,看一眼结果 —— 让 `judge` 在三份尝试里挑最优、抓一篇文章蒸出洞察、召回上周定过什么。二到五步,你全程在场。 |
| **MCP · 图与目标** | 把整片扇出交出去。`run` 让 conductor 替你分解任务;`solve` 收一个**开放**目标,靠调研逼近它——产出以票回到决策地图,由人裁决。已有结晶好的 SDD?传 `sddPath`:引擎把它直接编译成平铺图——零调研、零铺图税,验收命令是唯一停止规则。十个节点还是一百个,你可以去干别的。 |
| **`conductor_chat`** | 一个常驻的 conductor 会话,走 MCP。问它问题,或者让它在对话中途派图 —— 手机上也行:会话住在服务端,图比连接活得久。 |
| **`omd tui`** *(开发中)* | omd 自己的终端客户端:对话座位 + 座位/模型选择器 + 实时 run 视图。今天能用,还在动 —— 见 [TUI 指南](docs/guide/tui.md)。 |

四扇门落在同一个底座上:带类型的 plan、确定性 pass、oracle 闸、跨家族校验者、节点级
checkpoint、模型池、成本记账。

## 两条泳道,一台引擎

<div align="center">
<img src="assets/diagrams/omd-workflow.svg" alt="omd 工作流:契约线与地图线" width="820">
</div>

**契约线** —— 单任务、单程。先把事实调研清楚,再对抗式审问这个方案直到把待决问题一条条点名,
然后结晶成一份书面契约,最后照着契约执行。执行器读的就是那份契约,它不需要去猜对话里的言外之意。

**地图线** —— 跨多个会话的长程。一张决策地图存在 git 里。模糊的地方变成带类型的票,票被裁决,
散尽的区域被交付,交付完成后把票翻成 `delivered` 回到图上。上下文窗口没有的记性,由这张图来担。

两条线汇流到同一台引擎、同一套闸。它们还汇流到一个刻意设置的瓶颈:**`deliver` 是 owner 亲手扣的
那道扳机。** 一个区域散尽了只会报信,绝不会自己动手写。自动化尽管去调研、抓取、规划、争论 ——
改文件这件事,每一次都由人决定。

## 五个痛点,五个解法

### 1 · "它说做完了,其实没做完。"

任何模型判断之前,先跑一道客观闸:`tsc`、测试套件、扫描器、一个必须真的在盘上的文件。回路里
零模型,所以它没法被说服放行。声称产出文件却盘上没有 = 失败;声称"审过"却根本不存在的截图,
同样是失败。

同一条纪律也用在**判据自己**身上。一条验收命令被采信之前,引擎会在临时世界里跑它两遍:一遍在
**活还没干之前**跑(这时候就绿,说明它跟这次要做的事无关),一遍拿分类器随命令一起交出来的
**一份明显错的产物**跑(照样绿,说明对的答案和错的答案都能满足它)。两种情况都把目标降级为
探索型,而不是收下一个假的通过。真源:`src/harness/goal/acceptance-gate.ts`。

### 2 · "上下文一断,全部重来。"

<div align="center">
<img src="assets/diagrams/omd-run-states.svg" alt="run 状态:排队、运行、checkpoint、续跑、完成" width="700">
</div>

每个跑完的节点都原子地写进磁盘。续跑一个断掉的 run 会重算输入哈希:输入没变的节点保持绿、
不重复计费,只有剩下的重跑。`solve` 加 `detached: true` 把整个环交给一个比你会话活得久的
worker 进程 —— 关掉客户端,图照跑。想留住的事实进事实库,召回走混合两条腿(词法一条 +
确定性哈希向量一条,都零模型),下周的会话查得到,不必重新推一遍。

### 3 · "深调研又贵,还有一半是编的。"

检索有一层确定性的地板。`omd_web` 搜索和抓取**全程不带模型**:原文全量写进磁盘,回来的只有一份
索引。缺口靠**再抓那个缺的来源**补,而不是让模型凭记忆填。模型只管综合,检索交给引擎。

```bash
bun run scripts/dag-research.ts "<你的问题>" --deep
```

同一道题 —— MCP 生态 2026 年中盘点 —— 我们用自己的两套配置各跑了一遍:

| | **omd `--deep`,便宜座位** | **106 个 agent 的强模型 workflow** |
|---|---|---|
| 现金成本 | **$2.19** | 订阅额度 · 3.76M token |
| 产出 | 132k 字终稿 · 32 个来源 | 23 条断言,3 票全票核实 |
| 跑完了吗 | 干净跑到底 | 核实中途撞上额度 |

便宜那套独立复现了强模型那套核实过的 **15 条事实里的 13 条**。不是因为小模型偷偷有强模型的水平,
而是因为决定事实覆盖率的那一环是检索,而检索这一环里根本没有模型。

**→ [深调研指南、座位分配、完整 A/B](docs/guide/deep-research.md)** ·
[样例输出](docs/examples/deep-research-mcp-2026.md)

### 4 · "便宜模型,我不敢用在正事上。"

那就别信它 —— 去核它。计划与执行之间站着四个纯函数(剪掉死节点、按语义指纹归并重复、执行证据闸、
给每个节点钉模型);执行之后是 oracle 闸;再之后是一个**与作者不同模型家族**的校验者 ——
同家族的校验者共享作者的盲点。

再往下,活被路由到 **16 个具名座位**,分四类:decomposer、judge/综合、worker、verify。
auto-assign 按渠道经济学来填:错了代价大而次数少的地方用强的,量大且有 oracle 兜错的地方用便宜的,
家族多样性只花在会改变答案的位置上。任何座位在 `.omd/config.json` 里钉一次,所有 resolver 读的
都是那一个值。登记表:`src/model/seats.ts`。

### 5 · "方法论只活在某一个人的提示词里。"

omd 随包出厂 **20 条方法论 skill** —— 对抗式审查、根因调试、契约结晶、决策地图工作流、只删不加的
过度工程审计等等。它们在 server 首次启动时装进 `~/.claude/skills/`,幂等,并且绝不覆盖你改过的
那一条。

它们不只服务你最上层的 agent。图里的 `agent` leaf 经同一个工具拿到**同一套** skill,所以你写过
一次的方法,不管是你手动唤起,还是某个节点在四十层扇出深处伸手去取,用的都是它。

## Skill umbrella —— 方法论随包出厂

skill 按 umbrella 分组。进你 prompt 的是**清单** —— 组名加一句话说明,不是正文。模型想用某条方法
时调 `read_skill`,当场只取那一条的正文。于是装了一百条 skill 的代价大约是一百行 prompt,不是一百份
文档;而且不管你有三条还是三百条,发现的方式都一样。

扫三个根,项目级在前:`<cwd>/.omd/skills`、包内自带的那套、`~/.claude/skills`。同名时项目级那份赢。

审 diff 用 `/omd-review`,查 bug 用 `/omd-debug`,锁方案先 `/omd-grill` 再 `/omd-contract`,
开图用 `/omd-path` —— **[完整清单与怎么自己写一条 →](docs/guide/skills.md)**

## 能调什么

六类,49 个工具。

| | |
|---|---|
| **EXECUTE 执行** | 跑一张图、给一个目标、续跑断掉的 run、协作式叫停、向跑着的图的 owner 收件箱裁决,或者干脆不建图直接单发一个控制流形状。 |
| **RESEARCH 研究** | 零模型地搜与抓、对你已有的文本跑一个忠实镜头和一个对抗镜头、或者跑完整的多镜头综合加裁判团。 |
| **AUDIT 审查** | 多维度 diff 审查加跨家族证伪、根因调试、只删不加的过度工程审计、架构热点扫描。 |
| **MEMORY 记忆** | 带混合召回的事实库,加一张存在 git 里、用带类型的票推进的决策地图 —— 机器建议的票必须先经确认才能被裁决。 |
| **KNOWLEDGE 知识** | 经验证的图式,每条都带触发条件**和"什么时候别用"**;模板卡在执行期把专家检查单注入节点。 |
| **CONFIG 配置** | 把引擎指向你的模型:密钥、预设、逐座位钉死、注册 provider、自动分派、状态读数。 |

控制流归运行时,永远不归模型:你只挑形状和参数 —— `parallel`、`pipeline`、`loop-until`、
`verify`、`judge`、`discovery`、`iterate`、`tournament`、`router`、`race`、`escalation`、
`saga` —— 循环、分支、停止、打分的逻辑都是引擎的。第 13 个 `escape-hatch` 默认关闭,
除非你设 `OMD_ESCAPE_HATCH=1`。

一条安全提示:无人值守的活、或者要抓公网的活,请用 `branchStrategy: 'branch'` ——
隔离的 git worktree 加 jail,leaf 读不到也写不出那个目录之外。
细节见[引擎文档](docs/architecture/dag-engine.md)。

**→ [完整工具参考](docs/guide/mcp-tools.md)**

## 快速上手

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # 把 `omd` 放上 PATH (Bun ≥ 1.3)
omd init                     # 向导:密钥、模型预设、可达性探测 → .env
```

```bash
cd <你的项目> && claude mcp add omd -- omd mcp
```

然后要么从你的 MCP 客户端驱动它,要么跑 `omd tui` 用 omd 自己的终端座位。
想手工配?在 `.env` 里设 `OMD_RUNTIME_PROVIDER`、`OMD_RUNTIME_MODEL` 和后端密钥
(抄 [.env.example](.env.example))。不想自动装 skill 就设 `OMD_INSTALL_SKILLS=0`。

**→ [完整走查](docs/guide/getting-started.md)** · [命令参考](client-skills/README.md)

## 文档

| | |
|---|---|
| [上手](docs/guide/getting-started.md) | 安装、接客户端、第一次跑 |
| [MCP 工具](docs/guide/mcp-tools.md) | 全部工具,分组,带参数 |
| [模型配置](docs/guide/model-config.md) | 座位、预设、OAuth/订阅后端 |
| [工作流](docs/guide/workflow.md) | 契约线与地图线,从头到尾 |
| [Skills](docs/guide/skills.md) | umbrella 机制、随包出厂的那套、怎么自己写 |
| [深调研](docs/guide/deep-research.md) | 管线、座位分配、A/B 实测 |
| [TUI](docs/guide/tui.md) | omd 自己的终端客户端 *(开发中)* |
| [架构总览](docs/architecture/overview.md) | 各部分怎么拼起来 |
| [DAG 引擎](docs/architecture/dag-engine.md) | 节点种类、pass 管线、调度、隔离、checkpoint |
| [Goal 环](docs/architecture/goal-loop.md) | 规划 → 执行 → 判卷 → 修复,以及四条停止轴 |
| [记忆与 dream](docs/architecture/memory-dream.md) | 事实库、混合召回、归并 |
| [模型层](docs/architecture/model-layer.md) | 座位、池、stamp 规则、推理档 |
| [原语](docs/architecture/primitives.md) | 13 个控制流形状,以及什么时候普通节点更好 |
| [开放生态](docs/architecture/open-ecosystem.md) | 外部 MCP server 与 skill 进 agent leaf |

## 许可

MIT —— 见 [LICENSE](LICENSE)。
</content>
