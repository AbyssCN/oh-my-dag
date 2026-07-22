# SDD — DAG-native review:runReview 上 executor-dag(find 拿代码库访问 + verify map)

> 承接会话:omd-review 深度评估 → 升级共享承重件 runReview。执行契约。
> 日期 2026-07-22。状态:APPROVED(owner 令"写 SDD 然后执行")。

## 0. 一句话

把 `runReview` 的内核从 diff-盲的 `Promise.all` 升成 executor-dag:**find 变 agent 叶能读代码库**(从源头掐掉"X 在 diff 外"整类误报)+ **verify 用 `map` over findings**(每 finding 一个 agent skeptic 全工具取证)。**契约冻结 + 默认 off 灰度**,两调用方(/omd-review、dag-build)无感继承。

## 1. 动机(为什么值得动承重件)

- `runReview` 被 **两处共用**:`scripts/dag-review.ts`(手动审)+ `scripts/dag-build.ts:347`(fleet 建码绿后自动门控)。改深度 = 抬升"手动审"+"fleet 产码质量门"两条线,leverage 2×。
- 现实现深度天花板(实测:我经常驳 finding):① find 层**只喂 diff**,对 diff 外代码的主张无从查证 → 量产"X 未定义其实在 diff 外"/"缺守卫其实在 JOIN 里"整类误报;② verify 的 `gatherEvidence` 是 ±30 行窄确定性窗,判不动 → fail-open→CONFIRMED → 落人工。
- 跨模型 mimo verify(已配 .env)补 verify 侧;本 SDD 补 **find 侧代码库访问** + **verify 深度(agent map)**。

## 2. 铁律:契约冻结(REVIEW-1)

`runReviewDag(opts: RunReviewOpts): Promise<RunReviewResult>` **返回型与 `runReview` 完全一致**:
```
RunReviewResult { findings: ReviewFinding[]; verified?: VerifiedFinding[]; outPath; model; sddPath?; specSkipped? }
```
两调用方消费点(dag-review 取 findings/verified/outPath/sddPath/specSkipped;dag-build 取 findings/outPath)**一字不改**。灰度期 Promise.all 老路径原样保留。

## 3. 灰度 opt-in(REVIEW-2)

`runReview` 顶部分流:`if (opts.dag ?? env.OMD_REVIEW_DAG === '1') return runReviewDag(opts)`。
- **默认 off** → 老 Promise.all 不动,dag-build 零风险。
- `/omd-review` 加 `--dag` flag(dag-review.ts 传 `dag:true`)先灰度、measure S/N。
- 证明后:翻默认 / 或 dag-build 显式开。**不证明不切承重的 fleet 路径。**

## 4. 架构:compileReviewPlan(镜像已交付的 compileDebugPlan)

```
find_correctness ┐
find_security    ├─ 并行 sibling agent 叶(codegraph/read 读代码库)
find_boundary    ┤   goal = buildReviewPrompt(dim) + diff + 自证伪纪律(先查 diff 外真身再报)
find_contract    ┘   ← #3:find 拿代码库访问,源头掐 diff-盲误报
find_spec (G3)   ──   agent + SDD 注入(buildSpecReviewPrompt);无 SDD → 节点跳过
      ↓ 全部 feed
verify (map over findings)
  lister:  extractFindings 结构化 → {findings:[{id,severity,file,line,claim,symbols,dimension}]}
  template: agent skeptic per finding — 全工具取证(codegraph 调用链/impact + read)+ refute-first 裁决
  keyBy:   id (= findingKey: file+claim 前缀 hash;跨 lens 撞同一 bug 折叠 + resume 稳定)
  maxItems: 有界(默认 24)
      ↓
judge (leaf): findingKey 去重 + 严重度排序 + CONFIRMED-only 出口
```
收口 `PlanSchema.parse`。find_spec / verify 子是**只读**:goal 避 producesFiles 强写信号(回归守卫同 deepen/debug)。

## 5. 结果映射(REVIEW-3,DAG LeafResult → 冻结契约)

| 契约字段 | 来源 |
|---|---|
| `findings: ReviewFinding[]` | 每 `find_<dim>` 节点 output → `{dimension, text, ...screenFinding(text)}` |
| `verified: VerifiedFinding[]` | verify map 子:lister 的 ExtractedFinding(severity/file/line/claim/symbols/dimension)⋈ 子 VERDICT/reason |
| `outPath` | judge 输出 + 两轴分段组装落盘(同 run.ts 报告格式) |
| `sddPath`/`specSkipped` | find_spec 节点存在性 + SDD 定位结果 |
| `model` | findModel 坐标 |

## 6. 复用(不重写校准资产)

- find goal:`buildReviewPrompt` / `buildSpecReviewPrompt` 原样(+ 一段"你可读代码库,先自证伪再报,禁推测性 P0")。
- verify:`extractFindings`(lister 结构化逻辑)+ verifyOne 的 refute-first checklist(子 goal)+ `findingKey`(去重)。
- `screenFinding`(slop 软筛)、`DIMS_BY_GATE`、`ROUND_CAPS` 不变。
- 执行:`runExecutorDagWithPlan` + `createAgentLeafRunner`(agent 叶带工具),同 dag-deepen/dag-debug。

## 7. 反 happy-path 约束

1. **契约冻结**:runReviewDag 返回型 = runReview,消费方无改(REVIEW-1)。
2. **默认 off**:未证明前 fleet 路径走老实现,不炸 dag-build(REVIEW-2)。
3. **只读**:find/verify 全 agent 叶只读代码库,不写盘;提修仅文本(同现 review)。
4. **有界**:verify map maxItems + ROUND_CAPS 1 轮,防扇出膨胀。
5. **降级**:agent 叶符号→codegraph/文本→ugrep 双路(agent-leaf 原生),codegraph 缺不硬依赖。

## 8. 交付 + 测试

| 文件 | 内容 |
|---|---|
| `src/harness/review/review-plan.ts` | compileReviewPlan(find/verify-map/judge)+ JUDGE/VERIFY 节点 id |
| `src/harness/review/run-dag.ts` | runReviewDag(executor-dag → RunReviewResult 映射) |
| `src/harness/review/run.ts` | 顶部 opts.dag/OMD_REVIEW_DAG 分流(≤5 行) |
| `scripts/dag-review.ts` | `--dag` flag → dag:true(灰度入口) |
| 测试 | `review-plan.test.ts`(plan shape + find 只读守卫 + verify map spec)· `run-dag.test.ts`(注入 fake _runDag → 验契约映射) |

`tsc --noEmit && bun test`(review 相关)全绿才 commit。review 模块独立,不碰 registry 在途工作。

## 9. Phase 边界

- **本 SDD(Phase 1)**:全 DAG-native path(find agent + verify map + judge),灰度 opt-in,契约冻结。
- **非目标**:不翻默认(measure 后另议);不改 Promise.all 老路径;不动 dag-build 的门控逻辑(它自动继承分流)。
