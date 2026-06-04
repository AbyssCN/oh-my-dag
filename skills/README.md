# wright-skills

wright 开源 curated skill bundle —— 一套经机械排除法选出的 **12 个通用核心技能**,
配一层 sqlite 复利 substrate。装进任意 Claude Code / pi harness 即用。

## 内容

- `skills/` — 12 core skill (每个一目录, 含 `SKILL.md` + 可选 scripts/evals)
- `substrate/schema.sql` — 复利 substrate 表结构 (skills/genes/evolution_events + 桥)
- `substrate/gene-library.json` — 初始修复/优化基因模板
- `umbrella.md` — prompt-level 长尾路由伞 (DMI 隐藏技能的重发现入口)
- `manifest.json` — 机读清单

## Core skills

| skill | 用途 |
|---|---|
| `caveman` | Ultra-compressed communication mode |
| `commit` | 智能 git commit: 分析改动 + zone 检查 (tsc/test/build) + 中文 conventional message + git commit |
| `council` | 多视角并行生成 + 评判择优 (一组专家'开会'审议出冠军): 面对宽解空间的设计/决策, 派 N 个不同 persona+angle 并行出方案 → 多 lens judge → |
| `dream` | 手动触发 xihe Dream consolidation: 把 agent 的 raw events 提炼成 L0-L6 记忆 (经 Memory Restraint 3-gat |
| `handoff` | Session 收尾仪式: 更新 _NEXT |
| `investigate` | 系统化 debug 根因调查: 8 阶段 history search / reproduce / scope lock / pattern match / hypothesis  |
| `recall` | Memory layer 主动召回: 推理/写作/决策卡住时 Wright 主动查 8734 chunks 库, 不靠 hook 触发 |
| `retro` | Engineering retrospective from git history: analyzes commit patterns, type mix (feat/fix/r |
| `review` | 按需审计: 安全 / 覆盖度 / 技术债 / 全量 Gate / PR 代码审查 (派 dream-team specialist + Codex) |
| `skill-creator` | Create new skills, modify and improve existing skills, and measure skill performance |
| `start` | Session 初始化仪式: 并行读 _NEXT |
| `verify` | 统一验证 gate: 按改动文件跑 tsc/test/build |

## 安装

```bash
# 把 skills/ 下各目录拷进你的 ~/.claude/skills/ 或项目 .claude/skills/
cp -r skills/* ~/.claude/skills/
```

substrate (`schema.sql` + `gene-library.json`) 供 wright 风格的 skill 进化/复用飞轮使用,
非必需即可用 —— 纯当 skill 包也成立。

> 生成自 `src/wright/skills/export.ts`。勿手改导出物,改源后重跑导出。
