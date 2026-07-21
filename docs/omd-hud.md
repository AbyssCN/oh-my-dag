# omd-hud — DAG / pathfinder 实时 statusLine HUD

把 oh-my-dag 的 DAG 层级图 + pathfinder 战争迷雾做成 Claude Code 底栏 HUD(形态同 claude-hud usage HUD),
在你驱动 `dag_run` / `dag_run_plan` / pathfinder 工具时**实时**看到进度,无需反复调 `dag_status`。

```
⚡ 图C 落地 — ASCII 层级图 · running 2▶ · █████▓▓▓▓▓░░ 2/5
L1 ✔ extract(leaf) ✔ scan(leaf)
L2 ▶ build(agent) ▶ test(command)
L3 ○ assemble(leaf)
▶ build(agent 45s)  test(command 12s)
🧭 MCP-first 重定位 ██████████ 6/6 散雾
```

空闲(无活跃 run)退化成极简一行:`⟨Opus⟩ · xihe · ctx 14% · 5h 2% · $0.02`。

## 架构

```
引擎 onNodeEvent ─┬─→ RunRegistry.applyNodeEvent      (内存, dag_status 用)
                  └─→ HudMirror.write → .omd/hud/dag.json  (原子, fail-open)
pathfinder renderStatus ─→ HudMirror.writeFog → .omd/hud/fog.json

scripts/omd-hud.ts (statusLine)  每 refreshInterval 秒 fork:
   stdin session JSON + 读两个快照 → 纯渲染器 (dag-ascii + fog) → 多行 stdout
```

- **RunRegistry 保持纯内存**(单测零磁盘);HudMirror 是旁挂的磁盘镜像,statusLine 独立进程只读磁盘。
- **观察者不扰动被观察者**:HudMirror 全部 fail-open + 原子写(tmp+rename),写失败只 WARN,永不影响 DAG 执行。
- **落盘位置**与 continuity 同级:`OMD_DATA_HOME` 设 → `~/.omd/projects/<slug>/hud/`;未设(MCP server 经 `.mcp.json` 挂载的常态)→ `<repoRoot>/.omd/hud/`。statusLine 两处都探,取 mtime 最新。

## 新鲜度闸(反 happy-path)

statusLine 每次读 `dag.json` 按 `updatedAt` 分级,避免显示昨天的残影或 server 崩后的假进度:

| 态 | 判据 | 显示 |
|---|---|---|
| live | running/pending 且龄 ≤ 30s | ⚡ 进度条 + 层级图 + running 耗时 |
| stalled | running 且龄 > 30s | ⚠ stalled(server 疑似崩) |
| finished | done/failed 且龄 ≤ 15s | ✔ done / ✘ failed 终态计数,短暂展示 |
| (收起) | done/failed 且龄 > 15s | DAG 段消失,退化空闲行 |

fog 段:`.omd/hud/fog.json` 存在且 total>0 即显(pathfinder 状态独立于 DAG run 持久)。

## 安装 —— opt-in,不劫持

HUD **不强制内置**:仓库里**不**提交任何 `.claude/settings.json`,所以 clone 后**默认不改**你的底栏。
两种方式打开(都只写 **project-local** `.claude/settings.local.json` —— gitignore、per-user、只在本 repo 生效、
**不动**你在别处的全局 claude-hud):

**① 跟 `omd init` 走(推荐)** —— 向导末尾会问一句:

```
装 DAG/pathfinder 实时 HUD 到本仓库 Claude Code 底栏? (仅本 repo · settings.local.json · 不动全局)  [y/N]
```

选 `y` → 自动把 statusLine 写进 `<repoRoot>/.claude/settings.local.json`(非破坏合并,保留你其余 local 设置;
已装则幂等跳过)。之后**用 Claude Code 打开本 repo** 即见。

**② 手动** —— 往 `<repoRoot>/.claude/settings.local.json` 加(命令用绝对路径,不赖 cwd):

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun run /abs/path/to/oh-my-dag/scripts/omd-hud.ts",
    "refreshInterval": 2,
    "padding": 0
  }
}
```

- **`refreshInterval` 必设**:Claude Code 默认只在"新消息/compact/权限变更"时重跑 statusLine。DAG 跑起来时主
  会话在等 MCP 工具=空闲,不设此项则 HUD 不会自动刷新。设 `2`(秒)让活体进度按 2s 节奏刷新;想更跟手改 `1`。
- project 级 `settings.local.json` **覆盖** user 级 `~/.claude/settings.json` —— 所以**在本 repo 内**你看 omd-hud,
  **出了本 repo** 照旧是你的全局 claude-hud。两者各管地盘,不冲突。
- 别的 cloner 不会被波及(该文件不进版本库);想要就各自 `omd init` 开。

## 关色 / 宽度

- `NO_COLOR` 环境变量 → 纯文本(无 ANSI)。
- 每行截到 `$COLUMNS`(Claude Code v2.1.153+ 注入;缺省 80),宽字符(CJK/emoji)按 2 计,超宽末位替 `…`。
