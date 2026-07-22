---
name: omd-deliver
description: 执行 omd pathfinder 已散尽区域(编译 slice → 跑 DAG 真改文件 → 票翻 delivered),标 delivered 前逐票核对真身(delivered✅≠东西真在)。deliberate/build 的权力闸,仅 owner 明令。Trigger:/omd-deliver、交付、开始执行、动手吧。
---

# /omd-deliver — 显式交付闸

调 omd MCP `path_deliver`(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_deliver")。多图带 `slug`。

## 这是权力闸,不是普通命令

- **只有 owner 明令**("交付"、"执行吧"、"/omd-deliver")才调。区域散尽的报信**不构成执行授权**。
- **闸不上云**:deliver 永远在本地由 owner 扣扳机执行,**永不由 GitHub issue 事件触发**;云端(金丝雀 / Actions)只碰 research 派发,绝不碰交付。gh 后端也一样——改文件的活不上 CI。
- 调用前向 owner 确认交付范围:哪些 ruled task 票、各票 ruling 即节点目标。
- 工具行为:零 LLM 编译 slice(票→DAG 节点,blockedBy→依赖边)→ 跑 executor DAG(agent 叶子带工具**真改文件**)→ **全节点 done 才把票翻 delivered**;有节点失败则不标记、报错、可修复重试。
- 跑几分钟是预期(真 DAG 跑模型),别中途放弃重调。
- 报"未配 leaf 模型" → 让用户设 `OMD_ITER_LEAF_MODEL`(或 `OMD_RUNTIME_PROVIDER`/`OMD_RUNTIME_MODEL`),任何 provider 都行。

## 交付后验收:delivered ✅ ≠ 东西真在(承终裁手册交叉验证)

工具把票翻 delivered 只代表"节点跑完",不代表你要的东西真落到位。转述前逐票核对真身:

- **契约 vs 真身**:票说建了端点/函数,去代码里核实真存在(不是只看契约镜像/声明)。
- **复用既有必须验对象**:ruling 写"复用 X" → 去 X 真身里逐元素核对确实包含,别整屏扫一眼就签。
- **存储形回归钉**:新读面要有断言存储形字段的测试,防 seed 与读法用同一错误形状躲过 oracle。
- **重放幂等**:涉及造数时,重放整个 seed 计数应归零/跳过;"新建 N"出现在重放输出 = 幂等撒谎,查库确认行数。

核对后:转述执行摘要 + 建议 owner review git diff,再继续裁下一层前沿。

## 与既有 skill 的边界
- omd-deliver = **pathfinder 增量交付**(裁完的散尽区域)。把已有 **SDD/plan** 整体交 DAG 执行 + 四选一验收 → /omd-execute。
- 只**裁决**不执行 → /omd-rule(deliver 的前置闸)。
