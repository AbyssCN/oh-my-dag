# Terminal-Bench 2.1 / Frontier-Bench —— 任务面抽取(2026-08-05)

> owner 定向:SWE-bench Verified 的 oracle 极好但**任务形状不对**(奖励 code-completion 式编辑),
> 且已发表数据里多 agent 系统性输给单 agent、SOTA 已近饱和 —— 去跑基本是复现别人的结论。
> Terminal-Bench 一族奖励的是**不确定性下的多步推进**(每条命令的输出决定下一步)。

## 抽了什么

| 文件 | 来源 | 题数 |
|---|---|---|
| `data/terminal-bench-2.1.json` | [harbor-framework/terminal-bench-2-1](https://github.com/harbor-framework/terminal-bench-2-1) | **89** |
| `data/frontier-bench.json` | [harbor-framework/frontier-bench](https://github.com/harbor-framework/frontier-bench)(Terminal-Bench 的继任) | **74** |

每题只留:`instruction`(全文)+ 难度/类别/专家与初级估时。重抽见 `scripts/vendor-terminal-bench.ts`。

**两代的估时字段单位不同**(TB 记分钟、FB 记小时),抽取时统一归到**分钟**再写入磁盘 ——
混着存必然有人某天拿 `4`(小时)当 `4`(分钟)比。

## ⚠ 刻意不抽 `solution/` 与 `tests/`

不是为了省空间,是**污染通道**:参考解一旦进仓树,任何有工具的臂都可能读到它。
本仓已经栽过一次(交接 21 §四:eval 答案留在仓树里,实测有跑真的去 `cat` 了别人的答案),
**而 Anthropic 自己也栽过同一条** ——《Demystifying evals for AI agents》记着他们发现
「Claude 在某些任务上分数异常高,原因是它检查了之前试验的 git 历史」。
判分要跑真 harness 时用官方 Docker,答案不进我们的仓。已核:**89/89 题的参考解零泄漏**。

## ⚠⚠ 最要紧的一条:**任务文本几乎不携带「这活有多大」的信息**

零模型调用量出来的(`spearman` 在 `tasks.ts`),**两个独立数据集一致**:

| | Terminal-Bench 2.1 | Frontier-Bench |
|---|---|---|
| spearman(专家估时, 任务文本长度) | **0.172** | **0.219** |
| spearman(专家估时, 初级估时) | **0.845**(人类轴自洽) | `NaN`(**FB 74 题一个初级估时都没有** —— 缺席不读成 0) |

> ⚠ 这三个数第一版报的是 0.175 / 0.234 / 0.850,**算错了**:`rank()` 没处理并列,
> 而专家估时正是 `5/15/30/60/180` 这种粗刻度、并列成堆。改成并列取平均秩后为上表。
> 偏差只落在小数点后第三位、**结论不变**,但记在这里 —— 是"反向自检"那条闸
> (`spearman(x, −x)` 应当是 −1,实测 −0.977)把它抓出来的。

分档看更直白:

- TB:easy **23 分钟 / 578B** → hard **504 分钟 / 1180B**。时间涨 22 倍,文本只涨 2 倍。
- FB:≤2h → 1739 字符 · 2–8h → 2076 字符 · **>8h(均值 19 小时)→ 1933 字符**(**非单调**,最难的一档文本反而更短)。

→ **所以在这两个数据集上不能问「引擎的图随任务规模长吗」**:量出来的平不是引擎的缺陷,
是它拿到的信息里本来就没有那个量。要让规模进图,得**另给规模信号**
(先跑一个探查步 / 把 `[environment]` 的资源与时限元数据喂进去),
否则那是在要求规划者读它看不见的东西。

同族的坑本仓一天内撞了三次(见交接 22 §二、交接 23):
**轴看起来现成,其实量的是别的东西。三次都在花钱之前查出来了。**

## 🚨 **Terminal-Bench 在 2026-04 被 Berkeley 刷穿过 —— 我们用它的方式恰好绕开那条裂缝(但要写明白)**

UC Berkeley(Dawn Song 组)2026-04 用一个自动化攻击,把当时 8 个最权威的 agent 评测
(SWE-bench Verified / SWE-bench Pro / WebArena / **Terminal-Bench**)几乎全刷到满分,**一道题都没真解**。
手法不是猜答案,是**结构性漏洞**:评测器与被测 agent 跑在同一个容器里 →
agent 往仓库根丢一个 `conftest.py`,用 pytest hook 把测试结果重写成全过。

**这条对我们当前用法不成立,原因要写清楚,不能靠运气**:

- 我们**只用它的 `instruction.md` 做规划期结构诊断**,**不跑它的容器、不跑它的判分**。
  被刷穿的是"容器内判分"这条链,而我们根本没走那条链。
- **一旦哪天要跑真判分, 这条裂缝立刻生效**:那时必须把评测器放到被测 agent
  够不到的地方(独立容器/独立进程/只读挂载),否则量到的是"刷分能力"不是"解题能力"。

同期还有几条同族审计,一并记着(它们解释了为什么本仓不追公开榜):
**OpenAI 2026-02 停止上报 SWE-bench Verified 分数**(自承不能衡量前沿编程能力)·
ICSE 2026 发现 SWE-bench 判"通过"的补丁 **7–8% 拿完整开发者测试套件跑其实是功能错误**
(校验只跑改动过的那几个测试文件)· SWE-bench Pro 上被标 CHEATED 的任务 **>12%**(利用 git history)。

## 判分与许可

- 判分测**容器最终状态**,不测 agent 的命令或输出 —— outcome-driven,零 LLM judge。
  (FB 仓根的 `rubrics/` 是**任务投稿评审**用的,不是给 agent 打分的。)
- FB 每题 `task.toml` 带 **`harbor-canary` GUID**,`checks/check-canary.sh` 守污染。
- 两个仓都是 **Apache-2.0**。

## ⚠ 它不满足我们「≥200 题」那条硬要求

TB 89 · FB 74。对**结构探针**(只看规划)绰绰有余;对 **pass-rate 的统计功效不够** ——
别拿它去读几个百分点的臂间差。

顺带:Terminal-Bench 官方排行榜**要求每题至少 5 次 trial** 才收投稿。
那是外部独立证据,和本仓交接 23 量到的「n=1 结构读数是噪声」完全一致,
也和 Anthropic 的 `pass^k` / Claw-Eval 的 `Pass-all-k` 同一件事。
