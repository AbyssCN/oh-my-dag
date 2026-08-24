| `worktrees-archive.md` *(私有台账, 不在公开仓)* |# docs/ 索引
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |这份目录分三区,区分的是**读者**而不是主题:
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |- **[`guide/`](guide/) 使用向** —— 写给要用 omd 的人。装了就该能读懂,不需要知道任何历史。
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |- **[`architecture/`](architecture/) 技术向** —— 写给想知道这台引擎为什么这么造的人。
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |  每篇都在回答一个"为什么是这个形状",不是 API 清单。
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |- **内部台账** —— 写给维护这台引擎的人。记的是决策、读数、失败案例;引用一个当时存在、
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |  今天已删的文件是正常的,别拿它当使用文档读。
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |新来的从 [`guide/getting-started.md`](guide/getting-started.md) 开始;想知道一个任务怎么变成
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |一张完成的图,读 [`architecture/overview.md`](architecture/overview.md)。
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |---
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |## `guide/` —— 使用向
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || 文档 | 一句话 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* ||---|---|
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/getting-started.md`](guide/getting-started.md) | 把 omd 接进你的 MCP 客户端(Claude Code / Codex / 任意 MCP):装、配、跑通第一张图 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/workflow.md`](guide/workflow.md) | 日常怎么用:从一句任务到一张跑完的图,各入口分别在什么时候用 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/skills.md`](guide/skills.md) | 客户端 skill 包(`/execute` · `/review` · `/council` …):每个命令包了哪个 MCP 工具、加了什么纪律 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/mcp-tools.md`](guide/mcp-tools.md) | 全部 MCP 工具的原始 API 参考,按族分组;三层命名(`map_*` ⊃ `solve` ⊃ `run`)的含义在开头 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/model-config.md`](guide/model-config.md) | 模型配置的唯一入口 —— 每个座位怎么改,渠道经济学按什么分派 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/deep-research.md`](guide/deep-research.md) | 深度调研管线的用法:一条命令跑完种子抓取、分解、多轮补挖 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`guide/tui.md`](guide/tui.md) | 交互式终端前端的用法与键位(**开发中**,界面与命令面仍在快速变化) |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |## `architecture/` —— 技术向
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || 文档 | 一句话 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* ||---|---|
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/overview.md`](architecture/overview.md) | 系统形状一句话版 + 四个入口 + 各子篇导航 + "可靠性在模型之外、创造力在模型之内"这条设计原则 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/dag-engine.md`](architecture/dag-engine.md) | 引擎本体:节点七种、四道纯函数 pass、就绪集调度、故障边界、checkpoint 与续跑、plan 字段面 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/goal-loop.md`](architecture/goal-loop.md) | `solve` 的外层序列:分类、冻结的验收判据、会重画的内层循环、四条停机轴、脱离会话的后台跑 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/model-layer.md`](architecture/model-layer.md) | 一个模型怎么落到某个节点上:座位、池、渠道、stamp 三条规则、推理档 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/primitives.md`](architecture/primitives.md) | 控制流原语 —— 图之外那些可单独调用的能力单元,以及什么时候普通节点更合适 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/open-ecosystem.md`](architecture/open-ecosystem.md) | 开放生态:第三方 MCP server 与 skills 怎么进 agent leaf,policy 闸管什么 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/omd-hud.md`](architecture/omd-hud.md) | DAG / pathfinder 的实时 statusLine HUD —— 开关与显示项 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`architecture/memory-dream.md`](architecture/memory-dream.md) | 记忆层:事实怎么写入、怎么召回,以及 dream 那条路为什么被搁置 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`diagrams/`](diagrams/) | 四张核心 Mermaid 图的**真源**(引擎流转 · 双轨 · 能力地图 · 模型层),含 rationale 与 changelog |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |## 内部台账
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || 位置 | 一句话 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* ||---|---|
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`plan/`](plan/) | SDD 与执行契约 —— 每次动工前结晶的方案,含判据表与决策记录。改动的真源在这里 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`handoff/`](handoff/) | 逐程交接记录:上一程干到哪、下一程从哪接 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`notes/`](notes/) | 零散工作笔记,还没成形到进 `plan/` 的东西 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`knowledge/`](knowledge/) | 调研积累下来的知识条目,按主题与日期归档 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`reference/`](reference/) | 外部参考资料:agentic graph、harness 工程、loop 工程、基准与 runtime host 的一手材料 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`bars/`](bars/) | 横向对标台账 —— 对 pi、opencode、hermes 等同类系统逐模块的读数与打分 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`adr/`](adr/) | 架构决策记录,当前三条全是**已搁置**的方向(runtime port · 自演化 · dream),记的是为什么不做 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`design/`](design/) | 设计稿(HTML),TUI 与 pathfinder 界面的多方案对比 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`security/`](security/) | 安全面材料,当前是爆炸半径分析 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`examples/`](examples/) | 可照抄的配置样例:Claude Code 的 `CLAUDE.md` 与 hooks、深度调研样例 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* || [`silent-failures.md`](silent-failures.md) | **静默失效图鉴** —— 每条都是真出过事、且当时没有任何红灯的形态,附代价与抓法 |
| `worktrees-archive.md` *(私有台账,不在公开仓)* | 已清理的 `.claude/worktrees/` 存档记录,逐个核实过内容是否已在 main 上 |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |---
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |## 文档漂移闸
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |`bun run scripts/docs-drift-check.ts` 检查这五件事,任一不过 exit 1:
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |1. **锚点存在** —— 两份 README 与 `guide/` · `architecture/` · `diagrams/` 各文档里反引号包的
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |   `src/...` / `scripts/...` 路径,盘上必须真有
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |2. **工具数一致** —— 仓根 README 徽章上的 MCP 工具数与实际注册面相符
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |3. **mermaid 健全** —— 围栏闭合、`subgraph`/`end` 配平、`class` 引用的 `classDef` 已定义(轻量 lint,非完整 parse)
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |4. **双语结构** —— 两份 README 的二级标题数量一致(标题文本是翻译,不要求相同)
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |5. **引用可达** —— 仓内图片与仓内 `.md` 链接按所在文档的目录解析后必须存在;死链与坏图都算漂移
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |扫描面:`README.md` · `README.zh-CN.md` · `docs/` 顶层 · `docs/guide/` · `docs/architecture/` ·
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |`docs/diagrams/`。台账区(`plan/` · `handoff/` · `notes/` 等子目录)**不在扫描面内** ——
| `worktrees-archive.md` *(私有台账, 不在公开仓)* |那里引用已删文件是正确的。
