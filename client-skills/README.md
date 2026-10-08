# client-skills — omd 的 runtime 客户端技能包

**背景**:omd 已转为 MCP-first —— pi TUI 退役,runtime TUI 由 **Claude Code / Codex** 担任,经 `omd mcp`(stdio MCP server,19 工具)驱动 omd 的引擎。原先长在 pi TUI 扩展里的斜杠命令,在这里重生为 runtime 客户端的**技能**(Claude Code skills 格式):方法论进技能文本,重活经 MCP 工具落到 omd 引擎。

## 安装

**Claude Code**:**无需手动拷贝**。注册 omd MCP 后,`omd mcp` server 首次启动时自动把本目录下的 12 个技能
幂等铺进用户级 `~/.claude/skills/`,新会话即得 `/grill`、`/omd-council` 等。自装幂等、随包升级更新,
**从不覆盖你改过的技能或第三方同名技能**(按内容 hash 判定,用户动过即跳过);包里删掉或改名的技能,
上次由自装写入且你没改过的那份会被清掉。关掉自装:环境变量 `OMD_INSTALL_SKILLS=0`。
机制在 `src/harness/client-skills-install.ts`。

```bash
cd <目标repo> && claude mcp add omd -- omd mcp        # 全局安装的 omd; 首次起 server 即自装技能
# 或源码: claude mcp add omd -- bun run <omd路径>/src/harness/cli.ts mcp
```

**Codex**:没有 skills 机制——把需要的 SKILL.md 正文并入目标 repo 的 `AGENTS.md`,或作为 prompt 片段引用。

## 技能一览(12 个)

> 这张表**必须与本目录 `ls` 逐个对上**(`src/harness/client-skills-manifest.test.ts` 守)——
> 表里有而目录没有 = 用户装了却拿不到,目录有而表里没有 = 出厂了没人知道。
> 带 `omd-` 前缀的只调 omd 保留的服务;不带前缀的与 omd 无关(纯方法论或本地工具)。

| 技能 | 干什么 | 靠什么 |
|---|---|---|
| `/omd-council` | 多视角议会 + 3-lens 人格 + 领域岔口接地档(反 happy-path) | MCP `dag_research`(council) |
| `/omd-research-deep` | 终极档:种子作者化多角度抓 + council + 多轮缺口补挖 | MCP `dag_research`(`super` + `rounds`) |
| `/omd-review` | 对抗式 diff 审查 + 误报裁决程序 + gate ROI 分档 | MCP `dag_review`(三段式) |
| `/omd-recall` | 推理卡住时主动召回既有记忆(语义+词法混合检索) | MCP `memory_recall` |
| `/omd-video` | 视频→逐段结构化笔记(原生吃画面+音频),产 ALL-NOTES.md 交综合 | 自带 `run.py` |
| `/grill` | 对抗式审问(一次一问/外部标杆逼问)+ 宽解岔口开 council | 方法论(纯技能) |
| `/contract` | 审议结晶成 SDD 落盘(承 /grill 决策记录表) | 方法论 + 文件 |
| `/note` | 决策/引用记 NOTES.md 台账(引用不复制/遮敏感/追加) | 方法论 + 文件 |
| `/investigate` | 系统化根因调试 8 阶段(无根因不修)+ 修完扫同类 | 方法论(纯技能) |
| `/retro` | 一批 omd-lite run 合并后复盘:确定性汇总 → 重复模式分流成闸 / 审查标准 / 任务书模板 → 提案交 owner;gc 预览清 worktree | Bash `omd-lite retro` / `omd-lite gc` |
| `/sast` | 确定性 semgrep 静态扫描 | Bash semgrep |
| `/ui-reviewer` | 看渲染截图判 UI(层级/间距/可读性/状态/一致性/slop) | 纯方法论,无 MCP 依赖 |

### 已退役(2026-10-08 瘦身,见 `docs/plan/2026-10-08-omd-slimdown-architecture.md` §3)

| 名字 | 去向 |
|---|---|
| omd-execute · omd-iterate · omd-resume | conductor 删除;执行交 Opus 子 agent 或 `omd-lite run` |
| omd-path · omd-tickets · omd-rule · omd-deliver · omd-docs-drift | pathfinder(`map_*`)删除 |
| omd-audit | 用 `/security-review` + `/sast` |
| omd-slim · omd-deepen · omd-debug | 用 `ponytail-review` / `ponytail-debt` · `codebase-design` · `/investigate` |
| omd-grill · omd-contract · omd-note · omd-retro · omd-sast · omd-ui-reviewer · omd-investigate | 去前缀更名(见上表) |

## 工作流

- **SDD 交接**:`/grill` 审议到方案确认一致 →(`/note` 沿途记决策)→ `/contract` 结晶成契约 → 交 Opus 子 agent 或 `omd-lite run` 执行 → 对照契约逐条验收。
- **研究与审查**:拿不准选哪个 → `/omd-council`;要多源事实 → `dag_research`;上线前 → `/sast`(便宜确定)+ `/security-review`(语义审查);审一批 diff → `/omd-review`。

## 设计不变量(技能作者须知)

1. **状态全在磁盘**:MCP server 无状态,结果都在 `docs/plan/` 与 `.omd/`,任何客户端可续;
2. **description ≤120 字符**(MCP 工具,D-11)——说明书住技能文本,客户端每轮为工具 description 付税;
3. **frontmatter `name` 等于目录名**——Claude Code 按 `name` 注册斜杠命令。
