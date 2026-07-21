---
name: omd-audit
description: 安全专项审计:经 omd dag_run 派多视角安全审查 DAG,按信任边界清单扫注入/认证/fail-open + untrusted 入口校验覆盖率,产按严重度排序的结构化报告。Trigger:/omd-audit、安全审计、查漏洞、信任边界、security review。
---

# /omd-audit — 安全专项审计

经 omd MCP 的 `dag_run`(未加载先 ToolSearch "dag_run")派一张**多视角安全审查** DAG:每个信任边界维度一个并行节点,末节点汇总去重成按严重度排序的报告。**只查安全**,通用正确性走 `/omd-review`,规则扫描走 `/omd-sast`。

## 用法

`dag_run` 的 task 按此模板(按目标裁剪维度),优先扫外部输入入口:`路由/接口层`、`回调/webhook`、`消息入口`、`SQL/schema`。

```
对 <目标路径/模块> 做安全审计, 每维度一个并行节点, 末节点汇总去重成结构化报告。
按下方「信任边界清单」逐条查, 每 finding: file:line + 攻击场景 + 严重度(P0/P1/P2) + 修复建议。
```

三段式:拿 `runId` → `dag_status` 轮询(别重复发起)→ `dag_result` 取报告。DAG 产出是**候选**,你负责终审:对每个可疑项读代码证实攻击路径可达,再定性——证不出可达的降级或剔除。

## 信任边界清单(逐条查)

- **验签**:HMAC / 签名校验用**恒时比较**(`timingSafeEqual`),不是 `===`(防时序侧信道);签名缺失即拒。
- **认证 gap**:每个改状态的入口有鉴权闸;`GET` 只读、不改状态;无「存在性泄露」(用返回码/时延区分资源存不存在)。
- **注入**:命令 / SQL / 路径 由外部输入拼接 → 参数化或净化;禁裸 shell 字符串拼接;SQL 用绑定参数不用字符串拼。
- **fail-open**:`catch { return null }` / 吞错后继续 = 校验失败却放行。审所有 catch:失败必须**拒绝**(fail-closed),不是静默通过。
- **不安全默认值**:默认开放 / 默认信任 / 默认 admin;开关缺省应最小权限。
- **秘密与泄漏**:硬编码 key/token、日志打印凭证或 PII、不安全存储。
- **越权与隔离**:行级/租户隔离默认 deny;缺失的所有权校验(改别人的资源)。
- **反序列化 / 供应链**:不可信数据反序列化、危险依赖用法、不安全临时文件。

## untrusted 入口校验覆盖率

单列一个节点扫所有**接受外部输入的入口**(路由 body / 回调 / 消息):

- **PROTECTED** = 入口处有结构化 schema 校验(如 `safeParse`);**UNPROTECTED** = 收外部输入却无校验。
- 输出:覆盖率表 + 未保护入口清单 + 每个建议的 schema 形状。
- 注:过严的格式约束(如强制 UUID)可能误伤合法输入,建议 schema 时按真实数据形状放宽。

## 与既有 skill 的边界

- `/omd-audit` = **安全**专项(信任边界/注入/认证/fail-open/越权)。
- 通用正确性 / bug / contract 审查 → `/omd-review`;确定性 semgrep 规则扫描(零 LLM,便宜)→ `/omd-sast`,可先 sast 后 audit;某次失败的根因 → `/omd-investigate`。
- 审出的高危项定型后 → `/omd-note` 记录或开 pathfinder 票 `path_add` 排修。
