# FanOutQA —— 换掉手搓探针的公开 benchmark(2026-08-04 选型记录)

> **为什么换**:r2 用的 F2 不是 benchmark,是手搓的 8 题关键词匹配探针。一整天在它上面查出七个缺陷,
> 学到的几乎全是关于**尺子**的事,不是关于引擎的事。在坏尺子上迭代,迭代的是尺子。
> 完整教训见 `docs/knowledge/research/no-graph-baseline-2026-08/REPORT.md` §五之三点五/点六。

## 选型硬要求(先写死判据,再挑)

1. **确定性判分** —— EM/F1/单元测试/程序化校验。**不接受必须 LLM judge 的**(judge 噪声会污染读数)。
2. **样本量 ≥200**,可抽子集跑(预算有限,一次 20–50 题)。
3. **可离线**(我们的引擎跑在本地语料上)或一次性下载后离线。
4. **任务性质吃得到"分解"的红利** —— 多跳 / 多文档 / 需并行检索多源。

## 候选对比(2026-08-04 查证)

| 候选 | 可用题量 | 判分 | 确定性 | 许可 | 离线 | 扇出结构 |
|---|---|---|---|---|---|---|
| **FanOutQA** ← 选它 | dev **310** | loose/strict acc + ROUGE(GPT judge 可选,缺 key 降级为 0) | ✅ | 数据 CC BY-SA 4.0 / 代码 MIT | ✅ wikicache 1.54 GB | ✅✅ **金标 DAG 宽 5.52 / 深 2** |
| 2WikiMultihopQA(`bridge_comparison`) | 2751 | 官方脚本 EM+F1 | ✅ | Apache-2.0 | ✅ 10 段内嵌 | 宽 2 深 2 |
| MuSiQue-Ans | dev 2417 | 官方脚本 F1+EM | ✅ | CC BY 4.0 | ✅ 20 段内嵌 | ❌ 纯链式,无并行宽度 |
| HotpotQA-distractor | dev 7405 | 官方 EM+F1 | ✅ | CC BY-SA 4.0 | ✅ 10 段内嵌 | ❌ 只 2 跳,红利太薄 |
| FRAMES | 824 | **官方就是 LLM autorater** | ❌ | Apache-2.0 | ❌ 只给 URL 不给正文 | ✅ |
| GAIA | validation **165** | quasi-EM | ✅ | HF gated | ❌ 多数题要实时联网 | 混合 |
| BrowseComp / -Plus / AssistantBench | 1266 / 830 / 214 | **LLM judge** | ❌ | MIT | 部分 | ✅ |
| LOFT | 每档 **100**/数据集 | recall@k / subspan_em | ✅ | CC-BY 4.0 | ✅ | ✅ |
| WorFBench(编排专用) | test 2146 | **子序列+子图匹配,无 judge** | ✅ | Apache-2.0 | ✅ | 直接判"图画得对不对" |

## 为什么是 FanOutQA(理由不是名字对得上)

1. **数据里自带人写的金标 DAG**。`decomposition` 每条子问题带 `depends_on` 边。
   **本仓独立复核**(`gold-dag.test.ts` 钉住这些数):宽度 mean **5.52** · median **5** ·
   ≥3 的题 **289/310** · ≥5 的题 **243/310**;深度 297 题为 2、13 题为 1。
   → 既是"分解该赢"的形状,又给了一个**可对照的人写基线图**:
   我们能量「引擎自己拆的图 vs 人拆的图」,**不需要语料、不需要 judge、不需要跑答案**。
2. **判分点密度解掉 n 小的死穴**。答案类型:dict **274** / str 13 / list 12 / int 10 / bool 1;
   dict 平均 **5.45 键**,每键独立判定 → **抽 40 题 ≈ 218 个独立判分点**
   (对照:F2 跑三对只有 24 个)。这是本仓复核出来的数,不是引用。
3. **判分不需要 judge**:缺 `FANOUTQA_OPENAI_API_KEY` 时 gptscore 降级为 0,
   loose/strict accuracy 与 ROUGE 照常算。
4. **自带 contamination 对照臂**:closed-book 档就是记忆探针(同题 closed-book 高而
   evidence-provided 不涨 = 背下来了)。语料 epoch 钉在 **2023-11-20**。

### 已知的坑(写在前面)

- **test 集答案扣留**(本仓已核:724 题无 `answer` 字段)→ 可用池就是 dev 310。
- **evidence-provided 档单题 ~172k token / 7 篇文档** → 它会把「上下文塞不塞得下」与
  「有没有分解」绑成同一个变量。**主实验建议走 open-book**(两臂同工具),把这个混淆挡在门外。
  官网确认 open-book 的工具面是 `wiki_search()` + `wiki_content()` —— **两臂必须挂同一对工具**,
  否则量到的是工具差异不是编排差异(本仓 r2 已经在"agent 有工具能自救"上栽过一次)。
- **判分必须调官方 Python 实现**(`normalize` 用 spaCy 词形还原 + ftfy)。
  **不要用 TS 近似重写** —— 那就是"自己造一把没人用过的尺子",与排行榜数字不可比。

## 实验形状建议:**宽度梯度**,不是单点

单点"DAG 赢了"很难说服人;「**收益随扇出宽度单调上升**」是完全不同量级的证据,
而且三档的判分尺各自独立、不会互相背书:

| 档 | 数据 | 扇出宽度 |
|---|---|---|
| 窄 | 2Wiki `comparison` | 2 |
| 中 | 2Wiki `bridge_comparison` | 2 宽 × 2 深 |
| 宽 | FanOutQA | 5.52 |

## 必须知道的既有对照组

**arXiv 2604.02460**《Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning
Under Equal Thinking Token Budgets》—— 跑的正是 FRAMES + MuSiQue(4-hop),结论是等 token 预算下
单 agent 持平或胜出。**但它附录 G 自承预算控制有 artifact**:单 agent 的可见 thinking 远没跑满
请求预算,而多 agent 在同样请求下吐出更多。
→ 它既是我们的基线,也是一个**可证伪的靶子**:把预算按**实际计费 token** 而非请求参数配平,
读数会不会翻,本身就是个该写死判据的实验。**这条同时是纪律**:我们自己配平也必须按实际计费。

## contamination

- 通用工具 **infini-gram mini**(`api.infini-gram-mini.io`,已索引 83 TB 开放语料,
  含 benchmark contamination bulletin;已公布例:GSM8K 污染率 74.2%)。抽样题可直接打 API 查命中。
- FanOutQA 自带 closed-book 档作内建记忆探针(见上)。
- ⚠ MuSiQue 官方 README 明写:它由 SQuAD / T-REx / NQ / MLQA / Zero Shot RE 的单跳题组合而成,
  **其单跳子问题可能出现在这些种子集的训练集里** —— 用它必须写进方法说明。

## 数据与许可

- `data/fanout-final-dev.json`(310 题,含答案与金标分解)· `data/fanout-final-test.json`(724 题,无答案)
- 来源 https://github.com/zhudotexe/fanoutqa —— **数据 CC BY-SA 4.0**,代码 MIT。
  按 CC BY-SA 署名:Zhu et al., *FanOutQA: A Multi-Hop, Multi-Document Question Answering
  Benchmark for Large Language Models*, ACL 2024(arXiv 2402.14116)。衍生数据同样以 CC BY-SA 4.0 分享。
- 离线语料(需要跑答案时才要,1.54 GB):
  `curl -L https://datasets.mechanus.zhu.codes/fanoutqa/wikicache.tar.gz | tar -xz -C ~/.cache/fanoutqa/`
- 官方判分:`pip install "fanoutqa[all]"`,`fanoutqa.eval.evaluate(questions, answers)`。
