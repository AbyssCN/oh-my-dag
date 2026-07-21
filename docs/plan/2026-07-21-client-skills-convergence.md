# client-skills 三层收敛方案(omd-* = 唯一用户面)

**日期**:2026-07-21 · **决策人**:Nick · **状态**:✅ 已完成(13 升级 + 2 新增 + omd-grill,共 18 个用户面 skill)

## 背景

omd repo 现有三层 skill,功能重叠(review/council/dream 甚至三份),违反「任何技能不得重复/雷同/混淆」。

- **①`skills/` 通用方法论**(fusang 血统):review, council, dream, investigate, recall, ponytail, verify, commit, handoff, retro, caveman, codebase-design, start, skill-creator, omd(router)
- **②`skills/dag-*` 引擎 CLI**:dag-build/council/deepen/fanout/research/review/slim(跑 `scripts/dag-*.ts`)
- **③`client-skills/omd-*` MCP 封装**(装 omd MCP 时自装进用户机):16 个,封装 omd MCP 工具

**决策**:③ omd-* 是唯一对外用户面。② dag-* 降为引擎内部(不装用户机)。① 通用方法论按需蒸进对应 omd-*。**一个功能一个家。**

## 当前自装什么(空白仓库配 omd MCP 的真实结果)

`claude mcp add omd -- omd mcp` → `omd mcp` 启动 → 自装器(`src/harness/client-skills-install.ts`)把 `client-skills/omd-*` 精确 **16 个**拷进 `~/.claude/skills/`。**只装 ③,不装 skills/ 与 dag-*。** 源在 `client-skills/omd-*/SKILL.md`,装后在 `~/.claude/skills/omd-*/`。

收敛后总数 = 16 现存 + 2 新增(investigate/recall)= **18**。

## A. omd-* 就地升级(11 个,吸收方法论 · canonical)

| omd-* | 吸收源 | 吸收什么 | 边界(仅此) |
|---|---|---|---|
| omd-review | ①review + ②dag-review + fusang xihe-review + **bluebell JUDGMENT §6**(金矿①) | 6 维对抗证伪 · 误报裁决(finding≠真理/看 diff 视野外/oracle 证伪)· 必拒必接清单 · gate ROI 公式 | 对 **diff** 的多维**正确性**审查 |
| omd-audit | ①review(--security lens) | 信任边界清单:验签/认证/注入/fail-open + untrusted 入口 Zod 覆盖 | **安全**审计(非通用正确性) |
| omd-slim | ②dag-slim + fusang **ponytail-review**(金矿②)+ **`scripts/omd-debt.ts` 并入** | **先 debt 后 slim**:Pass0 扫 `ponytail:` 标记出债务台账(已知欠账)→ Pass1 global 过度工程 → Pass2 逐 hunk。一行一 finding tag 格式 + 5 范例 | 精益审计:先记已知债、再找**过度工程**只删不加 |
| omd-council | ①council + ②dag-council(金矿③) | 3-lens 人格表(mvp/risk/first-principles + temp)· diversity>volume · 嫁接亚军 · grounded 接地档四步 | **宽解空间**多方案并行择优 |
| omd-deepen | ②dag-deepen | layer 整删需全系统视角判据 | git 热点**架构加深**(去壳加厚) |
| omd-dream | ①dream | Memory Restraint 3-gate · L3 SoT 永不碰 · <5% 健康比自校验 | 记忆巩固(事件→facts) |
| omd-rule | **bluebell JUDGMENT §1-4**(金矿①) | 真源三层分离 · 灰态三画法(零假数据)· §4 敏感清单 | 裁决 pathfinder 前沿票 |
| omd-deliver | **bluebell JUDGMENT §1-4**(金矿①) | 同上(裁决权/执行权闸判据) | 执行已散尽区域(权力闸) |
| omd-execute | bluebell blueprint-slice §5 | 交叉验证 checklist 当验收(销号✅≠在屏上) | SDD→DAG 执行 + 四选一验收 |
| omd-note | ①handoff(三原则) | reference-don't-duplicate · redact secrets/PII | 决策/引用记台账 |
| omd-sdd | fusang grill-me §4 | 决策记录表→SDD 契约交接格式 | 审议结论结晶落盘 |

## B. 新增 omd-*(2 个真用户面空缺)

| 新 skill | 蒸自 | 边界(与 review/audit 不混) |
|---|---|---|
| omd-investigate | ①investigate(8 阶段) | 某**失败**的**根因**调查(复现→假设→验证),不审 diff、不扫安全 |
| omd-recall | ①recall(封 omd `memory_recall`/`memory_remember` MCP 工具) | 推理卡住时**主动召回**记忆 |

> **omd-debt 不单独设 skill** —— 按 Nick 决策并进 omd-slim(先 debt 后 slim)。`scripts/omd-debt.ts` 脚本保留,omd-slim 复用其 `src/harness/slim/debt-scan.ts` 解析逻辑。

## C. 明确出局(不进用户面,无 omd-*)

- **② dag-* 全部**:降引擎内部/CLI 兜底,不装用户机(build 走 omd-execute、research 走 omd-council 内的 dag_research、fanout 引擎侧留)。
- **① 通用开发仪式**:commit, verify, handoff(note 职能已蒸进 omd-note), retro, start, caveman, codebase-design, skill-creator, omd(router)—— 属独立「oh-my-dag 通用包」,不随 omd MCP 自装。**(§开放问题,不阻塞本批)**

## 待办追踪(TODO)

图例:☐ 未开工 · ◐ 进行中 · ☑ 完成

### 已完成
- ☑ **omd-grill** ← grill-me(一次一问/Facts-Decisions 分道/外部标杆逼问/决策记录表)+ council 岔口组合
- ☑ 三层收敛决策定案(本文档)

### 判定敏感 → Aalto 亲手(6 项)✅ 全完成
- ☑ **omd-rule** ← JUDGMENT §1-4(真源三层分离/灰态三画法/有据偏差/敏感清单)
- ☑ **omd-deliver** ← JUDGMENT §1-4 + §5(权力闸 + delivered✅≠东西真在逐票核对)
- ☑ **omd-review** ← JUDGMENT §6/§6.5 + review(误报裁决/已知误报模式/gate ROI 分档)
- ☑ **omd-council** ← council(3-lens 人格表 + grounded 接地档四步)
- ☑ **omd-slim** ← ponytail-review + debt 并入(先 debt 后 slim,global-first 两遍法)
- ☑ **omd-investigate**(新)← investigate 8 阶段(无根因不修,rcmux 特化已剥离)

### 机械蒸馏 → fleet 并行(7 fork,Aalto 终审边界)✅ 全完成
- ☑ **omd-audit** ← review 安全 lens(8 点信任边界清单)
- ☑ **omd-deepen** ← dag-deepen(浅模块判据 + leverage 排序)
- ☑ **omd-dream** ← dream(节制三闸 + 层级红线 + 健康比自检)
- ☑ **omd-execute** ← blueprint-slice §5(交叉验证 checklist)
- ☑ **omd-note** ← handoff(引用不复制/遮敏感/追加不覆盖)
- ☑ **omd-sdd** ← grill-me §4(决策记录表→SDD 契约交接)
- ☑ **omd-recall**(新)← 封 memory_recall MCP 工具

### 收尾 ✅
- ☑ 跑自装器传播到 `~/.claude/skills/`(18 个源 == 安装,diff 全绿)
- ☑ 校验:name==dir 18/18、交叉引用全指向真实 skill、无 rcmux/xihe/fusang/bluebell 泄漏
- ☑ 更新 `client-skills/README.md` 技能一览(16→18)+ 去向表;package.json client-skills 已在 files

### 不动(已自足)
- omd-sast(确定性 semgrep)· omd-path/tickets/iterate(pathfinder 机制,方法论已够)

## 执行方式(能否丢 /execute 给 DAG?)

**部分能,但不能整批 fire-and-forget。** 原因:skill 是 markdown 方法论文本,**没有 tsc/test 客观 oracle**,「正确性」= 边界不重叠 + 正确适配 omd 生态(不能引用户没有的 rcmux/xihe 工具)+ 文本品味,全靠 taste 判。整批甩 dag_run 会产出风格不一、可能互相重叠的散文 —— 正是「不得重复/雷同/混淆」要防的。

**推荐混合**:
1. **Aalto 先写边界契约**:18 个 skill 的「仅此 / 不用于」一句话,作为 ground truth(防重叠的唯一闸)。
2. **判定敏感 6 项 → Aalto 亲手**(JUDGMENT 三件套 + council + slim + investigate)。
3. **机械 7 项 → 甩 fleet**(`omd-execute`/dag_run 自举 dogfood,或 fusang `xihe-build`),喂边界契约当 ground truth;**每个产出过 Aalto 边界审再落地**,不自动 merge。
4. 每落一个 → 自装器传播 + 交叉引用查重。

## 开放问题(不阻塞本批)

1. 通用开发仪式(commit/verify/caveman/...)是否彻底不进 omd 用户面?倾向:是。
2. ponytail 写时姿态是否要 omd-ponytail?倾向:不要(omd-slim 事后审已覆盖)。
