<div align="center">

# oh-my-dag

### DAG 执行引擎 + 持久决策地图 + 自整理记忆 —— 经 MCP 服务你的 coding agent。

*你的 agent 继续当脑子。omd 提供便宜的并发双手。*

[![MCP server: 30 tools](https://img.shields.io/badge/MCP%20server-30%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/mcp-tools.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](docs/model-layer.md)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

[English](README.md) · **中文** · **[上手 →](docs/MCP-ONBOARDING.md)**

</div>

<img src="docs/assets/engine-architecture.svg" alt="omd 引擎架构:计划期、执行期、反馈期与模型层" width="100%">

## 这是什么

你的 coding agent 是一个强而贵的脑子。让它逐字敲文件、逐条跑测试,是把屋里最聪明的东西
用在了最不该用的地方。

**omd 把一个任务变成一张小活的图**,在你自带的便宜模型上并发跑完,用客观闸和一个**来自
不同模型家族**的怀疑者检查结果,只在真正需要判断的地方花前沿模型的钱。它以 `omd mcp`
挂进任意客户端 —— 一个 stdio MCP server,30 个工具。

一套引擎,三件事:

- **DAG 执行** —— 任务变成带类型的节点:真能写文件的 `agent` 叶、零 LLM 跑 `tsc`/测试的
  `command` 叶、运行时才展开的 `map` 节点、管控制流的 `primitive` 节点。节点在自己的依赖
  就绪那一刻就跑;每个节点都有 checkpoint,断掉的 run 是续跑不是重来。
- **Pathfinder** —— 给一个 session 装不下的活做规划:一张进 git 的决策地图,用带类型的票
  推进,后台调研在你关掉客户端之后继续跑,交付闸只有你能扣。
- **自整理记忆** —— 每个项目一个事实库,语义 + 词法混合召回 + 时序知识图,把原始 session
  事件折叠成分层事实。

## 快速上手

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # 把 `omd` 放上 PATH (Bun ≥ 1.3)
omd init                     # 向导:密钥、模型预设、可达性探测 → .env
```

```bash
cd <你的项目> && claude mcp add omd -- omd mcp
```

斜杠命令包(`/omd-path`、`/omd-review` 等 20 个 skill)在 server 首次启动时**自动装**进
`~/.claude/skills/` —— 幂等,且**绝不覆盖你改过的 skill**。`OMD_INSTALL_SKILLS=0` 可关。

**→ [完整走查](docs/MCP-ONBOARDING.md)** · [命令参考](client-skills/README.md)

<details>
<summary>另一个入口:自带的终端 agent</summary>

`bun run omd`(交互)或 `bun run omd -p "..."`(一次性);在 `.env` 里配
`OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + 后端密钥(抄 [.env.example](.env.example))。
MCP server 是正门,这个是顺手。

</details>

## 一屏看完引擎

一个任务由 LLM **规划一次**,然后交给**纯函数**变换,再按依赖顺序执行。conductor 之后
的一切都是确定性的。

**节点种类** —— 一个节点可以是什么:

| 种类 | 有模型? | 有工具? | 用于 |
|---|---|---|---|
| `leaf` | 单发一次 | 无 | 生成、研究、判断、起草 |
| `agent` | 有 | read/edit/write/bash,关在 bwrap jail 里 | **唯一能写文件的种类** |
| `command` | **无** | 白名单内的 CLI | 闸(`tsc`/测试)、扫描器、索引查询 |
| `map` | 混合 | — | 运行时扇出:lister 跑出工作清单,每个元素一个子节点 |
| `primitive` | 混合 | — | 12 种由引擎持有的控制流形状 |

**Plan pass** —— 计划与执行之间的纯函数:
`prune`(剪死节点)→ `dedup`(语义指纹归并)→ `evidence`(UI 像素证据链闸)→
`stamp`(给每个节点钉模型)。

**控制流原语** —— 你只挑形状和参数;循环 / 分支 / 停止 / 打分的逻辑归运行时,永远不归模型:
`parallel` · `pipeline` · `loop-until` · `verify` · `judge` · `discovery` · `iterate` ·
`tournament` · `router` · `race` · `escalation` · `saga`。

**→ 细节:** [架构](docs/architecture.md) · [原语](docs/primitives.md) ·
[模型层](docs/model-layer.md) · [MCP 工具](docs/mcp-tools.md) · [记忆](docs/memory.md)

## 为什么值得接进来

| | |
|---|---|
| **便宜的并发** | 靠宽度,不靠更大的模型。一打小模型叶子并行跑,价格约等于一次前沿调用。 |
| **前沿判、车队干** | 钱花在决策点和 verify 上,不是花在每个节点上。 |
| **不丢状态** | 每个节点的输出都按输入哈希落 checkpoint。429、崩溃、合上电脑 —— 从第一个没跑完的节点接着来。 |
| **跨 session 的记忆** | 决策与坑活过上下文窗口,召回只要一次调用。 |
| **任意客户端、任意模型** | 进来是 MCP,出去是 OpenAI 兼容后端。无绑定。 |

## 设计准则

- **契约优先于散文。** 每个接缝都是带类型的 schema;校验不过的 plan 根本不会跑。
- **可靠性不来自模型。** 闸、校验者、确定性 pass 都活在模型之外 —— 模型更强只会让它们更
  便宜,不会让它们冗余。
- **边界 fail closed,记账 fail open。** 未知的卡名直接拒 plan;checkpoint 写不下去只 warn。
- **不许静默成功。** 声称产出文件却盘上没有 = 失败,不是可以信任的自述。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
