# client-skills — omd 的 runtime 客户端技能包

**背景**:omd 已转为 MCP-first —— pi TUI 退役,runtime TUI 由 **Claude Code / Codex** 担任,经 `omd mcp`(stdio MCP server,13 工具)驱动 omd 的引擎。原先长在 pi TUI 扩展里的斜杠命令,在这里重生为 runtime 客户端的**技能**(Claude Code skills 格式):方法论进技能文本,重活经 MCP 工具落到 omd 引擎。

## 安装

**Claude Code**(用户级,全仓库生效):

```bash
cp -r client-skills/{path,tickets,rule,deliver,execute,iterate,grill,sdd,note,council,audit,sast} ~/.claude/skills/
```

或项目级:拷到目标 repo 的 `.claude/skills/`。装好后在 Claude 里敲 `/path`、`/deliver` 等即触发(新会话生效)。

**Codex**:没有 skills 机制——把需要的 SKILL.md 正文并入目标 repo 的 `AGENTS.md`,或作为 prompt 片段引用。

**MCP server 注册**(前提,cwd 决定作用的仓库):

```bash
cd <目标repo> && claude mcp add omd -- omd mcp        # 全局安装的 omd
# 或源码: claude mcp add omd -- bun run <omd路径>/src/harness/tui.ts mcp
```

## 技能一览(12 个)

| 技能 | 干什么 | 靠什么 |
|---|---|---|
| `/path` | 开/建/列 pathfinder 决策地图 + 开票 + 预取 | MCP `path_map` `path_add` `path_prefetch` |
| `/tickets` | 看前沿 + 拉 AFK 研究回流(预算内自续) | MCP `path_tickets` |
| `/rule` | 裁决前沿票(owner 决策落盘真相文件) | MCP `path_rule` |
| `/deliver` | **权力闸**:执行已散尽区域(编译 slice → DAG 真改文件) | MCP `path_deliver` |
| `/execute` | SDD → conductor 分解 → DAG 执行 → 验收四选一 | MCP `dag_run`/`dag_status`/`dag_result` |
| `/iterate` | fixpoint 迭代:跑→你评→带失败原因重画,≤3 轮 | MCP `dag_run` 三段式 |
| `/grill` | HITL 审问式审议(只讨论不动手,抗中庸,沿决策树走) | 方法论(纯技能) |
| `/sdd` | 审议结晶成 SDD 落盘 `docs/plan/`(/execute 的契约) | 方法论 + 文件 |
| `/note` | 决策/引用记进 `docs/plan/NOTES.md` 台账 | 方法论 + 文件 |
| `/council` | 多视角议会:宽解空间问题并行出方案 + 评审择优 | MCP `dag_research`(council) |
| `/audit` | 多 lens 并行安全审计 → 结构化报告 | MCP `dag_run`(审计 DAG 模板) |
| `/sast` | 确定性 semgrep 静态扫描 | Bash semgrep |

## 原 pi TUI 23 条斜杠命令 → 去向全表

| TUI 命令 | 去向 |
|---|---|
| `/path` `/tickets` `/rule` `/deliver` | → 同名技能(经 `path_*` MCP 工具) |
| `/pathfinder`(shift+tab 模式开关) | **退役** — Claude 没有"模式",`/path` 开图即进入工作流 |
| `/execute` `/iterate` | → 同名技能(经 `dag_*` 三段式) |
| `/grill` `/sdd` `/note` `/council` | → 同名技能 |
| `/crystallize` `/crystals` | **并入 `/sdd`**(结晶落盘 + 列结晶文档) |
| `/ref` | **并入 `/note`**(引用与决策同一台账) |
| `/audit` `/sast` | → 同名技能 |
| `/cg`(codegraph 代码检索) | **退役** — 为弱 runtime 补检索而生;Claude/Codex 原生代码检索更强 |
| `/search` `/web`(搜网/抓页) | **退役** — runtime 原生 web 能力替代;要多源综合研究走 `dag_research` |
| `/config` `/setup`(配置向导) | **退役** — 配置即 `.env`(照 `.env.example`);模型坐标 `OMD_RUNTIME_PROVIDER/MODEL` + 角色覆盖 `OMD_ITER_*` |
| `/mcp`(TUI 内 MCP 路由管理) | **退役** — MCP 管理是 runtime 客户端自己的事(`claude mcp …`) |
| `/cost` | **退役** — 成本随 `dag_result` / research 报告内嵌返回(cost 字段) |

## 核心工作流

### ① pathfinder 循环(大而模糊的多 session 工作)

```
/path <目的地>            开图, 和 owner 把目的地拆成票 (path_add: research/grill/prototype/task + blockedBy)
   │
   ├─ research 票 ── path_prefetch → detached AFK 后台自动跑 → /tickets 拉回流
   │                  结果自动裁决母票 + 孵子票 (## children), 预算内自续 (OMD_PATH_RESEARCH_BUDGET, 默认 12)
   │
   ├─ grill 票 ────── /grill 和 owner 审问对齐 → owner 定夺 → /rule 落盘
   │
   └─ task 票 ─────── owner /rule 逐张裁 (ruling = 将来的执行目标)
                          │
                区域散尽 (全部 task 已裁 + 编译通过) → 只报信
                          │
                owner 显式 /deliver → 编译 slice → DAG 真改文件 → 票翻 delivered → 继续裁下一层
```

裁决即进度:地图真相在 `docs/plan/pathfinder/<slug>.md`(git 追踪、人可编辑),跨 session/跨机可续。

### ② SDD 交接(中大型一次性任务)

```
/grill 审议到方案对齐 → (/note 沿途记决策) → /sdd 结晶成契约 → owner 说"执行" → /execute
  → DAG 跑完 → 你主动验收 (对照 SDD 逐条判): 接受 / 重画(/execute redraw) / 迭代(/iterate) / 直接修
```

### ③ 研究与审查(随取随用)

- 拿不准选哪个 → `/council`;要多源事实 → `dag_research`(检索版);
- 上线前 → `/sast`(便宜确定)+ `/audit`(语义审查),先 sast 后 audit。

## 关键 env 旋钮

| 变量 | 作用 |
|---|---|
| `OMD_RUNTIME_PROVIDER` / `OMD_RUNTIME_MODEL` | runtime 模型坐标(conductor 默认同款,D-8) |
| `OMD_ITER_CONDUCTOR_MODEL` / `OMD_ITER_LEAF_MODEL` / `OMD_ITER_AGENT_MODEL` | 角色覆盖(任何 provider 坐标都行,harness 不 bake 模型) |
| `OMD_PATH_RESEARCH_BUDGET` | pathfinder 自续研究预算(默认 12,按 `.dispatched` 跨 session 计数;手动 prefetch 不受限) |

## 设计不变量(技能作者须知)

1. **裁决权与执行权属于 owner**:技能可以推荐裁决词、报告区域散尽,但 `/rule` `/deliver` 只在 owner 明确表达后调用;
2. **落图 ≠ 激活**:票落图零成本,深度不设限;成本唯一边界是派发预算;
3. **状态全在磁盘**:MCP server 无状态,地图/结果/预算都在 `docs/plan/` 与 `.omd/`,任何客户端可续;
4. **description ≤120 字符**(MCP 工具,D-11)——说明书住技能文本,客户端每轮为工具 description 付税。
