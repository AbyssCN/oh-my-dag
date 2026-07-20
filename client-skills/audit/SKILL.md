---
name: audit
description: 多 lens 并行安全审计:经 omd dag_run 派多视角安全审查 DAG,产结构化报告。Trigger:/audit、安全审计、查漏洞、security review。
---

# /audit — 多 lens 安全审计

对应 pi TUI 的 `/audit`。经 omd MCP 的 `dag_run`(未加载先 ToolSearch "dag_run")派一张多视角安全审计 DAG。

## 用法

`dag_run` 的 task 按此模板(按目标裁剪 lens):

```
对 <目标路径/模块> 做多视角安全审计, 每个视角一个并行节点, 最后一个节点汇总去重成结构化报告:
- 注入面: 命令/SQL/路径拼接, 未净化的外部输入 (含 shell 字符串拼接)
- 凭证与秘密: 硬编码 key/token, 日志泄漏, 不安全存储
- 权限与边界: 越权访问, 缺失的鉴权/校验闸, 不安全默认值
- 供应链与依赖: 危险依赖用法, 反序列化, 不安全临时文件
汇总节点输出: 按严重度排序的 findings (file:line + 攻击场景 + 修复建议)。
```

三段式:拿 `runId` → `dag_status` 轮询 → `dag_result` 取报告。转述时按严重度先讲 top findings,并主动对可疑项做二次人工确认(读代码证实攻击路径)再定性——DAG 产出是候选,你负责终审。

确定性静态扫描(semgrep)走 /sast,两者互补:audit 是语义审查,sast 是规则扫描。
