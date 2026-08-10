# docs/ 索引

这份目录分两区,区分的是**读者**而不是主题:

- **使用指南** —— 写给要用 omd 的人。装了就该能读懂,不需要知道任何历史。
- **内部台账** —— 写给维护这台引擎的人。记的是决策、读数、失败案例;引用一个当时存在、
  今天已删的文件是正常的,别拿它当使用文档读。

新来的从 [`MCP-ONBOARDING.md`](MCP-ONBOARDING.md) 开始;想知道一个任务怎么变成一张完成的图,
读 [`architecture.md`](architecture.md)。

---

## 使用指南

| 文档 | 一句话 |
|---|---|
| [`MCP-ONBOARDING.md`](MCP-ONBOARDING.md) | 把 omd 接进你的 MCP 客户端(Claude Code / Codex / 任意 MCP):装、配、跑通第一张图 |
| [`architecture.md`](architecture.md) | 引擎全貌 —— 一个任务如何经指挥、分解、并发扇出、跨模型校验,变成一张完成的图 |
| [`mcp-tools.md`](mcp-tools.md) | 全部 MCP 工具的原始 API 参考,按族分组;三层命名(`map_*` ⊃ `solve` ⊃ `run`)的含义在开头 |
| [`primitives.md`](primitives.md) | 控制流原语 —— 图之外那些可单独调用的能力单元 |
| [`model-layer.md`](model-layer.md) | 模型层:一个模型如何落到某个节点上,座位与档位怎么解析 |
| [`model-config.md`](model-config.md) | 模型配置的唯一入口 —— 每个座位怎么改,渠道经济学按什么分派 |
| [`memory.md`](memory.md) | 记忆层:事实怎么写入、怎么召回,以及哪些机制已经移除和为什么 |
| [`deep-research.md`](deep-research.md) | 深度调研管线的用法:一条命令跑完种子抓取、分解、多轮补挖 |
| [`tui.md`](tui.md) | 交互式终端前端的用法与键位 |
| [`open-ecosystem.md`](open-ecosystem.md) | 开放生态:第三方模型提供方、客户端与扩展点怎么接 |
| [`omd-hud.md`](omd-hud.md) | DAG / pathfinder 的实时 statusLine HUD —— 开关与显示项 |
| [`diagrams/`](diagrams/) | 四张核心 Mermaid 图的**真源**(引擎流转 · 双轨 · 能力地图 · 模型层),含 rationale 与 changelog |

## 内部台账

| 位置 | 一句话 |
|---|---|
| [`plan/`](plan/) | SDD 与执行契约 —— 每次动工前结晶的方案,含判据表与决策记录。改动的真源在这里 |
| [`handoff/`](handoff/) | 逐程交接记录:上一程干到哪、下一程从哪接 |
| [`session/`](session/) | 当前会话的续接文件(`_NEXT.md`),自动生成,不手写 |
| [`notes/`](notes/) | 零散工作笔记,还没成形到进 `plan/` 的东西 |
| [`knowledge/`](knowledge/) | 调研沉积下来的知识条目,按主题与日期归档 |
| [`reference/`](reference/) | 外部参考资料:agentic graph、harness 工程、loop 工程、基准与 runtime host 的一手材料 |
| [`bars/`](bars/) | 横向对标台账 —— 对 pi、opencode、hermes 等同类系统逐模块的读数与打分 |
| [`adr/`](adr/) | 架构决策记录,当前三条全是**已搁置**的方向(runtime port · 自演化 · dream),记的是为什么不做 |
| [`design/`](design/) | 设计稿(HTML),TUI 与 pathfinder 界面的多方案对比 |
| [`articles/`](articles/) | 成文的长篇文章,面向外部读者讲 harness 工程 |
| [`security/`](security/) | 安全面材料,当前是爆炸半径分析 |
| [`examples/`](examples/) | 可照抄的配置样例:Claude Code 的 `CLAUDE.md` 与 hooks、深度调研样例 |
| [`silent-failures.md`](silent-failures.md) | **静默失效图鉴** —— 每条都是真出过事、且当时没有任何红灯的形态,附代价与抓法 |
| [`worktrees-archive.md`](worktrees-archive.md) | 已清理的 `.claude/worktrees/` 存档记录,逐个核实过内容是否已在 main 上 |

---

## 文档漂移闸

`bun run scripts/docs-drift-check.ts` 检查这四件事,任一不过 exit 1:

1. **锚点存在** —— 上面两份 README 与本区各文档里反引号包的 `src/...` / `scripts/...` 路径,盘上必须真有
2. **工具数一致** —— 仓根 README 徽章上的 MCP 工具数与实际注册面相符
3. **mermaid 健全** —— 围栏闭合、`subgraph`/`end` 配平、`class` 引用的 `classDef` 已定义(轻量 lint,非完整 parse)
4. **双语结构** —— 两份 README 的二级标题数量一致(标题文本是翻译,不要求相同)

台账区(`plan/` · `handoff/` · `notes/` 等子目录)**不在扫描面内** —— 那里引用已删文件是正确的。
