---
name: sast
description: 确定性 semgrep 静态扫描(SAST)+ 结构化报告。零 LLM 零成本,规则命中即事实。Trigger:/sast、静态扫描、semgrep、扫一下代码。
---

# /sast — semgrep 静态扫描

对应 pi TUI 的 `/sast`。确定性工具,直接 Bash 跑 semgrep(装了才可用;没装提示 `pip install semgrep` 或 brew):

```bash
semgrep scan --config auto --json --quiet <目标路径> 2>/dev/null
```

- 解析 JSON 输出,按严重度分组转述:`file:line` + 规则 id + 一句话问题 + 修复方向;
- 零命中就说零命中,不要脑补;规则误报常见——对高严重度命中读代码确认真实可达再定性;
- 与 /audit 互补:sast 是规则事实(便宜、确定),audit 是语义审查(贵、覆盖设计层)。先 sast 后 audit 是省钱顺序。
