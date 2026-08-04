# omd-bench —— 用本仓自己的真 bug 当考题(2026-08-05,owner 定向)

> 判据与全部拒题理由的**真源在代码**:`task.ts`(纯判据 + 顶注里的出处)、`task.test.ts`(每格反向自检)、
> `scripts/omd-bench.ts`(起隔离世界、跑命令)。本文只写**为什么这么设计**与**loop 怎么转**。

## 为什么不追公开榜

2026 上半年公开 agent 评测集体塌方,不是一条而是一串:

- **OpenAI 2026-02 停止上报 SWE-bench Verified 分数**,自承它不能衡量前沿编程能力;
- **UC Berkeley(Dawn Song 组)2026-04**:一个自动化攻击把当时 8 个最权威的评测
  (SWE-bench Verified / Pro、WebArena、**Terminal-Bench**)几乎全刷到满分,**一道题都没真解** ——
  靠的是**评测器与被测 agent 同容器**,agent 往仓库根丢 `conftest.py`,用 pytest hook 把判分改成全过;
- **ICSE 2026**:SWE-bench 判「通过」的补丁 **7–8%** 拿完整开发者测试套件跑其实是功能错误
  (它只跑被改动过的那几个测试文件);
- SWE-bench Pro 被标 CHEATED 的任务 **>12%**(利用 git history);METR:很多能过 SWE-bench 的 PR 过不了真人 review。

**我们要的不是排名,是「这个编排在我们这个仓、这个具体缺陷上,是真修好了还是装作修好了」。**
而本仓自己的 commit **天然在任何模型训练 cutoff 之后**,是干净、未泄露的考题。

## 一道题从哪来:**一个 fix commit 本身就是一道考题**

本仓惯例是「实装与测试同一次改动一起提交」,于是对任一这样的 commit `C`(父 `P`):

```
世界 RED   = P 的实现 + C 的测试  → 必须失败
世界 GREEN = C 的实现 + C 的测试  → 必须通过
```

**素材是先验证过才设计的**(反 happy-path):近 600 个 commit 里 264 个同时改了实现与测试,
79 个 subject 是修复,58 个是「1 实现 + 1 测试」的干净形状。

## validation contract —— **四条**,任一不成立当场拒

前三条承 IssueBenchKit(MIT,`he-yufeng/IssueBenchKit`)那份「诚实合约」;**第四条是我们加的**:

1. **打补丁前 FAIL** —— 测试真盯着这个缺陷,不是永远绿的摆设;
2. **打补丁后 PASS**;
3. **前后同一条命令** —— 排除「换条更宽松的命令放它过去」;
4. ⚠ **RED 必须是「断言失败」,不是「加载失败」**。

### 第四条是跑出真读数之后补的,而它一个人拒掉了 89% 的候选

第一版合约只看退出码,当场收了 4 道「合格」题。抽查 RED 的输出,发现是:

```
# Unhandled error between tests
SyntaxError: Export named 'judgeScaleInvariance' not found in module 'plan-shape.ts'.
 0 pass · 1 fail · 1 error
```

**退出码确实非 0,但测试压根没跑起来。** 它只证明了「那时候还没这个符号」,
**完全没证明「这测试抓得住这个缺陷」** —— 典型来源是拿**新增功能**的 commit 当题。
这与 SWE-bench 那 7–8% 虚高是同一个机制。

补上第四条后重抽:**36 个候选,拒 32,收 4(拒绝率 89%)**。
→ **若按第一版交付,题库里 89% 会是假题。** 这个数本身比题库更值钱,记在这里。

`error` 与 `fail` 是两件事,靠解析 runner 摘要区分(`parseBunTestSummary`);
**解析不出来时 fail-closed 不收**(证不出是真失败就别收,题库宁缺毋滥)。

## 判分:测结果,不测路径

三个独立来源都说「别给路径打分」——Anthropic《Demystifying evals for AI agents》
「评估结果而非路径…Agent 经常找到设计者没预料到的有效方法」;Claw-Eval「承认一题多解」;
AWS EvalAgent 的「计划与代码脱节」同族。所以:

| 层 | 内容 |
|---|---|
| **主判据** | 任务命令退出码(二值、确定性、零 judge) |
| **防作弊闸** | 受保护测试路径**逐字节未变**;改了 → `invalid`(**不是 fail**) |
| **回归闸** | 全量 `bun test` 不许变红(修 A 坏 B 不算修好);**没跑记 `null` 不记通过** |
| **代价指标**(不判对错) | token / 墙钟 / 工具调用次数 / 轮数 |

`invalid` **不进 pass 率的分母**,单独报 —— 把作弊跑记成失败,作弊率就消失在通过率里了。

## 指标:`pass@k` 与 `pass^k` 都报,**gap 才是读数**

gap 大 = 靠运气(有时对但路径不稳);gap 小 = 决策路径稳定收敛。
承 Anthropic 的 `pass^k` 与 Claw-Eval 的 `Pass-all-k`;本仓交接 23 也独立撞到同一件事
(同题重复三次,一半会换结论)。**k=1 的读数不许用来比较两臂。**

## 隔离:堵住了哪条,没堵住哪条(照实写)

每次试跑起一个**独立 git worktree**(Anthropic:每次 trial 从干净环境开始;
他们实测过 Claude 靠读上一次 trial 的 git 历史拿分)。

- ✅ 堵住「候选偷改测试」:判分前逐字节核对受保护路径。
- ❌ **没堵住「agent 主动攻击评测器」**:worktree 与判分进程仍在同一台机器、同一文件系统。
  要防那条,得把评测器放到被测方够不着的地方 —— **那是另一条正交防线,现在没有,别声称有。**

## 用法

```bash
bun run scripts/omd-bench.ts extract --limit 400 --max 6   # 扫历史挑候选, 逐个证合约, 合格的才落盘
bun run scripts/omd-bench.ts list                          # 列题库
bun run scripts/omd-bench.ts validate                      # 题库体检(合约重证), 红了非 0 退出 → 可当 CI 闸
```

## loop:这套 bench 怎么持续迭代

**它是会自己长的** —— 本仓每修一个真 bug,就自动多一道干净考题,且永远在训练 cutoff 之后。

| 触发 | 动作 | 判据 |
|---|---|---|
| **每次引擎改动** | `omd-bench validate` | 合约仍成立(题库没被环境漂坏) |
| **每积累若干 commit** | `omd-bench extract` | 新题必须过四条合约才进库;**拒了什么要留证** |
| **每次要比两臂** | A=omd DAG · B=单 agent,**同模型同工具面** | `pass^k`(k≥3)+ cost-accuracy 二维;**配平按实际计费 token,不按请求参数** |

### 三条**还没做**的,别当已经有了

1. **过触发探针(negative task)** —— Anthropic 明说问题集必须平衡:只测「该改的时候改」
   会养出一个「什么都改」的 agent。需要一批「看起来像 bug、其实代码是对的」的题,
   正确行为是**不改**并说明。他们自己在这个平衡上迭代了好几轮。**当前题库全是正例,这是已知缺口。**
2. **capability → regression 的流转**:新题先进 capability(低通过率),通过率高了升级进 regression(≈100%)。
   现在只有一个池。
3. **两臂真跑**:主判据与闸都在了,但还没烧过一次模型。跑之前先定预算配平口径。
