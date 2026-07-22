# SDD: pathfinder 决策层上 GitHub Issues(gh 后端 + 云端 AFK)

> 2026-07-22 · owner 已裁方向,本文是执行契约。原型致意 mattpocock/skills wayfinder。
> 分层一句话:**决策层 = Issues(或 md fallback)· 计算层 = dag 引擎(本地/云双执行位)· 结晶层 = git · 权力层 = 本地 owner**。

## 0. 会话级已裁(不再讨论)

- 票据生命周期迁 GitHub Issues;`docs/plan/pathfinder/*.md` 现格式**降级为 fallback 后端**,不废弃、不迁移旧图。
- 结晶(slice/SDD/代码)单向进 git,编译时一次转换,永不回写 Issues。map issue 只 gist + 链接(wayfinder 铁律:票即真相,map 只索引)。
- AFK research 上 GitHub Actions(真增量:合盖研究照跑);`path_deliver` 权力闸**永不上云、永不由 issue 事件触发**。
- 仓库 AbyssCN/oh-my-dag 保持 public(owner 裁);云端专用 keyset `omd-actions` 已配好(repo secrets: DEEPSEEK_API_KEY / TAVILY_API_KEY,Tavily 300 credit 月配额墙)。
- Sub-issue = 归属血缘(map→票→children,嵌套);Blocked-by = 前沿边(DAG 依赖)。前沿 = open ∧ 无 blocked ∧ 未裁。

## 1. 决策记录(grill 产物)

| # | 裁决 | 防的失控 |
|---|---|---|
| D-A | 后端抽象在 **map-store 层出操作级 BackendPort**,MCP 工具层零 if/else | 工具层分叉 → 两后端行为漂移 |
| D-B | gh 一律 **shell out `gh` CLI + `--json`**;探测不到 gh → md 后端 | 自造 REST 客户端 = 认证/重试/企业域全自扛 |
| D-C | 前沿以 **GitHub blocked-by 为准**;`frontier.ts` 纯函数保留给 md 后端。**D-C.1(S1 终裁)**:blockedBy 真相 S1 期 = issue 正文尾行 `Blocked-by: #N, #M`(确定性/读写对称/可 fixture 测试);原生 issue-dependencies 待 S4 金丝雀对真 gh 探测可用后**单向切换**,永不双源并存 | 双算对账永远对不平;赌 preview API 则测试与真实行为脱钩 |
| D-D | gh 后端 **ticket id 直接用 issue number(`#N` 形式存字符串)**,无内部映射表 | 双 id 映射 = 漂移之源 |
| D-E | 后端不可达 → **fail-loud**,绝不静默降级切后端 | 静默切换 = 双写地狱入口 |
| D-F | research workflow 做成 oh-my-dag 的 **reusable workflow**,caller pin `@v1` | 逻辑散落各仓库改不动;中心挂了最坏 = 研究停,不碰各仓 CI |
| D-G | **map issue 即命名空间**,多图并存不加 label 后缀 | label 组合爆炸 |
| D-H | 旧 md 图**不迁移**,自然终老 | 迁移器无底洞 |
| D-I | init 金丝雀 = **workflow_dispatch 干跑**(假结果验证管道),零 API 成本 | 管道验证被研究质量/成本绑架 |
| D-J | `## children` 展开与预算记账(`.dispatched`)**留本地**,两后端一致 | 云端建子票则记账分裂 |

## 2. S1 — BackendPort + gh-issues 后端(核心契约,正确性敏感)

### 接口(新文件 `src/harness/pathfinder/backend.ts`)

```ts
/** 操作级后端端口。PathMap/Ticket 类型不改 —— frontier/slice-compiler/dispatch 零改动。 */
export interface PathBackend {
  readonly kind: 'md' | 'gh';
  listMaps(cwd: string): Array<{ slug: string; destination: string }>;
  readMap(cwd: string, slug: string): PathMap | null;
  createMap(cwd: string, destination: string, slug: string): PathMap;
  addTicket(cwd: string, slug: string, t: NewTicket): Ticket;   // NewTicket 含 type/title/body/blockedBy/parentId?
  rule(cwd: string, slug: string, ticketId: string, ruling: string): void;
  markDelivered(cwd: string, slug: string, ticketIds: string[]): void;
}
export function resolveBackend(cwd: string): PathBackend;
// 解析序:env OMD_PATH_BACKEND 显式覆盖 > 仓库配置 .omd/pathfinder/config.json {"backend":"gh"|"md"} > 默认 'md'(现状不破坏)。
// 配置声明 gh 但探测失败(无 gh / 未认证 / 无 remote)→ throw 带修复命令的错误(D-E fail-loud)。
```

- **md 后端** = 现有 loadMap/mutateMap/saveMap 打包适配,行为一字不变(既有 regressions 测试为证)。
- **MCP 工具层改造**:`src/mcp/tools/pathfinder.ts` 全部经 `resolveBackend(cwd)` 走接口;工具内不得出现 `if (backend.kind === ...)`(D-A)。dispatch 在途标记 / 预算计数不动(D-J,仍读写 `.omd/pathfinder/results/`)。

### gh 映射(read 方向拼装 PathMap,write 方向语义操作)

| PathMap 概念 | GitHub 形态 |
|---|---|
| 地图 | issue,title `🧭 [map] <destination>`,label `path:map`,body = Destination + Fog + Decisions so far |
| 票 | issue,title `[<type>] <title>`,label `path:<type>`(research/grill/prototype/task);map 的 sub-issue;children 挂母票 sub-issue |
| ruling | resolution 评论,首行约定 `**ruling**: <text>` + close issue |
| delivered | closed + label `path:delivered` |
| blockedBy | GitHub 原生 issue dependencies(GraphQL);API 不可用时的**唯一** fallback = body 尾行 `Blocked-by: #N, #M` 约定(单真相,不混用) |
| research 结果 | bot 评论 + label `research-done`(S3 消费) |

- 全部 gh 调用经注入的 `GhRunner`(`(args: string[]) => {stdout, exitCode}`),默认 `Bun.spawnSync('gh', ...)`;**测试注入 fixture,永不真调 gh**(dispatch.ts 同款 idiom:纯决策 + 注入副作用)。
- sub-issue 挂接:`gh api graphql` `addSubIssue` mutation。
- readMap 每次实时拼(`gh issue list --label ... --json number,title,labels,state` + 逐票视需 `gh issue view`);不做缓存层(path_tickets 本身就是显式刷新语义)。

### S1 验收

- `bun test src/harness/pathfinder/` 全绿(含新 backend 测试:gh 拼装 / 操作 emission / 解析序 / fail-loud);`bunx tsc --noEmit` 干净;既有 md 行为回归零变化。

## 3. S2 — reusable workflow + gh-label 派发

- `.github/workflows/dag-research.yml`:`on: workflow_call` + 本仓 `on: issues: [labeled]`(label = `path:research`);job 级 `if: github.actor == <owner>`;steps = checkout(oh-my-dag@v1)→ bun install → `bun run scripts/dag-research.ts "<issue title+body>" --out result.md`(env 从 secrets)→ `gh issue comment --body-file` + `gh issue edit --add-label research-done`。失败也要评论(fail-loud:`⚠ research failed, run <url>`)。
- caller 模板(init 用,~15 行):`uses: AbyssCN/oh-my-dag/.github/workflows/dag-research.yml@v1` + `secrets: inherit`。
- `dispatch.ts` deps 增加 gh-label 派发实现:gh 后端时"派发 research" = 确保 label 已打(幂等);`.dispatched` 标记照写(D-J 预算)。

## 4. S3 — 回流折入

- **PathBackend 扩两个方法**(两后端对称,回流编排则后端无关):
  ```ts
  collectResearchResults(cwd, slug): Array<{ ticketId: string; body: string }>;  // md: 读 .omd/pathfinder/results/ 落盘文件; gh: research-done 票的 bot 评论
  ackResearchResult(cwd, slug, ticketId): void;  // md: 既有已折入标记语义; gh: 摘 research-done label(幂等锚点)
  ```
- 折入编排(distill + `## children` 解析 + 状态翻转)留在 afk-hook,后端无关;children 经 `backend.addTicket` 建(挂母票,blockedBy=母票)。md 行为等价由既有回归测试保证。
- 解析失败 / 评论缺失 → 票标注警告,不静默跳过。
- **S3 验收补记**:① 空结果统一「警告不折入」(md 旧占位 ruling 行为废除——不造假裁决);② 子票 id 由各后端自然分配,血缘只靠 parentId/children,id 无契约绑定;③ **已知接缝**:TUI 的 `watchAfkResults`(md 专属 4s 轮询)与 MCP 的 `reflowResearchResults`(后端无关)双折入路径并存——语义变更须两处同步,收敛计划留 S5 后评估。

## 5. S4 — path init 向导(MCP 工具 `path_map` 增 `init` 动作)

探测梯(全自动):git repo?→ GitHub remote?→ `gh auth status` + scope(repo/workflow)?→ repo public/private?→ Actions 可用?→ 机器级 key(`~/.omd`/env)?
问答(最多两问):① 后端 gh/md(无 remote 不问,直接 md);② 云端 AFK 开否(public 仓库须明示「决策历史公开可读」)。
生成:labels(`path:*` 全套)→ map issue → caller yaml → `gh secret set -R <repo>`(从本机 env 复制 omd-actions keyset,不新造 provider key)→ **workflow_dispatch 干跑 canary**(D-I)→ `.omd/pathfinder/config.json` 落后端选择。
缺什么报什么 + 修复命令(如 `gh auth refresh -s workflow`),不含糊报错。
金丝雀顺带探测**原生 issue-dependencies API 可用性**并记入仓库配置(D-C.1 切换真相源的依据)。

## 6. S5(P1)— memory 接线 + 文档

- `path_rule` 成功后将「决策 + why」写 `memory_remember`(fact 型);**验收 = 消费端真检索到**(/start Step 2.5 或 memory_recall 能召回该 fact),否则不算闭环。
- 更新 client-skills:omd-path(init 流程)/ omd-tickets(gh 折入)/ omd-rule(resolution 评论语义)/ omd-deliver(不变,强调闸不上云)。
- 本文件即 ADR;交付后把 D-A..D-J 摘要进 commit message。

## 7. 全局验收

- 双后端同一套 MCP 工具面语义等价(md 用户零感知变化)。
- 真实链路演习:oh-my-dag 自身开一张真图(destination = 本 SDD 主题),走 add→label→Actions→评论→折入→rule→close 全链。
- 执行体纪律:禁 defer 禁擅断;判不动标 `?` 附倾向上报;桩/TODO 不得静默留下。

## 8. 交付状态(S1–S5 全片验收后追记)

### 各片 oracle 终值(2026-07-22 S5 收尾一次全跑)

- `bunx tsc --noEmit` — 干净(零错)。
- `bun test src/harness/pathfinder/` — **119 pass / 0 fail**(10 文件):backend/backend-gh(S1)、workflow-yaml(S2)、afk-hook(S3)、init(S4)、frontier/map-store/slice-compiler/dispatch/types/regressions(全片共用,md 行为零回归)。
- `bun test src/mcp src/harness` — **347 pass / 0 fail**(35 文件):含 S5 新增 3 例(pathfinder.test.ts:裁决写 memory 形状断言 / 真 OmdMemory 往返 recall / writeFact 故障不阻断)。S5 前基线 344。
- S5 闭环等级:**真往返**已达。裁决经注入的真 `OmdMemory`(`:memory:` + UNIVERSAL_SAFEGUARD,含 `omd.pattern`)写入 → `memory.retrieve('<destination> 关键词')` 真检索到该 ruling fact,非仅形状断言(default zero-dep embedder + FTS5 进程内可跑,无需外部 embedding provider)。

### memory 接线形状(S5-A)

- `path_rule` 成功后把「`<destination>: <title>` 裁决 = `<ruling>`」记为 `omd.pattern` fact(`situation`=问题,`approach`=ruling,`outcome`='worked'),经 `OmdMemory.writeFact(fact, {scanSecrets:false})` —— `memory_remember` 同款底层 + 同款用户主权绕密钥闸,**不绕道 MCP 工具面自调**。接缝 = `PathfinderToolDeps.memory`(assemble 注入同款 `OmdMemory` 实例;测试注入替身)。写失败/被拒 **warn 不 throw**:裁决已落 Issues/md,memory 是增益不是链路。
- `?` 岔口(倾向已择,非 ship-blocker):`omd.pattern` 是 UNIVERSAL_SAFEGUARD 里对「裁决」语义最贴的现有 namespace,但 `outcome` 字段强制 `worked|failed`;裁决=owner 拍板采纳的走法,取 `worked`(决定态即"采用")。若日后要区分"采纳后被推翻",需扩 namespace 或加 decision 专属 facet —— 当前不做(YAGNI)。

### 已知接缝(收敛留观测)

- **TUI/MCP 双折入 — 已收敛**(2026-07-22,票 #17 grill → #18 delivered):TUI 轮询降为薄触发器,折入统一 `reflowResearchResults`(md 后端固定);生产消费单引擎。**残留**:`applyAfkResult`/`watchAfkResults` 原地保留——regressions 硬验收(断言一字不改)直接绑定二者,物理删除需重写 reg4/reg5 驱动方式(语义断言不变),属低优先 owner 闸,不阻塞;生产零消费已验证(仅注释提及)。
- **memory 写入是单向增益**:裁决不因 memory 故障回滚,memory 也不反向驱动裁决;消费端(`memory_recall` / 会话开场)自取。

### §7 真 gh 演习(2026-07-22 已完成 · AbyssCN/oh-my-dag)

全链真跑通:`path_init`(labels + map issue **#15** + secrets 保留 + 金丝雀 success 真贴评论 + 原生依赖探测=**可用**)→ `addTicket` 建 **#16**(sub-issue 挂 #15)→ label 触发云端真研究(deepseek flash/pro,~$0.5/次)→ 锚点评论落票 → `reflowResearchResults` 折入 → #16 ruled+CLOSED+resolution 评论+ack。权力闸实战验证:`path:map` label 触发的 run 被正确 skipped。

**演习揪出并修复 5 个「金丝雀绿而真链路暗坏」缺陷**(全部 commit 在 main):
1. init secrets 无条件覆写 → 改「确保有」跳过已存在(保 omd-actions keyset);
2. init 报告谎称「已 set」→ 如实区分 set/kept;
3. 评论贴 `--out` 全档 → cat 几 MB 噎死日志管道 + 必撞 GitHub 评论 65536 上限 → 改贴 stdout 终稿 + 60000 截断护栏;
4. pino-pretty transport 在 worker 线程绕开 `setLoggerDestination` 直灌 stdout(CI 未设 NODE_ENV 即中)→ transport destination 钉死 stderr + script-bootstrap 统一改道;
5. stdout 裸终稿缺 `## 终稿` 锚点、金丝雀假结果反而带 → workflow 真研究分支统一前置锚点。

已知 polish(非阻断):distill 首段作 ruling 会取到 LLM 开场白(「好的。作为首席架构师…」)——全文仍在结果评论里,裁决语义无损;后续可在 distill 加开场白剥离。auto-fold 的 ruling 经 backend.rule 直写,不走 path_rule → **不写 memory**(语义正确:memory 记 owner 决策,不记自动蒸馏)。

### D-C.2 — blockedBy 真相源单向切换(owner 2026-07-22 明令,执行契约)

对真仓库**实证过**的三个操作面(非文档转述):
- 读(单查合并):GraphQL Issue 字段 `blockedBy(first:N){nodes{number}}` 实测可用 → 并进现有 READ_MAP_QUERY,readMap 仍一次抓齐。
- 写:REST `POST /repos/{o}/{r}/issues/{n}/dependencies/blocked_by`,体 `{"issue_id": <blocking 票的 databaseId>}`(databaseId 经 `gh api repos/{o}/{r}/issues/{m} --jq .id` 取);实测 POST/GET/DELETE 全通。
- 一律经 `gh api` shell-out(D-B),不依赖 gh CLI ≥2.94 的 `--add-blocked-by` 旗标(版本无关)。

切换纪律:
- **门 = `.omd/pathfinder/config.json` `capabilities.nativeDependencies`**(init 金丝雀探测写入):true → 原生策略(读 GraphQL 字段/写 REST,**完全不读不写 body 尾行**);false(老 GHE)→ 遗留 body-line 策略。每仓恰一真相,永不混用(D-C.1)。
- 旧数据零迁移(D-H;演习图无 body-line 存量)。
- `@v1` tag 已发布(指向含全部演习修复的 commit)。
