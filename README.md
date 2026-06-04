<div align="center">

<img src="assets/banner.png" alt="Xihe · 羲和" width="100%" />

# Xihe · 羲和

### The system around the model.

[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![Built on pi](https://img.shields.io/badge/built%20on-pi-6f9488?style=flat-square&labelColor=140f0a)](https://pi.dev)
[![GitHub stars](https://img.shields.io/github/stars/AbyssCN/xihe?style=flat-square&color=c9a227&labelColor=140f0a)](https://github.com/AbyssCN/xihe/stargazers)

**Most agents are a prompt wrapped around one frontier model.**
Xihe makes the opposite bet: reliability lives in the *code around* the model —
gates, validators, deterministic orchestration, a memory that consolidates itself,
a router that learns which model to trust — **not in the prompt.** Give it any LLM,
even a small or cheap one, and the harness makes it behave like a disciplined engineer.

> The model is the engine. Xihe is the chassis.

🌐 **[xihe.dev](https://xihe.dev)**  ·  **English** · [中文](#中文)

[Quickstart](#quick-start) · [What's inside](#whats-inside) · [Meet Wright](#meet-wright) · [Philosophy](#philosophy)

</div>

---

## The bet: reliability from *outside* the model

An LLM alone forgets last session, charges ahead without a plan, trusts its own
formatting, and hands you the average answer. A frontier model papers over this with
raw capability — expensively, and only for that one model.

Xihe treats the model as **leverage** and the harness as the **fulcrum**. Everywhere
an LLM is unreliable, there is code *outside* the model holding the invariant:

- It **can't** write code until the plan is aligned — a read-only gate enforces it, not a polite instruction.
- It **doesn't** trust the model's JSON — it validates in code and retries.
- It **doesn't** hope the model remembers — a memory it consolidates itself does.
- It **doesn't** assume the model picked right — a verifier checks the result and escalates if it failed.

The payoff is **model-agnostic by design**: swap DeepSeek, MiMo, Qwen, Claude — the
reliability comes from the system, so it travels with *you*, not with the model. That is
what lets a weak or cheap model run work you'd normally reserve for a frontier one.

---

## The pain, and what answers it

| Pain | Xihe's answer | Remember |
|---|---|---|
| Agent flows are tangled spaghetti | A **conductor** decomposes intent into a DAG of atomic leaves, each with its own fault boundary | *One leaf, one fault boundary.* |
| Concurrent agents blow the token budget | A **frozen prefix-cache** + high-concurrency backend (DeepSeek 256 / MiMo 8): context is paid once, every leaf inherits it | *Pay the context tax once.* |
| The model picks a weak path and ships it silently | A **cross-model verifier** judges the result; on failure the conductor **silently escalates** to a stronger model and re-plans | *No silent wrong answers.* |
| You hard-code which model does what | A **Q-router bandit** learns, per task type, which model is worth it — from real reward, per deployment | *Stop guessing. Let it learn.* |
| Weak models introduce "line-shift" edit errors | **hashline** edit-level checks + **LSP** live syntax — surgical patches, auto-corrected offsets | *Surgical patches, not rebuilds.* |
| Tools and APIs scattered everywhere | An **MCP router** collapses every server behind one menu; schemas hide behind on-demand lookup | *One contract to serve them all.* |
| The context window is wasted on tool chatter | **Code mode**: the model writes one snippet that chains tools — only the final result returns | *Context is cash. Compress, don't expand.* |

---

## What's inside

### 🧭 Plan mode — deliberate before you act
`shift+tab` drops into a **read-only deliberation cockpit**. Writes are *code-blocked*,
not discouraged — the model can only think, discuss, ingest the links you paste, and
stress-test the plan until it's aligned, then emit an SDD + TDD skeleton. A ledger
re-injects the decisions every turn so it can't quietly drift.
`/grill` adversarial questioning · `/council` multi-perspective synthesis · `/sdd` canonical plan doc.

### ⚡ Code mode — multi-tool work in one round-trip
Instead of N tool calls each round-tripping their results through the context window, the
model writes one snippet that chains tools, loops, and filters — and **only the final
result returns.** The raw intermediate data never touches context.

> Measured on real tasks: **88%** fewer tokens fetching + summarizing 10 sources ·
> **99.5%** analyzing 16 files. Savings scale with how hard you reduce the data.

### 🌿 Leaf fan-out — concurrent execution
A **conductor** decomposes a task into a DAG of executor **leaves**; independent leaves
run **concurrently** (hundreds in flight on a high-concurrency backend). Roles are
decoupled — conductor *plans*, executor *runs*, verifier *checks* — and each role binds to
whatever model fits, swappable from config. Wide over deep: maximize parallel siblings
that share a cached frozen prefix. *Pay the context tax once.*

### 🛡️ Verifier + silent escalation — weak models, safely
A **cross-model skeptic** judges every orchestration: did the result actually satisfy the
task, or is it plausible-but-wrong? When it fails *and* a stronger model is configured, the
conductor **silently escalates** — re-planning with a better brain and the failure reason
in hand. No SOTA key? It degrades gracefully and keeps the cheap model. The economic sweet
spot: **weak model plans, verifier catches, escalate only on failure.**

### 🎯 Q-router — executor selection that learns
Which model should run this leaf? Instead of a hard-coded rule, an **ε-greedy bandit**
learns per task type from real reward (did the verifier pass?), persisted across sessions.
Cold-starts to your static default — **day one behaves exactly like today** — then bends
toward what actually works for *your* workload. No pre-training, no shipped weights.

### 🔮 Council & best-of-N — many minds, then pick
For wide-open decisions, generate N candidates from **diverse personas** (not the same
prompt resampled N times), judge them through multiple lenses, then synthesize the winner
while grafting the runners-up's best ideas. *N tries, one winner. No blind chance.*

### 🧠 A memory that consolidates itself
Runtime signals → a *dream* pass distills them into facts → facts that **recur across
sessions** get promoted from tentative to confident → confident facts ground the agent's
behavior next time. A TTL sweep keeps it bounded. Every write passes safeguards
(namespace validation, reject-by-default) — no domain leakage, no unbounded growth.
*You don't curate memory. Memory curates itself.*

### 🔁 Self-learning flywheel
Five signal producers — getting stuck, tool failures, memory misses, user corrections,
hard-problems-solved — feed the consolidation loop. Patterns that prove out get **mined
into new skills**, proposed for your approval. The harness gets better at *your* work the
more it does it.

### 🔌 MCP router — hundreds of tools, no context tax
Every MCP server collapses behind one router: the menu stays resident, full schemas hide
behind on-demand lookup. **~70%** token reduction on the tool surface; large tool outputs
auto-offload to a searchable sandbox (**~98%** on big blobs). *One contract to serve them all.*

### 📦 Curated skill bundle
Twelve hand-picked skills — session lifecycle, verification, root-cause investigation,
retro, audit, memory recall, council — self-evolving via an eval flywheel and an episodic
miner that drafts new ones from what actually worked.

---

## Method: where the taste lives

Same models, different outcomes. The difference is **method**, made first-class:

- **Falsifiable contracts** — Types + Validation + StateMachine + Given-When-Then. The
  spec is a falsifiable hypothesis; when implementation proves it wrong, the contract
  yields. *Passing acceptance doesn't mean correct — only surviving attempted disproval does.*
- **Thinking modes (M1–M7)** — RCA, first-principles, subtraction, search-first,
  working-backwards, evidence-driven, closed-loop. The right lens for the right problem.
- **Drift detection & rewind** — deviations are detected, classified, and rewound.
  *No silent degradation.*
- **Engineered taste** — unique over mainstream · first-principles over hacks · Nordic
  minimalism over verbose · pay for quality over cut corners. *Less is not a lack. It's a decision.*

---

## Quick start

```bash
bun install

# point it at any supported / OpenAI-compatible backend
export XIHE_RUNTIME_PROVIDER=deepseek
export XIHE_RUNTIME_MODEL=deepseek-v4-pro

bun run wright             # interactive terminal agent
bun run wright -p "..."    # one-shot, non-interactive
```

Requires [Bun](https://bun.sh) ≥ 1.3. Built on the [pi](https://pi.dev) coding-agent runtime.

---

## Meet Wright

<img src="assets/wright.png" alt="Wright — the maker" width="150" align="right" />

**Xihe** is the platform. **Wright** is its first agent — a terminal coding agent. More
agents will live on the same chassis: the plan-before-act discipline, the self-consolidating
memory, the deterministic fan-out, the verifier, and the model-agnostic spine are the
platform, not the agent.

> *Xihe* (羲和) — in Chinese myth, the mother of the ten suns who drives them across the
> sky: one chariot, many lights. A platform, by name. A **wright** is a maker — a
> cartwright, a shipwright, a playwright. The agent that builds.

Coming to the same chassis: **Herald** (campaigns & markets) · **Wayfinder** (adaptive
planning) · **Archivist** (data, docs & APIs with provenance).

---

## Philosophy

> Reliability comes from outside the model, not inside it.
> The model decides; the system keeps it correct.

Xihe is built as a harness that arms a single developer with the leverage of a frontier
model and the discipline of a real engineering system — and the taste to tell the
difference. Put the model inside a reliable system; don't bury reliability inside a prompt.

## License

MIT — see [LICENSE](LICENSE). The code is open; fork it, learn from it, build on it. The
*methodology* that calibrates this harness — the task decompositions, the dead-ends, the
judgment that compounds over time — is what the articles and docs are about.

---
---

<div align="center">

# 中文

### 模型之外的系统。

**大多数 agent，只是一个 prompt 包着一个前沿模型。**
Xihe 押反方向的注：可靠性活在模型**之外的代码**里——闸门、校验器、确定性编排、
自我整理的记忆、学习"该信哪个模型"的路由器，**而不在 prompt 里。** 给它任何 LLM，
哪怕又小又便宜，这套 harness 也能让它表现得像个有纪律的工程师。

> 模型是引擎，Xihe 是底盘。

[English](#xihe--羲和) · **中文**

</div>

---

## 这个赌注：可靠性来自模型*之外*

单独一个 LLM 会忘记上次会话、不规划就开干、迷信自己的格式、给你平庸的平均答案。
前沿模型靠原始能力把这些掩盖过去——昂贵，且只对那一个模型有效。

Xihe 把模型当**杠杆**，把 harness 当**支点**。凡 LLM 不可靠之处，都有模型*之外*的代码守住不变量：

- 计划没对齐前它**不能**写代码——只读闸门强制执行，不是一句客气的提示。
- 它**不**信模型吐的 JSON——代码校验，失败重试。
- 它**不**指望模型记得住——一套自我整理的记忆替它记。
- 它**不**假设模型选对了——一个校验器审结果，失败就升级重做。

回报是**设计上的模型无关**：DeepSeek、MiMo、Qwen、Claude 随意换——可靠性来自系统，
所以它跟着**你**走，而非跟着模型走。这正是让一个弱模型/便宜模型，干你平时只敢交给前沿模型的活。

---

## 痛点，与解法

| 痛点 | Xihe 的解法 | 记忆点 |
|---|---|---|
| Agent 流程是一团纠缠的意大利面 | **conductor** 把意图分解成原子叶子的 DAG，每个叶子有独立的故障边界 | *一叶一故障边界。* |
| 并发 agent 烧爆 token 预算 | **冻结前缀缓存** + 高并发后端（DeepSeek 256 / MiMo 8）：上下文只付一次，所有叶子继承 | *上下文税只交一次。* |
| 模型选了条弱路径还静默交付 | **跨模型校验器**审结果；失败时 conductor **静默升级**到更强模型重新规划 | *不要静默的错答案。* |
| 你把"哪个模型干什么"写死 | **Q-router bandit** 按任务类型从真实回报里学哪个模型划算——每个部署各自演化 | *别猜，让它学。* |
| 弱模型引入"行错位"编辑错误 | **hashline** 编辑级校验 + **LSP** 实时语法——外科式补丁，自动纠偏 | *外科补丁，不是重建。* |
| 工具和 API 散落各处 | **MCP 路由**把每个 server 收敛到一个菜单后面，schema 按需才加载 | *一纸契约，服务所有。* |
| 上下文窗口被工具碎话浪费 | **代码模式**：模型写一段代码链式调工具——只有最终结果回来 | *上下文是现金。压缩，别膨胀。* |

---

## 内有乾坤

### 🧭 计划模式 — 行动前先审议
`shift+tab` 进入**只读审议座舱**。写操作被*代码级阻断*，不是劝阻——模型只能思考、讨论、
吸收你贴进来的链接、把计划压测到对齐，然后产出 SDD + TDD 骨架。一个 ledger 每回合重新
注入决策，让它无法悄悄漂移。
`/grill` 对抗式逼问 · `/council` 多视角综合 · `/sdd` 规范化计划文档。

### ⚡ 代码模式 — 多工具一回合搞定
不再让 N 次工具调用各自把结果绕一圈塞进上下文，模型写一段代码链式调工具、循环、过滤——
**只有最终结果回来。** 原始中间数据永不碰上下文。

> 真实任务实测：抓取+总结 10 个来源**省 88%** token · 分析 16 个文件**省 99.5%**。
> 越是重度规约数据，省得越多。

### 🌿 叶子 fan-out — 并发执行
**conductor** 把任务分解成执行器**叶子**的 DAG；独立叶子**并发跑**（高并发后端可数百同时在飞）。
角色解耦——conductor *规划*、executor *执行*、verifier *校验*——每个角色绑到合适的模型，配置可换。
宽优于深：最大化共享冻结前缀缓存的并行兄弟节点。

### 🛡️ 校验器 + 静默升级 — 让弱模型安全
一个**跨模型怀疑者**审每次编排：结果真满足任务了，还是貌似对实则错？当它判失败*且*配了更强
模型时，conductor **静默升级**——带着失败原因换个更好的脑子重新规划。没配 SOTA key？优雅降级，
继续用便宜模型。经济甜点：**弱模型造图、校验器兜底、失败才升级。**

### 🎯 Q-router — 会学习的执行器选型
这片叶子该用哪个模型？不写死规则，而是一个 **ε-greedy bandit** 按任务类型从真实回报（校验器过没过）
里学，跨 session 持久化。冷启动等同你的静态默认——**第一天的行为和今天一模一样**——然后朝着对
*你的*工作真正有效的方向偏移。无预训练、不 ship 权重。

### 🔮 Council 与 best-of-N — 多个脑子，再择优
面对宽解空间的决策，从**多样 persona** 生成 N 个候选（不是同一 prompt 重采 N 次），多 lens 评判，
再合成冠军、嫁接亚军的亮点。*N 次尝试，一个赢家。绝非盲撞。*

### 🧠 自我整理的记忆
运行时信号 → 一次 *dream* 提炼成事实 → **跨 session 复现**的事实从 tentative 升为 confident →
confident 事实下一次落地为行为。TTL 清扫保持有界。每次写入都过安全闸（命名空间校验、默认拒绝）——
无 domain 泄漏、无无界增长。*你不整理记忆。记忆自己整理自己。*

### 🔁 自学习飞轮
五类信号生产者——卡住、工具失败、记忆未命中、用户纠正、攻克难题——喂给整合回路。被证明有效的模式
被**挖掘成新技能**，提交给你审批。它干你的活越多，就越擅长*你的*活。

### 🔌 MCP 路由 — 数百工具，零上下文税
每个 MCP server 收敛到一个路由后面：菜单常驻，完整 schema 按需才查。工具表面**省约 70%** token；
大工具输出自动卸载到可搜索沙箱（大块数据**约 98%**）。

### 📦 精选技能套件
十二个精挑的技能——会话生命周期、验证、根因调查、复盘、审计、记忆召回、council——经 eval 飞轮 +
情节挖掘器自我进化，从真正有效的东西里起草新技能。

---

## 方法论：品味所在

相同的模型，不同的结果。差别在**方法**，且让它成为一等公民：

- **可证伪契约** — Types + Validation + StateMachine + Given-When-Then。spec 是可证伪的假设；
  当实现暴露它错了，契约让路。*验收通过 ≠ 正确——只有熬过对抗式证伪才算。*
- **思考模式（M1–M7）** — 根因、第一性、减法、搜索优先、逆向、证据驱动、闭环。对的问题用对的镜头。
- **漂移检测与回正** — 偏离被检测、分类、回正。*没有静默退化。*
- **工程品味** — 独特 > 主流 · 第一性 > 技巧 · 北欧极简 > 冗繁 · 为质量付费 > 偷工减料。
  *少不是缺，是一种决定。*

---

## 快速开始

```bash
bun install

# 指向任何受支持 / OpenAI 兼容的后端
export XIHE_RUNTIME_PROVIDER=deepseek
export XIHE_RUNTIME_MODEL=deepseek-v4-pro

bun run wright             # 交互式终端 agent
bun run wright -p "..."    # 单发、非交互
```

需要 [Bun](https://bun.sh) ≥ 1.3。构建于 [pi](https://pi.dev) coding-agent 运行时。

---

## 认识 Wright

**Xihe** 是平台，**Wright** 是它的首个 agent——一个终端编码 agent。更多 agent 会活在同一底盘上：
行动前先规划的纪律、自我整理的记忆、确定性 fan-out、校验器、模型无关的脊柱——这些是平台，不是 agent。

> *羲和* —— 中国神话里十日之母，驾日车巡天：一辆车，众多光。名字即平台。
> 而 **Wright**（匠人）是造物者——车匠、船匠、剧作匠（playwright）。负责"造"的 agent。

即将上同一底盘：**Herald**（活动与市场）· **Wayfinder**（适应式规划）· **Archivist**（可溯源的数据/文档/API）。

---

## 哲学

> 可靠性来自模型之外，不在其内。
> 模型做决定，系统保它正确。

Xihe 是一套 harness——用前沿模型的杠杆 + 真正工程系统的纪律 + 分辨二者的品味，武装单个开发者。
把模型放进可靠的系统里，别把可靠性埋进 prompt。

## 许可

MIT — 见 [LICENSE](LICENSE)。代码开源；fork 它、学它、在它之上构建。真正校准这套 harness 的
*方法论*——任务分解、踩过的坑、随时间复利的判断——才是文章和文档要讲的。
