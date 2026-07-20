---
name: deepen
description: 架构加深扫描:经 omd dag_deepen 按 git 热点找代码库 deepening 机会(去壳加厚/收敛浅模块),产 HTML 报告。Trigger:/deepen、架构加深扫描、热点扫描、找浅模块、deepening。
---

# /deepen — 架构加深扫描

对应 omd 车队的 `dag-deepen`。经 omd MCP 的 `dag_deepen`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_deepen")按 git 提交历史算代码热点目录,对每个热点派加深分析:识别浅模块(接口比实现贵)、壳层、被重复复制的逻辑,给出 deepening(加厚模块/收敛复杂度)机会清单。

## 用法

参数都可省:

- `commits`: 回看多少条 git 历史算热点(默认 200);热点太旧时加大。
- `hotspots`: 扫描的热点目录个数(默认 6);想扫更广加大,想快减小。

## 流程(异步三段式)

1. `dag_deepen(commits?, hotspots?)` → 拿 `runId`(近 N commit 无代码触碰会报错 → 加大 `commits` 重试);
2. `dag_status(runId)` 轮询,别重复发起;
3. `dag_result(runId)` 取 **HTML 报告落盘路径** → 把路径交给 owner;需要转述要点就自己 `Read`。

## 转述纪律

deepening 建议是架构级判断,按"机会大小 × 热点温度"排序讲,不替 owner 拍板改哪个;涉及具体模块动手前先 /grill 或 /sdd 把方案钉死。
