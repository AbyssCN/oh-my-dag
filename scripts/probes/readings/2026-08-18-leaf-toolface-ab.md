# 叶子工具面 A/B —— 生产全面 vs 极简(bash + hashline 对)

**问题**:DeepSeek harness 的极简档只给 bash + edit,pi 只给 read/write/edit/bash。
omd 的 agent 叶子挂 11 个工具,固定面 1,920 token,占一次 M3 叶子调用中位(3,356)的 57%。
砍得动吗?

**四要素(2026-08-18 点火前写死,事后不改)**

| 要素 | 内容 |
|---|---|
| 单一变量 | 只动工具面。座位、题面、`hashlineEdit: true`、超时、隔离世界构造全部不动。两臂都经 `--profile` 走同一条装配路(不是一臂带档案一臂不带),差别只有档案里的 `tools` 数组 |
| 成败信号 | **可以砍** = 极简臂通过率相对全面臂跌幅 ≤ 1 题(4 题盘子)且 `tokensIn` 中位降 ≥ 25%;**砍不得** = 通过率跌 ≥ 2 题,或极简臂出现全面臂没有的失败形态(改了受保护文件 / 判分命令跑不起来) |
| 对照基线 | 同一天、同一批 4 道题、**同一座位内**比全面臂与极简臂。不拿历史读数当基线 |
| 两个座位各跑一遍 | owner 2026-08-18:生产 worker 是 `minimax-cn:MiniMax-M3`,`deepseek:deepseek-v4-pro` 又强又贵,结论要落在 M3 上。于是同一组题跑两遍:v4-pro 一遍(先起跑的)、M3 一遍。**跨座位不是对照,是两条独立的对照** —— 每个座位内部才有"全面 vs 极简"这一个变量 |
| 收哪些数 | 每题每臂:`verdict` · `tokensIn` / `tokensOut` · `toolCalls` · `wallMs` · 判分命令 exit · 是否碰受保护路径。另加一列**碰撞台账行数**(`.omd/touch.db`)——极简臂预期归零,那是"闸失明"这个代价的量化 |

**两侧都记**:不塌 = 叶子工具面可以极简的证据;塌 = bash 替代不了结构化工具的证据。两者都写进本文件。

## 固定面基线(确定性测量,非模型跑)

| 臂 | 工具 | schema tok | systemPrompt tok | 固定面 |
|---|---|---|---|---|
| 全面 | read 137 · write 91 · ls 80 · grep 215 · bash 106 · hashline_read 171 · hashline_edit 175 · mcp_find 119 · mcp_call 133 · read_skill 121 · omd_inspect 115 | 1,463 | 457 | **1,920** |
| 极简 | bash 106 · hashline_read 171 · hashline_edit 175 | 452 | 295 | **747** |

差额 **1,173 token/次派活**。

⚠ 极简臂留 hashline 对而不是 `edit`:生产装配是 `hashlineEdit: true`(`src/mcp/assemble.ts:370`),
`edit` 被排除、改文件走 hashline。若极简臂换成 `edit`,就同时动了工具数与改文件机制 —— 两个变量。

## 读数(2026-08-18 18:07–18:32,15 跑)

| 座位 | 题 | 臂 | 判 | tokensIn | tokensOut | 工具调用 | 墙钟s | 碰保护 |
|---|---|---|---|---|---|---|---|---|
| deepseek:deepseek-v4-pro | 6e2159b1-conductor-plan | full | pass | 2,800,492 | 33,945 | 56 | 563 | 0 |
| deepseek:deepseek-v4-pro | 6e2159b1-conductor-plan | min | pass | 1,098,391 | 15,480 | 38 | 241 | 0 |
| minimax-cn:MiniMax-M3 | 0a426641-blocking-forks | full | pass | 677,446 | 19,565 | 27 | 187 | 0 |
| minimax-cn:MiniMax-M3 | 0a426641-blocking-forks | full | pass | 1,141,792 | 15,529 | 33 | 720 | 0 |
| minimax-cn:MiniMax-M3 | 0a426641-blocking-forks | min | pass | 259,829 | 19,987 | 19 | 200 | 0 |
| minimax-cn:MiniMax-M3 | 6e2159b1-conductor-plan | full | pass | 956,170 | 19,037 | 32 | 636 | 0 |
| minimax-cn:MiniMax-M3 | 6e2159b1-conductor-plan | min | pass | 592,108 | 15,771 | 21 | 303 | 0 |
| minimax-cn:MiniMax-M3 | abb9b6c9-blocking-forks | full | pass | 371,257 | 14,461 | 19 | 276 | 0 |
| minimax-cn:MiniMax-M3 | abb9b6c9-blocking-forks | full | pass | 258,996 | 7,819 | 16 | 150 | 0 |
| minimax-cn:MiniMax-M3 | abb9b6c9-blocking-forks | min | pass | 482,142 | 21,662 | 21 | 162 | 0 |
| minimax-cn:MiniMax-M3 | abb9b6c9-blocking-forks | min | pass | 309,309 | 13,846 | 20 | 157 | 0 |
| minimax-cn:MiniMax-M3 | dc46c885-list-loop-journals | full | pass | 180,066 | 4,576 | 12 | 103 | 0 |
| minimax-cn:MiniMax-M3 | dc46c885-list-loop-journals | full | pass | 202,147 | 3,348 | 13 | 61 | 0 |
| minimax-cn:MiniMax-M3 | dc46c885-list-loop-journals | min | pass | 707,417 | 13,969 | 30 | 221 | 0 |
| minimax-cn:MiniMax-M3 | dc46c885-list-loop-journals | min | pass | 398,464 | 7,503 | 21 | 121 | 0 |

- **deepseek:deepseek-v4-pro** — full: n=1 pass=1 tokensIn 中位 2,800,492 工具调用中位 56.0 · min: n=1 pass=1 tokensIn 中位 1,098,391 工具调用中位 38.0
- **minimax-cn:MiniMax-M3** — full: n=7 pass=7 tokensIn 中位 371,257 工具调用中位 19.0 · min: n=6 pass=6 tokensIn 中位 440,303 工具调用中位 21.0

### 判词

**M3(生产 worker):砍工具面没有省钱的证据,反而更贵。** 六个同题配对里四个极简臂更贵,
最大 3.9×(`dc46c885` 180,066 → 707,417)。工具调用中位 19 → 21 同向:工具少了它就用更多轮
bash 兜同一件事,而每一轮都重发上下文 —— 省下的 1,173 token 固定面被轮数吃回去还倒亏。
**成败信号未达成**(要求 tokensIn 中位降 ≥25%,实测反升 19%),按点火前写死的判据:M3 保持全工具面。

**v4-pro:极简臂便宜 61%**(2,800,492 → 1,098,391,工具调用 56 → 38,两臂都 pass)。
⚠ **n=1**,不满足"同条件重复"的分量。

**通过率两侧都没跌**:15 跑 15 pass,零跑碰受保护文件。所以"砍不得"的那条信号(能力受损)
没有出现 —— 出问题的只有省钱那条。

**方差与效应同量级,这是本次读数最该记住的一件事。** 同题同臂同座位跑两次:
`dc46c885` 极简臂 707,417 vs 398,464(1.8×)· `abb9b6c9` 全面臂 371,257 vs 258,996(1.4×)·
`0a426641` 全面臂 677,446 vs 1,141,792(1.7×)。n=1 的格子读不出方向 —— 同 `e801c50`
那次"量出单臂方差后推翻自己一小时前结论"的形状。

### owner 裁决(2026-08-18)

**M3 保持全工具面;`deepseek-v4-pro` 用极简面;其余模型一律全工具面。** 不加密测量。

落地:`DEFAULT_MINIMAL_TOOLFACE_SEATS = ['deepseek-v4-pro']`(`src/harness/agent-leaf.ts`),
按 `modelId` 匹配不看 provider;显式 `profile.tools` / `opts.tools` 永远压过它。
三条闸在 `agent-leaf-sdk.test.ts`(缩面 / 显式优先 / 名单写的是 modelId 不是全坐标),
前两条已当场证伪过一次。

### 干扰项,照实记

- 第一遍没钉座位,跑到一半 `.omd/config.json` 的 `models.agent` 被并行 session 从
  `deepseek-v4-pro` 改回 M3 —— 18:07/18:11 两跑是 v4-pro,18:12 起同一遍变成 M3。
  所以读数按每跑打印的 `seat` 归类,不按"遍"。`--seat` 是为此加的。
- 两遍并行跑 + 主树另有一个 session 在干活 → **墙钟不可比**,tokensIn / toolCalls / 判分不受影响。
- 最后一对(`0a426641` 钉座 M3 极简臂)在 owner 叫停时未跑完,那一格空着。
